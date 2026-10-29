import type { AppUser } from "../contracts";
import { database, query, withTransaction } from "../../../platform/database";
import { appendAuditEvent } from "./audit";
import type { AuditContext } from "./audit";
import { lockAndRequireCurrentAdministrator } from "./auth";
import {
  AUTH_IDENTITY_PROVIDER,
  AuthIdentityChangeError,
  authIdentityUserState,
  changeAuthIdentity,
  isExactExternalSubject,
  isUuid,
  type AuthIdentityOperation,
  type AuthIdentityUserState,
  type ChangeAuthIdentityInput,
  type IdentityRow,
  type TargetUserRow,
} from "./auth-identity-store";

export {
  AUTH_IDENTITY_PROVIDER,
  AuthIdentityChangeError,
  isExactExternalSubject,
  isUuid,
};
export type { AuthIdentityOperation, AuthIdentityUserState };

export async function getUserIdentityState(
  userId: string,
): Promise<AuthIdentityUserState | null> {
  const user = await query<TargetUserRow>(
    `SELECT id, external_subject, email, role, active
       FROM app_users
      WHERE id = $1`,
    [userId],
  );
  const row = user.rows[0];
  if (!row) return null;
  const identities = await query<IdentityRow>(
    `SELECT id, user_id, provider_key, external_subject, is_primary,
            created_at, last_seen_at, retired_at
       FROM auth_identities
      WHERE user_id = $1 AND provider_key = $2
      ORDER BY is_primary DESC, created_at, id`,
    [userId, AUTH_IDENTITY_PROVIDER],
  );
  const primary = identities.rows.filter(
    (identity) => identity.is_primary && identity.retired_at === null,
  );
  if (primary.length !== 1 || primary[0].external_subject !== row.external_subject) {
    throw new AuthIdentityChangeError(
      "The user's primary identity state has drifted. Repair it offline before retrying.",
    );
  }
  return authIdentityUserState(row, identities.rows);
}

export type UpdateUserIdentityInput = {
  operation: AuthIdentityOperation;
  userId: string;
  expectedPrimaryIdentityId: string;
  replacementSubject?: string;
  identityId?: string;
  retainPrevious?: boolean;
  reason: string;
};

export async function updateUserIdentity(
  input: UpdateUserIdentityInput,
  actor: AppUser,
  context: AuditContext,
) {
  return withTransaction(async (client) => {
    const change = await changeAuthIdentity(
      client,
      input,
      async (lockedClient) => {
        await lockAndRequireCurrentAdministrator(lockedClient, actor);
      },
    );
    await appendAuditEvent(client, actor, context, {
      action: change.action,
      entityType: "app_user",
      entityId: input.userId,
      beforeState: change.beforeState,
      afterState: change.afterState,
      metadata: {
        ...change.metadata,
        reason: input.reason,
        targetEmail: change.targetEmail,
      },
    });
    return change.afterState;
  });
}

export type RecoverAdministratorIdentityInput = {
  userId: string;
  expectedCurrentSubject: string;
  replacementSubject: string;
  operator: string;
  reason: string;
  execute: boolean;
};

/** Deliberately offline break-glass path for the final active administrator. */
export async function recoverFinalAdministratorIdentity(
  input: RecoverAdministratorIdentityInput,
) {
  const client = await database().connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const change = await changeAuthIdentity(client, {
      operation: "replace",
      userId: input.userId,
      expectedPrimarySubject: input.expectedCurrentSubject,
      replacementSubject: input.replacementSubject,
      retainPrevious: true,
      allowSoleAdministrator: true,
    } satisfies ChangeAuthIdentityInput);

    if (!input.execute) {
      await client.query("ROLLBACK");
      return { executed: false as const, state: change.afterState };
    }

    await appendAuditEvent(
      client,
      {
        id: null,
        externalSubject: "offline-auth-identity-recovery",
        email: "offline-auth-identity-recovery",
      },
      {
        requestId: `offline:${crypto.randomUUID()}`,
        ipAddress: null,
        userAgent: null,
      },
      {
        action: "user.identity.recovered",
        entityType: "app_user",
        entityId: input.userId,
        beforeState: change.beforeState,
        afterState: change.afterState,
        metadata: {
          ...change.metadata,
          operator: input.operator,
          reason: input.reason,
          recoveryMode: "offline-break-glass",
          retainedPrevious: true,
        },
      },
    );
    await client.query("COMMIT");
    committed = true;
    return { executed: true as const, state: change.afterState };
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
