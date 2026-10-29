import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";
import { trustedIdentityFromHeaders } from "../modules/access/domain";
import {
  authenticateRequest,
  AuthenticationError,
} from "../modules/access/server/auth";

const canonicalHeaders = {
  "x-auth-request-user": "entra:identity-contract",
  "x-auth-request-email": "User@Example.test",
  "x-auth-request-preferred-username": "Identity User",
};

async function withForwardAuth<T>(run: () => Promise<T>) {
  const previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "forward-auth";
  try {
    return await run();
  } finally {
    if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousAuthMode;
  }
}

function request(headers: HeadersInit) {
  return new Request("https://planner.example.test/api/me", { headers });
}

test("canonical ForwardAuth identity tuple is accepted", async () => {
  await withForwardAuth(async () => {
    assert.deepEqual(trustedIdentityFromHeaders(new Headers(canonicalHeaders)), {
      subject: "entra:identity-contract",
      email: "user@example.test",
      displayName: "Identity User",
    });
    assert.equal(
      proxy(new NextRequest("https://planner.example.test/dispatch", {
        headers: canonicalHeaders,
      })).status,
      200,
    );
  });
});

test("fallback, mixed, partial, and conflicting identity tuples are rejected", async () => {
  await withForwardAuth(async () => {
    const cases: Array<[string, HeadersInit]> = [
      [
        "fallback-only",
        {
          "x-forwarded-user": "entra:identity-contract",
          "x-forwarded-email": "user@example.test",
          "x-forwarded-preferred-username": "Identity User",
        },
      ],
      [
        "mixed sources",
        {
          "x-auth-request-user": "entra:identity-contract",
          "x-forwarded-email": "user@example.test",
          "x-auth-request-preferred-username": "Identity User",
        },
      ],
      [
        "partial canonical tuple",
        {
          "x-auth-request-user": "entra:identity-contract",
          "x-auth-request-email": "user@example.test",
        },
      ],
      [
        "conflicting legacy value",
        {
          ...canonicalHeaders,
          "x-forwarded-email": "attacker@example.test",
        },
      ],
    ];

    for (const [name, headers] of cases) {
      assert.equal(trustedIdentityFromHeaders(new Headers(headers)), null, name);
      assert.equal(
        proxy(new NextRequest("https://planner.example.test/dispatch", { headers })).status,
        401,
        name,
      );
      await assert.rejects(
        authenticateRequest(request(headers)),
        (error: unknown) =>
          error instanceof AuthenticationError && error.status === 401,
        name,
      );
    }
  });
});

test("only the fixed Entra logout handoff bypasses identity", async () => {
  await withForwardAuth(async () => {
    assert.equal(
      proxy(new NextRequest("https://planner.example.test/logout/entra")).status,
      200,
    );
    assert.equal(
      proxy(new NextRequest("https://planner.example.test/logout/entra/extra")).status,
      401,
    );
  });
});
