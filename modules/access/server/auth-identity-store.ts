import type { PoolClient } from "pg";
import type { UserRole } from "../contracts";

export const AUTH_IDENTITY_PROVIDER = "entra_oidc_sub" as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AuthIdentityOperation = "stage" | "replace" | "retire";

export type AuthIdentity = {
  id: string;
  providerKey: typeof AUTH_IDENTITY_PROVIDER;
  externalSubject: string;
  isPrimary: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  retiredAt: string | null;
};

export type IdentityRow = {
  id: string;
  user_id: string;
  provider_key: typeof AUTH_IDENTITY_PROVIDER;
  external_subject: string;
  is_primary: boolean;
  created_at: Date;
  last_seen_at: Date | null;
  retired_at: Date | null;
};

export type TargetUserRow = {
  id: string;
  external_subject: string;
  email: string;
  role: UserRole;
  active: boolean;
};

export type AuthIdentityUserState = {
  userId: string;
  role: UserRole;
  active: boolean;
  compatibilityPrimarySubject: string;
  identities: AuthIdentity[];
};

export type AuthIdentityChange = {
  action:
    | "user.identity.staged"
    | "user.identity.replaced"
    | "user.identity.retired";
  targetEmail: string;
  beforeState: AuthIdentityUserState;
  afterState: AuthIdentityUserState;
  metadata: {
    operation: AuthIdentityOperation;
    providerKey: typeof AUTH_IDENTITY_PROVIDER;
    replacementIdentityId?: string;
    retiredIdentityId?: string;
    retainedPrevious?: boolean;
  };
};

export class AuthIdentityChangeError extends Error {
  status: 404 | 409;

  constructor(message: string, status: 404 | 409 = 409) {
    super(message);
    this.status = status;
  }
}

export function isUuid(value: string) {
  return UUID.test(value);
}

export function isExactExternalSubject(value: string) {
  return value.length >= 1 && value.length <= 512 && value === value.trim();
}

export function serialiseIdentity(row: IdentityRow): AuthIdentity {
  return {
    id: row.id,
    providerKey: row.provider_key,
    externalSubject: row.external_subject,
    isPrimary: row.is_primary,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    retiredAt: row.retired_at?.toISOString() ?? null,
  };
}

export function authIdentityUserState(
  user: TargetUserRow,
  identities: IdentityRow[],
): AuthIdentityUserState {
  return {
    userId: user.id,
    role: user.role,
    active: user.active,
    compatibilityPrimarySubject: user.external_subject,
    identities: identities.map(serialiseIdentity),
  };
}

/** Serialize one exact provider/subject ownership decision in the transaction. */
export async function withAuthIdentitySubjectLock<T>(
  client: PoolClient,
  externalSubject: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`auth-identity:${AUTH_IDENTITY_PROVIDER}:${externalSubject}`],
  );
  return run(client);
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

async function lockedIdentities(client: PoolClient, userId: string) {
  return client.query<IdentityRow>(
    `SELECT id, user_id, provider_key, external_subject, is_primary,
            created_at, last_seen_at, retired_at
       FROM auth_identities
      WHERE user_id = $1 AND provider_key = $2
      ORDER BY id
      FOR UPDATE`,
    [userId, AUTH_IDENTITY_PROVIDER],
  );
}

function exactPrimary(user: TargetUserRow, identities: IdentityRow[]) {
  const primary = identities.filter(
    (identity) => identity.is_primary && identity.retired_at === null,
  );
  if (
    primary.length !== 1 ||
    primary[0].external_subject !== user.external_subject
  ) {
    throw new AuthIdentityChangeError(
      "The user's primary identity state has drifted. Repair it offline before retrying.",
    );
  }
  return primary[0];
}

export type ChangeAuthIdentityInput = {
  operation: AuthIdentityOperation;
  userId: string;
  expectedPrimaryIdentityId?: string;
  expectedPrimarySubject?: string;
  replacementSubject?: string;
  identityId?: string;
  retainPrevious?: boolean;
  allowSoleAdministrator?: boolean;
};

/**
 * Change one exact subject mapping. The optional callback runs after the
 * replacement-subject lock and before administrator/user row locks.
 */
export async function changeAuthIdentity(
  client: PoolClient,
  input: ChangeAuthIdentityInput,
  afterSubjectLock?: (client: PoolClient) => Promise<void>,
): Promise<AuthIdentityChange> {
  const replacementSubject =
    input.operation === "retire" ? undefined : input.replacementSubject;
  if (
    input.operation !== "retire" &&
    (!replacementSubject || !isExactExternalSubject(replacementSubject))
  ) {
    throw new AuthIdentityChangeError("A valid exact replacement subject is required.");
  }

  const runChange = async (lockedClient: PoolClient) => {
    await afterSubjectLock?.(lockedClient);
    return changeAuthIdentityUnderLock(lockedClient, input, replacementSubject);
  };
  return replacementSubject
    ? withAuthIdentitySubjectLock(client, replacementSubject, runChange)
    : runChange(client);
}

