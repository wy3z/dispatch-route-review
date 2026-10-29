import assert from "node:assert/strict";
import test from "node:test";
import {
  isPagePermissionKey,
  pagePermissionCatalog,
  serialisePagePermissions,
} from "../modules/access/permission-catalog";
import {
  authenticateAndRequirePagePermission,
  developmentPageUser,
  hasPagePermission,
  requirePagePermission,
} from "../modules/access/server/page-permissions";
import { AuthenticationError } from "../modules/access/server/auth";
import type { AppUser } from "../modules/access/contracts";

const viewer: AppUser = {
  id: "00000000-0000-4000-8000-000000000001",
  externalSubject: "entra:viewer",
  email: "viewer@example.test",
  displayName: "Viewer",
  role: "viewer",
  active: true,
};
const admin: AppUser = { ...viewer, role: "admin" };

test("page permissions separate Dispatch Review from engineer management", () => {
  assert.deepEqual(Object.keys(pagePermissionCatalog), [
    "dispatch_review",
    "engineer_management",
  ]);
  assert.equal(pagePermissionCatalog.dispatch_review.path, "/");
  assert.equal(pagePermissionCatalog.engineer_management.path, "/engineers");
  assert.equal(isPagePermissionKey("dispatch_review"), true);
  assert.equal(isPagePermissionKey("engineer_management"), true);
  assert.equal(isPagePermissionKey("audit"), false);
  assert.equal(isPagePermissionKey("dispatch"), false);
});

test("missing permission rows deny instead of using a visible default", () => {
  assert.deepEqual(serialisePagePermissions([]), [
    {
      key: "dispatch_review",
      label: "Dispatch Review",
      path: "/",
      granted: false,
    },
    {
      key: "engineer_management",
      label: "Engineer management",
      path: "/engineers",
      granted: false,
    },
  ]);
});

test("stored permission grants are serialised explicitly", () => {
  assert.equal(
    serialisePagePermissions([
      { permission_key: "dispatch_review", granted: true },
    ])[0].granted,
    true,
  );
});

test("permission evaluation allows only an explicit true grant", async () => {
  assert.equal(
    await hasPagePermission(viewer.id, "dispatch_review", async () => true),
    true,
  );
  assert.equal(
    await hasPagePermission(viewer.id, "dispatch_review", async () => false),
    false,
  );
  assert.equal(
    await hasPagePermission(viewer.id, "dispatch_review", async () => null),
    false,
  );
});

test("administrators do not bypass an explicit page permission denial", async () => {
  await assert.rejects(
    requirePagePermission(admin, "dispatch_review", async () => false),
    (error: unknown) =>
      error instanceof AuthenticationError && error.status === 403,
  );
});

test("permission storage failures fail closed as service unavailable", async () => {
  await assert.rejects(
    hasPagePermission(viewer.id, "dispatch_review", async () => {
      throw new Error("database unavailable");
    }),
    (error: unknown) =>
      error instanceof AuthenticationError && error.status === 503,
  );
});

test("development permission fixtures cannot override forward-auth", async () => {
  const previousAuthMode = process.env.AUTH_MODE;
  const previousPermissions = process.env.DEV_PAGE_PERMISSIONS;
  process.env.AUTH_MODE = "forward-auth";
  process.env.DEV_PAGE_PERMISSIONS = "dispatch_review";
  try {
    assert.equal(developmentPageUser(), null);
    assert.equal(
      await hasPagePermission(viewer.id, "dispatch_review", async () => false),
      false,
    );
  } finally {
    if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousAuthMode;
    if (previousPermissions === undefined) {
      delete process.env.DEV_PAGE_PERMISSIONS;
    } else {
      process.env.DEV_PAGE_PERMISSIONS = previousPermissions;
    }
  }
});

test("forward-auth page gates reject requests without authenticated identity headers", async () => {
  const previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "forward-auth";
  try {
    await assert.rejects(
      authenticateAndRequirePagePermission(
        new Request("https://planner.example.test/api/autotask-schedule"),
        "dispatch_review",
      ),
      (error: unknown) =>
        error instanceof AuthenticationError && error.status === 401,
    );
  } finally {
    if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousAuthMode;
  }
});
