import type { PoolClient } from "pg";
import type { AppUser, UserRole } from "../contracts";
import {
  trustedIdentityFromHeaders,
  type AuthenticatedIdentity,
} from "../identity-headers";
import { query, withTransaction } from "../../../platform/database";
import { resolveAuthMode } from "../auth-mode";
import {
  AUTH_IDENTITY_PROVIDER,
  withAuthIdentitySubjectLock,
} from "./auth-identity-store";

type AppUserRow = {
  id: string;
  external_subject: string;
  email: string;
  display_name: string;
  role: UserRole;
  active: boolean;
};

type LockedAppUserRow = AppUserRow & {
  last_seen_expired: boolean;
};

type IdentityOwnershipRow = {
  id: string;
  user_id: string;
  external_subject: string;
  retired_at: Date | null;
};

type IdentityResolutionRow = {
  identity_id: string | null;
  identity_user_id: string | null;
  identity_external_subject: string | null;
  identity_retired_at: Date | null;
  email_user_id: string | null;
};

const LAST_SEEN_REFRESH_INTERVAL_SECONDS = 15 * 60;
const AUTHENTICATION_RACE_ATTEMPTS = 3;

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export class AuthenticationError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

function identityFromHeaders(headers: Headers): AuthenticatedIdentity {
  const authMode = resolveAuthMode();
  if (authMode === "invalid") {
    throw new AuthenticationError("Authentication is not configured.", 503);
  }
  if (authMode === "development") {
    const email = (process.env.DEV_USER_EMAIL ?? "developer@localhost").toLowerCase();
    return {
      subject: process.env.DEV_USER_SUBJECT ?? `dev:${email}`,
      email,
      displayName: process.env.DEV_USER_NAME ?? "Local developer",
    };
  }

  const identity = trustedIdentityFromHeaders(headers);
  if (!identity) {
    throw new AuthenticationError("Authenticated identity headers are missing.");
  }
  return identity;
}

const authenticatedRequests = new WeakMap<Request, Promise<AppUser>>();

/** Authenticate each request at most once. */
export function authenticateRequest(request: Request): Promise<AppUser> {
  const pending = authenticatedRequests.get(request);
  if (pending) return pending;
  const authentication = authenticateRequestOnce(request);
  authenticatedRequests.set(request, authentication);
  void authentication.catch(() => authenticatedRequests.delete(request));
  return authentication;
}

async function authenticateRequestOnce(request: Request): Promise<AppUser> {
  const identity = identityFromHeaders(request.headers);
  for (let attempt = 0; attempt < AUTHENTICATION_RACE_ATTEMPTS; attempt += 1) {
    const user = await resolveAuthenticatedUser(identity);
    if (user) return user;
  }
  throw new AuthenticationError(
    "Your sign-in could not be completed. Try again shortly.",
    503,
  );
}

