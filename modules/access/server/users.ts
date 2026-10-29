import type { AppUser, UserRole, ManagedUser } from "../contracts";
import { appendAuditEvent } from "./audit";
import type { AuditContext } from "./audit";
import { AuthenticationError } from "./auth";
import { query, withTransaction } from "../../../platform/database";

export type UserRow = {
  id: string;
  external_subject: string;
  email: string;
  display_name: string;
  role: UserRole;
  active: boolean;
  created_at: Date;
  last_seen_at: Date;
};

export function serialiseUser(row: UserRow): ManagedUser {
  return {
    id: row.id,
    externalSubject: row.external_subject,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
  };
}
export async function listUsers() {
  const result = await query<UserRow>(
    `SELECT id, external_subject, email, display_name, role, active,
              created_at, last_seen_at
         FROM app_users
        ORDER BY active DESC, display_name, email`,
  );
  return result.rows.map(serialiseUser);
}

export async function updateUserAccess(
  userId: string,
  role: UserRole | null,
  active: boolean | null,
  actor: AppUser,
  context: AuditContext,
) {
  return await withTransaction(async (client) => {
    // Lock the whole admin set so two demotions cannot remove the last pair.
    const activeAdmins = await client.query<{ id: string; }>(
      `SELECT id FROM app_users
          WHERE role = 'admin' AND active = true
          ORDER BY id FOR UPDATE`,
    );
    const current = await client.query<UserRow>(
      `SELECT id, external_subject, email, display_name, role, active,
                created_at, last_seen_at
           FROM app_users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const before = current.rows[0];
    if (!before) return null;
    const nextRole = role ?? before.role;
    const nextActive = active ?? before.active;
    if (before.role === "admin" && before.active && (nextRole !== "admin" || !nextActive)) {
      if (activeAdmins.rows.length <= 1) {
        throw new AuthenticationError(
          "The final active administrator cannot be demoted or disabled.",
          409,
        );
      }
    }
    const result = await client.query<UserRow>(
      `UPDATE app_users
            SET role = $2, active = $3, updated_at = now()
          WHERE id = $1
          RETURNING id, external_subject, email, display_name, role, active,
                    created_at, last_seen_at`,
      [userId, nextRole, nextActive],
    );
    const after = result.rows[0];
    await appendAuditEvent(client, actor, context, {
      action: "user.access.updated",
      entityType: "app_user",
      entityId: userId,
      beforeState: { role: before.role, active: before.active },
      afterState: { role: after.role, active: after.active },
      metadata: { targetEmail: after.email },
    });
    return serialiseUser(after);
  });
}
