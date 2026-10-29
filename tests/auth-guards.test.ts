import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthenticationError,
  requireRole,
  requireSameOriginForMutation,
} from "../modules/access/server/auth";
import type { AppUser } from "../modules/access/contracts";
import {
  resolveAuthMode,
  resolveEntraTenantId,
} from "../modules/access/auth-mode";
import { logoutLocation } from "../app/logout/route";
import { entraLogoutLocation } from "../app/logout/entra/route";

const viewer: AppUser = {
  id: "00000000-0000-4000-8000-000000000001",
  externalSubject: "entra:viewer",
  email: "viewer@example.test",
  displayName: "Viewer",
  role: "viewer",
  active: true,
};

test("viewer role cannot perform administrative mutations", () => {
  assert.throws(
    () => requireRole(viewer, ["admin"]),
    (error: unknown) =>
      error instanceof AuthenticationError && error.status === 403,
  );
});

test("production authentication fails closed when AUTH_MODE is absent or invalid", () => {
  assert.equal(resolveAuthMode({ NODE_ENV: "production" }), "invalid");
  assert.equal(
    resolveAuthMode({ NODE_ENV: "production", AUTH_MODE: "developmnt" }),
    "invalid",
  );
  assert.equal(
    resolveAuthMode({ NODE_ENV: "production", AUTH_MODE: "forward-auth" }),
    "forward-auth",
  );
  assert.equal(resolveAuthMode({ NODE_ENV: "development" }), "development");
});

test("Entra tenant validation accepts only a concrete non-zero GUID", () => {
  const tenantId = "11111111-2222-3333-4444-555555555555";
  assert.equal(resolveEntraTenantId({ ENTRA_TENANT_ID: tenantId }), tenantId);
  for (const invalid of [
    undefined,
    "common",
    "organizations",
    "00000000-0000-0000-0000-000000000000",
    "not-a-guid",
  ]) {
    assert.equal(resolveEntraTenantId({ ENTRA_TENANT_ID: invalid }), null);
  }
});

test("logout clears proxy state then uses a fixed tenant-specific Entra handoff", () => {
  const tenantId = "11111111-2222-3333-4444-555555555555";
  const production = {
    NODE_ENV: "production",
    AUTH_MODE: "forward-auth",
    ENTRA_TENANT_ID: tenantId,
  };
  assert.equal(
    logoutLocation(production),
    "/oauth2/sign_out?rd=%2Flogout%2Fentra",
  );
  assert.equal(
    entraLogoutLocation(production),
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout`,
  );
  assert.equal(
    logoutLocation({ NODE_ENV: "production", AUTH_MODE: "forward-auth" }),
    null,
  );
  assert.equal(
    logoutLocation({ NODE_ENV: "development", AUTH_MODE: "development" }),
    "/",
  );
});

test("same-origin administrative mutation is allowed and cross-origin is rejected", () => {
  const request = new Request("https://planner.example.test/api/admin/users", {
    method: "POST",
    headers: { Origin: "https://planner.example.test" },
  });
  assert.doesNotThrow(() => requireSameOriginForMutation(request));

  const crossSite = new Request("https://planner.example.test/api/admin/users", {
    method: "POST",
    headers: { Origin: "https://untrusted.example.test" },
  });
  assert.throws(
    () => requireSameOriginForMutation(crossSite),
    (error: unknown) =>
      error instanceof AuthenticationError && error.status === 403,
  );
});