async function resolveAuthenticatedUser(
  identity: AuthenticatedIdentity,
): Promise<AppUser | null> {
  const resolution = await resolveIdentityOwnership(identity);
  const resolved = resolution.rows[0];
  if (!resolved) {
    throw new AuthenticationError(
      "Authorization identity state is temporarily unavailable.",
      503,
    );
  }
  if (resolved.identity_id !== null) {
    if (
      resolved.identity_user_id === null ||
      resolved.identity_external_subject === null
    ) {
      throw new AuthenticationError(
        "Authorization identity state is temporarily unavailable.",
        503,
      );
    }
    try {
      return await resolveMappedIdentity(identity, {
        id: resolved.identity_id,
        user_id: resolved.identity_user_id,
        external_subject: resolved.identity_external_subject,
        retired_at: resolved.identity_retired_at,
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }
  if (resolved.email_user_id !== null) {
    throw new AuthenticationError(
      "This email address is already linked to a different identity. Ask an administrator to resolve it.",
      403,
    );
  }

  return provisionUnknownIdentity(identity);
}

function resolveIdentityOwnership(
  identity: AuthenticatedIdentity,
  client?: PoolClient,
) {
  const sql = `SELECT ownership.id AS identity_id,
                      ownership.user_id AS identity_user_id,
                      ownership.external_subject AS identity_external_subject,
                      ownership.retired_at AS identity_retired_at,
                      email_owner.id AS email_user_id
                 FROM (VALUES ($1::text, $2::text, $3::text))
                        AS presented(provider_key, external_subject, email)
                 LEFT JOIN auth_identities AS ownership
                   ON ownership.provider_key = presented.provider_key
                  AND ownership.external_subject = presented.external_subject
                 LEFT JOIN app_users AS email_owner
                   ON lower(email_owner.email) = lower(presented.email)`;
  const values = [AUTH_IDENTITY_PROVIDER, identity.subject, identity.email];
  return client
    ? client.query<IdentityResolutionRow>(sql, values)
    : query<IdentityResolutionRow>(sql, values);
}

async function provisionUnknownIdentity(
  identity: AuthenticatedIdentity,
): Promise<AppUser | null> {
  try {
    return await withTransaction(async (client) =>
      withAuthIdentitySubjectLock(client, identity.subject, async (lockedClient) => {
        const resolution = await resolveIdentityOwnership(identity, lockedClient);
        const resolved = resolution.rows[0];
        if (!resolved) {
          throw new AuthenticationError(
            "Authorization identity state is temporarily unavailable.",
            503,
          );
        }
        if (resolved.identity_id !== null) return null;
        if (resolved.email_user_id !== null) {
          throw new AuthenticationError(
            "This email address is already linked to a different identity. Ask an administrator to resolve it.",
            403,
          );
        }

        const inserted = await lockedClient.query<AppUserRow>(
          `INSERT INTO app_users
             (external_subject, email, display_name)
           VALUES ($1, $2, $3)
           ON CONFLICT (external_subject) DO NOTHING
           RETURNING id, external_subject, email, display_name, role, active`,
          [identity.subject, identity.email, identity.displayName],
        );
        const row = inserted.rows[0];
        if (!row) return null;
        return {
          id: row.id,
          externalSubject: identity.subject,
          email: row.email,
          displayName: row.display_name,
          role: row.role,
          active: row.active,
        };
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

async function resolveMappedIdentity(
  identity: AuthenticatedIdentity,
  ownership: IdentityOwnershipRow,
): Promise<AppUser | null> {
  return withTransaction(async (client) => {
    const userResult = await client.query<LockedAppUserRow>(
      `SELECT id, external_subject, email, display_name, role, active,
              last_seen_at < now() - make_interval(secs => $2::double precision)
                AS last_seen_expired
         FROM app_users
        WHERE id = $1
        FOR UPDATE`,
      [ownership.user_id, LAST_SEEN_REFRESH_INTERVAL_SECONDS],
    );
    const existingUser = userResult.rows[0];
    if (!existingUser) return null;

    const identityResult = await client.query<
      IdentityOwnershipRow & { last_seen_expired: boolean }
    >(
      `SELECT id, user_id, external_subject, retired_at,
              COALESCE(
                last_seen_at < now() - make_interval(secs => $4::double precision),
                true
              ) AS last_seen_expired
         FROM auth_identities
        WHERE id = $1
          AND user_id = $2
          AND provider_key = $3
          AND external_subject = $5
        FOR UPDATE`,
      [
        ownership.id,
        ownership.user_id,
        AUTH_IDENTITY_PROVIDER,
        LAST_SEEN_REFRESH_INTERVAL_SECONDS,
        identity.subject,
      ],
    );
    const matchedIdentity = identityResult.rows[0];
    if (!matchedIdentity) return null;
    if (matchedIdentity.retired_at) {
      throw new AuthenticationError(
        "This sign-in identity has been retired. Ask an administrator to resolve it.",
        403,
      );
    }

    const primary = await client.query<{ id: string; external_subject: string }>(
      `SELECT id, external_subject
         FROM auth_identities
        WHERE user_id = $1
          AND provider_key = $2
          AND is_primary = true
          AND retired_at IS NULL`,
      [existingUser.id, AUTH_IDENTITY_PROVIDER],
    );
    if (
      primary.rowCount !== 1 ||
      primary.rows[0].external_subject !== existingUser.external_subject
    ) {
      throw new AuthenticationError(
        "Authorization identity state is temporarily unavailable.",
        503,
      );
    }
    if (!existingUser.active) {
      throw new AuthenticationError("This user is disabled.", 403);
    }

    const emailOwner = await client.query<{ id: string }>(
      `SELECT id
         FROM app_users
        WHERE lower(email) = lower($1) AND id <> $2`,
      [identity.email, existingUser.id],
    );
    if (emailOwner.rows[0]) {
      throw new AuthenticationError(
        "This email address is already linked to a different identity. Ask an administrator to resolve it.",
        403,
      );
    }

    const profileChanged =
      existingUser.email !== identity.email ||
      existingUser.display_name !== identity.displayName;
    let row: AppUserRow = existingUser;
    if (profileChanged || existingUser.last_seen_expired) {
      const updated = await client.query<AppUserRow>(
        `UPDATE app_users
            SET email = $2,
                display_name = $3,
                updated_at = CASE
                  WHEN email IS DISTINCT FROM $2 OR display_name IS DISTINCT FROM $3
                  THEN now()
                  ELSE updated_at
                END,
                last_seen_at = CASE
                  WHEN last_seen_at <
                    now() - make_interval(secs => $4::double precision)
                  THEN now()
                  ELSE last_seen_at
                END
          WHERE id = $1
         RETURNING id, external_subject, email, display_name, role, active`,
        [
          existingUser.id,
          identity.email,
          identity.displayName,
          LAST_SEEN_REFRESH_INTERVAL_SECONDS,
        ],
      );
      row = updated.rows[0];
    }
    if (matchedIdentity.last_seen_expired) {
      await client.query(
        `UPDATE auth_identities SET last_seen_at = now() WHERE id = $1`,
        [matchedIdentity.id],
      );
    }
    return {
      id: row.id,
      externalSubject: matchedIdentity.external_subject,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      active: row.active,
    };
  });
}

export function requireRole(user: AppUser, roles: UserRole[]) {
  if (!roles.includes(user.role)) {
    throw new AuthenticationError("You do not have permission for this action.", 403);
  }
}

/** Revalidate the current session identity under row locks. */
export async function lockCurrentAuthenticatedActor(
  client: PoolClient,
  actor: AppUser,
) {
  const user = await client.query<{ role: UserRole; active: boolean }>(
    `SELECT role, active
       FROM app_users
      WHERE id = $1
      FOR UPDATE`,
    [actor.id],
  );
  const current = user.rows[0];
  if (!current?.active) {
    throw new AuthenticationError(
      "Your authorization changed before this action completed. Sign in again.",
      403,
    );
  }
  const identity = await client.query<{ id: string }>(
    `SELECT id
       FROM auth_identities
      WHERE user_id = $1
        AND provider_key = $2
        AND external_subject = $3
        AND retired_at IS NULL
      FOR UPDATE`,
    [actor.id, AUTH_IDENTITY_PROVIDER, actor.externalSubject],
  );
  if (identity.rowCount !== 1) {
    throw new AuthenticationError(
      "Your authorization changed before this action completed. Sign in again.",
      403,
    );
  }
  return current;
}

/** Lock the active-admin set before an administrative identity mutation. */
export async function lockAndRequireCurrentAdministrator(
  client: PoolClient,
  actor: AppUser,
) {
  const activeAdmins = await client.query<{ id: string }>(
    `SELECT id
       FROM app_users
      WHERE role = 'admin' AND active = true
      ORDER BY id
      FOR UPDATE`,
  );
  if (!activeAdmins.rows.some((administrator) => administrator.id === actor.id)) {
    throw new AuthenticationError(
      "Your administrator access changed before this action completed. Sign in again.",
      403,
    );
  }
  const current = await lockCurrentAuthenticatedActor(client, actor);
  if (current.role !== "admin") {
    throw new AuthenticationError(
      "Your administrator access changed before this action completed. Sign in again.",
      403,
    );
  }
  return activeAdmins.rows;
}

/** Reject explicit cross-origin mutations. Missing Origin is allowed for tooling. */
export function requireSameOriginForMutation(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) {
    if (request.headers.get("sec-fetch-site") === "cross-site") {
      throw new AuthenticationError("Cross-site requests are not permitted.", 403);
    }
    return;
  }

  const requestUrl = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const expectedOrigin = process.env.PUBLIC_ORIGIN?.trim() ||
    `${forwardedProto ?? requestUrl.protocol.replace(":", "")}://${forwardedHost ?? requestUrl.host}`;
  let suppliedOrigin: string;
  try {
    suppliedOrigin = new URL(origin).origin;
  } catch {
    throw new AuthenticationError("Invalid request origin.", 403);
  }
  if (suppliedOrigin !== expectedOrigin) {
    throw new AuthenticationError("Cross-site requests are not permitted.", 403);
  }
}

export function authErrorResponse(error: unknown) {
  if (error instanceof AuthenticationError) {
    return Response.json(
      { message: error.message },
      { status: error.status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  throw error;
}