async function changeAuthIdentityUnderLock(
  client: PoolClient,
  input: ChangeAuthIdentityInput,
  replacementSubject: string | undefined,
): Promise<AuthIdentityChange> {
  const activeAdmins = await client.query<{ id: string }>(
    `SELECT id
       FROM app_users
      WHERE role = 'admin' AND active = true
      ORDER BY id
      FOR UPDATE`,
  );
  const targetResult = await client.query<TargetUserRow>(
    `SELECT id, external_subject, email, role, active
       FROM app_users
      WHERE id = $1
      FOR UPDATE`,
    [input.userId],
  );
  const target = targetResult.rows[0];
  if (!target) throw new AuthIdentityChangeError("User not found.", 404);

  const beforeRows = (await lockedIdentities(client, input.userId)).rows;
  const primary = exactPrimary(target, beforeRows);
  const isSoleActiveAdministrator =
    target.active &&
    target.role === "admin" &&
    activeAdmins.rows.length <= 1;
  if (input.allowSoleAdministrator && !isSoleActiveAdministrator) {
    throw new AuthIdentityChangeError(
      "Offline recovery is restricted to the final active administrator.",
    );
  }
  if (
    !input.allowSoleAdministrator &&
    isSoleActiveAdministrator &&
    input.operation !== "retire"
  ) {
    throw new AuthIdentityChangeError(
      "Staging or replacing the final active administrator's identity requires the offline recovery command.",
    );
  }
  if (
    input.expectedPrimaryIdentityId !== undefined &&
    input.expectedPrimaryIdentityId !== primary.id
  ) {
    throw new AuthIdentityChangeError(
      "The user's primary identity changed before this request. Reload and retry.",
    );
  }
  if (
    input.expectedPrimarySubject !== undefined &&
    input.expectedPrimarySubject !== primary.external_subject
  ) {
    throw new AuthIdentityChangeError(
      "The expected current subject does not match the user's primary identity.",
    );
  }

  const beforeState = authIdentityUserState(target, beforeRows);
  let action: AuthIdentityChange["action"];
  let replacementIdentityId: string | undefined;
  let retiredIdentityId: string | undefined;

  if (input.operation === "retire") {
    const identity = beforeRows.find((candidate) => candidate.id === input.identityId);
    if (!identity) throw new AuthIdentityChangeError("Identity not found.", 404);
    if (identity.is_primary) {
      throw new AuthIdentityChangeError(
        "The primary identity must be replaced before it can be retired.",
      );
    }
    if (identity.retired_at) {
      throw new AuthIdentityChangeError("The identity is already retired.");
    }
    await client.query(
      `UPDATE auth_identities SET retired_at = now() WHERE id = $1`,
      [identity.id],
    );
    action = "user.identity.retired";
    retiredIdentityId = identity.id;
  } else {
    const owned = await client.query<IdentityRow>(
      `SELECT id, user_id, provider_key, external_subject, is_primary,
              created_at, last_seen_at, retired_at
         FROM auth_identities
        WHERE provider_key = $1 AND external_subject = $2
        FOR UPDATE`,
      [AUTH_IDENTITY_PROVIDER, replacementSubject],
    );
    let replacement = owned.rows[0];
    let createdReplacement = false;
    if (replacement && replacement.user_id !== input.userId) {
      throw new AuthIdentityChangeError(
        "That subject is already reserved to another user.",
      );
    }
    if (!replacement) {
      try {
        const inserted = await client.query<IdentityRow>(
          `INSERT INTO auth_identities
             (user_id, provider_key, external_subject, is_primary)
           VALUES ($1, $2, $3, false)
           RETURNING id, user_id, provider_key, external_subject, is_primary,
                     created_at, last_seen_at, retired_at`,
          [input.userId, AUTH_IDENTITY_PROVIDER, replacementSubject],
        );
        replacement = inserted.rows[0];
        createdReplacement = true;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AuthIdentityChangeError(
            "That subject was claimed by another concurrent identity change.",
          );
        }
        throw error;
      }
    }
    replacementIdentityId = replacement.id;

    if (input.operation === "stage") {
      if (
        replacement.is_primary ||
        (!createdReplacement && replacement.retired_at === null)
      ) {
        throw new AuthIdentityChangeError(
          "That subject is already active for this user.",
        );
      }
      if (!createdReplacement) {
        await client.query(
          `UPDATE auth_identities SET retired_at = NULL WHERE id = $1`,
          [replacement.id],
        );
      }
      action = "user.identity.staged";
    } else {
      if (replacement.id === primary.id) {
        throw new AuthIdentityChangeError(
          "The replacement subject is already the primary identity.",
        );
      }
      await client.query(
        `UPDATE auth_identities
            SET is_primary = false,
                retired_at = CASE WHEN $2::boolean THEN NULL ELSE now() END
          WHERE id = $1`,
        [primary.id, input.retainPrevious === true],
      );
      await client.query(
        `UPDATE auth_identities
            SET is_primary = true, retired_at = NULL
          WHERE id = $1`,
        [replacement.id],
      );
      await client.query(
        `UPDATE app_users
            SET external_subject = $2, updated_at = now()
          WHERE id = $1`,
        [input.userId, replacement.external_subject],
      );
      action = "user.identity.replaced";
      retiredIdentityId = input.retainPrevious ? undefined : primary.id;
    }
  }

  const afterUser = (
    await client.query<TargetUserRow>(
      `SELECT id, external_subject, email, role, active
         FROM app_users
        WHERE id = $1`,
      [input.userId],
    )
  ).rows[0];
  const afterRows = (await lockedIdentities(client, input.userId)).rows;
  exactPrimary(afterUser, afterRows);

  return {
    action,
    targetEmail: target.email,
    beforeState,
    afterState: authIdentityUserState(afterUser, afterRows),
    metadata: {
      operation: input.operation,
      providerKey: AUTH_IDENTITY_PROVIDER,
      ...(replacementIdentityId ? { replacementIdentityId } : {}),
      ...(retiredIdentityId ? { retiredIdentityId } : {}),
      ...(input.operation === "replace"
        ? { retainedPrevious: input.retainPrevious === true }
        : {}),
    },
  };
}
