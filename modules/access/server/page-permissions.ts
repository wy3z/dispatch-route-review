import { AuthenticationError, authenticateRequest } from "./auth";
import type { AppUser } from "../contracts";
import { resolveAuthMode } from "../auth-mode";
import { query } from "../../../platform/database";
import {
  isPagePermissionKey,
  pagePermissionCatalog,
  serialisePagePermissions,
} from "../permission-catalog";
import type { PagePermission, PagePermissionKey } from "../permission-catalog";

export type PagePermissionLookup = (
  userId: string,
  key: PagePermissionKey,
) => Promise<boolean | null>;

/** Dev-only identity for the rendered-HTML smoke test, which has no PostgreSQL. */
export function developmentPageUser(): AppUser | null {
  if (
    resolveAuthMode() !== "development" ||
    process.env.DEV_PAGE_PERMISSIONS === undefined
  ) {
    return null;
  }
  const email = (process.env.DEV_USER_EMAIL ?? "developer@localhost").toLowerCase();
  return {
    id: "00000000-0000-4000-8000-000000000000",
    externalSubject: process.env.DEV_USER_SUBJECT ?? `dev:${email}`,
    email,
    displayName: process.env.DEV_USER_NAME ?? "Local developer",
    role: "viewer",
    active: true,
  };
}

function developmentPermissionOverride(key: PagePermissionKey) {
  if (resolveAuthMode() !== "development") return null;
  const configured = process.env.DEV_PAGE_PERMISSIONS;
  if (configured === undefined) return null;
  const grants = new Set(
    configured
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return grants.has(key);
}

async function lookupStoredPagePermission(
  userId: string,
  key: PagePermissionKey,
) {
  const result = await query<{ granted: boolean }>(
    `SELECT granted
       FROM app_user_permissions
      WHERE user_id = $1 AND permission_key = $2`,
    [userId, key],
  );
  return result.rows[0]?.granted ?? null;
}

export async function hasPagePermission(
  userId: string,
  key: PagePermissionKey,
  lookup: PagePermissionLookup = lookupStoredPagePermission,
) {
  if (!isPagePermissionKey(key)) return false;
  const developmentOverride = developmentPermissionOverride(key);
  if (developmentOverride !== null) return developmentOverride;
  try {
    return (await lookup(userId, key)) === true;
  } catch {
    throw new AuthenticationError(
      "Authorization is temporarily unavailable.",
      503,
    );
  }
}

export async function requirePagePermission(
  user: AppUser,
  key: PagePermissionKey,
  lookup?: PagePermissionLookup,
) {
  if (!(await hasPagePermission(user.id, key, lookup))) {
    throw new AuthenticationError(
      `You do not have permission to access ${pagePermissionCatalog[key].label}.`,
      403,
    );
  }
}

export async function authenticateAndRequirePagePermission(
  request: Request,
  key: PagePermissionKey,
) {
  const user = await authenticateRequest(request);
  await requirePagePermission(user, key);
  return user;
}

export async function listPagePermissions(
  userId: string,
): Promise<PagePermission[]> {
  const result = await query<{
    permission_key: PagePermissionKey;
    granted: boolean;
  }>(
    `SELECT permission_key, granted
       FROM app_user_permissions
      WHERE user_id = $1
      ORDER BY permission_key`,
    [userId],
  );
  return serialisePagePermissions(result.rows);
}
