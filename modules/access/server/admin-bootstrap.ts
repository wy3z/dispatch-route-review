import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { UserRole } from "../contracts";
import { withTransaction } from "../../../platform/database";

export type AdministratorProvisionMode = "bootstrap" | "break-glass";

type BootstrapStateRow = {
  consumed_at: Date | null;
};

type UserRow = {
  id: string;
  external_subject: string;
  email: string;
  display_name: string;
  role: UserRole;
  active: boolean;
};

async function appendProvisioningAudit(
  client: PoolClient,
  user: UserRow,
  mode: AdministratorProvisionMode,
  beforeRole: UserRole,
) {
  await client.query(
    `INSERT INTO audit_events
       (actor_user_id, actor_subject, actor_email, action, entity_type,
        entity_id, request_id, before_state, after_state, metadata)
     VALUES (NULL, $1, $2, $3, 'app_user', $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)`,
    [
      "system:administrator-provisioning",
      "system@localhost",
      mode === "bootstrap" ? "user.access.bootstrap" : "user.access.break_glass",
      user.id,
      `administrator-provisioning:${randomUUID()}`,
      JSON.stringify({ role: beforeRole, active: user.active }),
      JSON.stringify({ role: "admin", active: user.active }),
      JSON.stringify({
        mode,
        targetEmail: user.email,
        targetExternalSubject: user.external_subject,
      }),
    ],
  );
}

export async function provisionAdministrator(
  externalSubject: string,
  mode: AdministratorProvisionMode = "bootstrap",
) {
  const subject = externalSubject.trim();
  if (!subject) throw new Error("An external subject is required.");

  return await withTransaction(async (client) => {
    const state = await client.query<BootstrapStateRow>(
      `SELECT consumed_at
         FROM administrator_bootstrap
        WHERE singleton = true
        FOR UPDATE`,
    );
    const bootstrap = state.rows[0];
    if (!bootstrap) {
      throw new Error("Administrator bootstrap state is unavailable. Apply migrations first.");
    }

    if (mode === "bootstrap" && bootstrap.consumed_at) {
      throw new Error("Administrator bootstrap has already been consumed.");
    }
    if (mode === "break-glass" && !bootstrap.consumed_at) {
      throw new Error(
        "Break-glass provisioning is unavailable until the initial bootstrap has been consumed.",
      );
    }

    const activeAdmins = await client.query<{ id: string }>(
      `SELECT id
         FROM app_users
        WHERE role = 'admin' AND active = true
        ORDER BY id
        FOR UPDATE`,
    );
    if (activeAdmins.rows.length > 0) {
      const message = mode === "break-glass"
        ? "Break-glass provisioning is allowed only when no active administrator remains."
        : "An active administrator already exists; use normal administrator management.";
      throw new Error(message);
    }

    const targetResult = await client.query<UserRow>(
      `SELECT id, external_subject, email, display_name, role, active
         FROM app_users
        WHERE external_subject = $1
        FOR UPDATE`,
      [subject],
    );
    const target = targetResult.rows[0];
    if (!target) {
      throw new Error(
        "No stored user matches that external subject. The intended user must authenticate once first.",
      );
    }
    if (!target.active) {
      throw new Error("The target user is disabled.");
    }

    const beforeRole = target.role;
    const updated = await client.query<UserRow>(
      `UPDATE app_users
          SET role = 'admin', updated_at = now()
        WHERE id = $1
        RETURNING id, external_subject, email, display_name, role, active`,
      [target.id],
    );
    const administrator = updated.rows[0];

    if (mode === "bootstrap") {
      await client.query(
        `UPDATE administrator_bootstrap
            SET consumed_at = now(), consumed_by = $1
          WHERE singleton = true`,
        [administrator.id],
      );
    }

    await appendProvisioningAudit(client, administrator, mode, beforeRole);
    return administrator;
  });
}
