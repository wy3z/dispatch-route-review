import type { AppUser } from "../contracts";
import { appendAuditEvent } from "./audit";
import type { AuditContext } from "./audit";
import { withTransaction } from "../../../platform/database";
import { pagePermissionCatalog, serialisePagePermissions } from "../permission-catalog";
import type { PagePermissionKey } from "../permission-catalog";

export async function updateUserPagePermission(
  userId: string,
  permissionKey: PagePermissionKey,
  granted: boolean,
  actor: AppUser,
  context: AuditContext,
) {
  return await withTransaction(async (client) => {
    const target = await client.query<{ email: string; }>(
      `SELECT email FROM app_users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!target.rows[0]) return null;
    const current = await client.query<{ granted: boolean; }>(
      `SELECT granted FROM app_user_permissions
            WHERE user_id = $1 AND permission_key = $2 FOR UPDATE`,
      [userId, permissionKey],
    );
    const beforeGranted = current.rows[0]?.granted ?? false;
    await client.query(
      `INSERT INTO app_user_permissions
             (user_id, permission_key, granted, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (user_id, permission_key) DO UPDATE SET
             granted = EXCLUDED.granted,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [userId, permissionKey, granted, actor.id],
    );
    if (beforeGranted !== granted) {
      await appendAuditEvent(client, actor, context, {
        action: "page.permission.updated",
        entityType: "app_user_page_permission",
        entityId: `${userId}:${permissionKey}`,
        beforeState: { granted: beforeGranted },
        afterState: { granted },
        metadata: {
          permissionLabel: pagePermissionCatalog[permissionKey].label,
          targetUserId: userId,
          targetEmail: target.rows[0].email,
        },
      });
    }
    const result = await client.query<{
      permission_key: PagePermissionKey;
      granted: boolean;
    }>(
      `SELECT permission_key, granted FROM app_user_permissions
            WHERE user_id = $1 ORDER BY permission_key`,
      [userId],
    );
    return serialisePagePermissions(result.rows);
  });
}
