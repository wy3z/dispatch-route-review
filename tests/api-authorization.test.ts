import assert from "node:assert/strict";
import test from "node:test";
import { isolatedDatabase } from "./support/database";
import { GET as getSchedule } from "../app/api/autotask-schedule/route";
import {
  GET as getPlanningDemand,
  POST as postPlanningDemand,
} from "../app/api/planning-demand/route";
import { GET as getReadyToBook, POST as postReadyToBook } from "../app/api/ready-to-book/route";
import { POST as postRouteGeometry } from "../app/api/route-geometry/route";
import { POST as postEngineer } from "../app/api/engineers/route";
import { PATCH as patchAdminUser } from "../app/api/admin/users/route";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

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

function request(
  path: string,
  init: RequestInit = {},
) {
  return new Request(`https://planner.example.test${path}`, init);
}

test("Dispatch read APIs reject requests without authenticated identity headers", async () => {
  await withForwardAuth(async () => {
    for (const [name, handler, path] of [
      ["schedule", getSchedule, "/api/autotask-schedule?date=2026-08-20"],
      ["planning demand", getPlanningDemand, "/api/planning-demand"],
      ["ready to book", getReadyToBook, "/api/ready-to-book"],
    ] as const) {
      const response = await handler(
        new Request(`https://planner.example.test${path}`),
      );
      assert.equal(response.status, 401, name);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.match(await response.text(), /identity headers are missing/i);
    }
  });
});

test("route geometry authenticates before parsing a malformed body", async () => {
  await withForwardAuth(async () => {
    const response = await postRouteGeometry(
      new Request("https://planner.example.test/api/route-geometry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{invalid-json",
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.match(await response.text(), /identity headers are missing/i);
  });
});

test(
  "request-level authorization keeps Dispatch, engineer and admin gates intact",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async (t) => {
    const client = await isolatedDatabase(t, {
      migrations: ["001_initial_schema.sql", "019_auth_identities.sql"],
      environment: {
        AUTH_MODE: "development",
        DEV_USER_SUBJECT: "dev:authorization-viewer", DEV_USER_EMAIL: "viewer@example.test",
        DEV_USER_NAME: "Authorization Viewer", DEV_PAGE_PERMISSIONS: "",
      },
    });
    const deniedDispatchRequests = [
      [
        "schedule",
        () => getSchedule(request("/api/autotask-schedule?date=not-a-date")),
      ],
      [
        "planning demand",
        () => postPlanningDemand(request("/api/planning-demand", { method: "POST" })),
      ],
      [
        "ready to book",
        () => postReadyToBook(request("/api/ready-to-book", { method: "POST" })),
      ],
      [
        "route geometry",
        () => postRouteGeometry(request("/api/route-geometry", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{invalid-json",
        })),
      ],
    ] as const;
    for (const [name, run] of deniedDispatchRequests) {
      assert.equal((await run()).status, 403, name);
    }

    process.env.DEV_PAGE_PERMISSIONS = "dispatch_review";
    assert.equal(
      (await getSchedule(request("/api/autotask-schedule?date=not-a-date"))).status,
      400,
    );
    assert.equal(
      (await postPlanningDemand(request("/api/planning-demand", { method: "POST" }))).status,
      405,
    );
    assert.equal(
      (await postReadyToBook(request("/api/ready-to-book", { method: "POST" }))).status,
      405,
    );
    assert.equal(
      (await postRouteGeometry(request("/api/route-geometry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{invalid-json",
      }))).status,
      400,
    );

    process.env.DEV_PAGE_PERMISSIONS = "";
    assert.equal(
      (await postEngineer(request("/api/engineers", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://planner.example.test",
        },
        body: "{}",
      }))).status,
      403,
      "engineer mutation requires engineer_management",
    );

    process.env.DEV_PAGE_PERMISSIONS = "engineer_management";
    assert.equal(
      (await postEngineer(request("/api/engineers", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://untrusted.example.test",
        },
        body: "{}",
      }))).status,
      403,
      "engineer mutation rejects cross-origin requests",
    );
    assert.equal(
      (await postEngineer(request("/api/engineers", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://planner.example.test",
        },
        body: "{}",
      }))).status,
      400,
      "permitted same-origin engineer mutation reaches payload validation",
    );

    process.env.DEV_PAGE_PERMISSIONS = "";
    assert.equal(
      (await patchAdminUser(request("/api/admin/users", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "https://planner.example.test",
        },
        body: "{}",
      }))).status,
      403,
      "viewer cannot perform admin mutation",
    );

    await client.query(
      `INSERT INTO app_users (external_subject, email, display_name, role)
       VALUES ('dev:authorization-admin', 'admin@example.test', 'Authorization Admin', 'admin')`,
    );
    process.env.DEV_USER_SUBJECT = "dev:authorization-admin";
    process.env.DEV_USER_EMAIL = "admin@example.test";
    process.env.DEV_USER_NAME = "Authorization Admin";
    assert.equal(
      (await patchAdminUser(request("/api/admin/users", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "https://untrusted.example.test",
        },
        body: "{}",
      }))).status,
      403,
      "admin mutation rejects cross-origin requests",
    );
    assert.equal(
      (await patchAdminUser(request("/api/admin/users", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "https://planner.example.test",
        },
        body: "{}",
      }))).status,
      400,
      "admin same-origin request reaches payload validation",
    );

  },
);
