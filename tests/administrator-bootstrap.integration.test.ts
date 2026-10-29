import assert from "node:assert/strict";
import test from "node:test";
import { isolatedDatabase } from "./support/database";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

function authenticatedRequest(subject: string, email: string) {
  return new Request("https://planner.example.test/api/me", {
    headers: {
      "x-auth-request-user": subject,
      "x-auth-request-email": email,
      "x-auth-request-preferred-username": email,
    },
  });
}

test(
  "stale bootstrap email configuration cannot grant administrator role",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async (t) => {
    const client = await isolatedDatabase(t, {
      environment: {
        AUTH_MODE: "forward-auth",
        BOOTSTRAP_ADMIN_EMAILS: "configured@example.test",
      },
    });
    const { authenticateRequest } = await import("../modules/access/server/auth");

    const user = await authenticateRequest(
      authenticatedRequest("entra:configured-user", "configured@example.test"),
    );
    assert.equal(user.role, "viewer");

    const stored = await client.query<{ role: string }>(
      `SELECT role FROM app_users WHERE external_subject = $1`,
      ["entra:configured-user"],
    );
    assert.equal(stored.rows[0]?.role, "viewer");
  },
);

test(
  "bootstrap is one-time, subject-bound, and audited",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async (t) => {
    const client = await isolatedDatabase(t);
    await client.query(
      `INSERT INTO app_users (external_subject, email, display_name)
       VALUES
         ('entra:first-admin', 'first@example.test', 'First Admin'),
         ('entra:second-user', 'second@example.test', 'Second User')`,
    );
    const { provisionAdministrator } = await import(
      "../modules/access/server/admin-bootstrap"
    );

    await assert.rejects(
      provisionAdministrator("first@example.test"),
      /No stored user matches that external subject/,
    );

    const administrator = await provisionAdministrator("entra:first-admin");
    assert.equal(administrator.role, "admin");

    const state = await client.query<{
      consumed_at: Date | null;
      consumed_by: string | null;
    }>(
      `SELECT consumed_at, consumed_by
         FROM administrator_bootstrap
        WHERE singleton = true`,
    );
    assert.ok(state.rows[0]?.consumed_at);
    assert.equal(state.rows[0]?.consumed_by, administrator.id);

    const audit = await client.query<{
      actor_subject: string;
      action: string;
      entity_id: string;
      before_state: { role: string; active: boolean };
      after_state: { role: string; active: boolean };
      metadata: { mode: string; targetExternalSubject: string };
    }>(
      `SELECT actor_subject, action, entity_id, before_state, after_state, metadata
         FROM audit_events
        WHERE action = 'user.access.bootstrap'`,
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0]?.actor_subject, "system:administrator-provisioning");
    assert.equal(audit.rows[0]?.entity_id, administrator.id);
    assert.deepEqual(audit.rows[0]?.before_state, { role: "viewer", active: true });
    assert.deepEqual(audit.rows[0]?.after_state, { role: "admin", active: true });
    assert.equal(audit.rows[0]?.metadata.mode, "bootstrap");
    assert.equal(
      audit.rows[0]?.metadata.targetExternalSubject,
      "entra:first-admin",
    );

    await client.query(
      `UPDATE app_users SET role = 'viewer' WHERE id = $1`,
      [administrator.id],
    );
    await assert.rejects(
      provisionAdministrator("entra:second-user"),
      /already been consumed/,
    );
    const second = await client.query<{ role: string }>(
      `SELECT role FROM app_users WHERE external_subject = 'entra:second-user'`,
    );
    assert.equal(second.rows[0]?.role, "viewer");
  },
);

test(
  "concurrent bootstrap attempts can create only one administrator",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async (t) => {
    const client = await isolatedDatabase(t);
    await client.query(
      `INSERT INTO app_users (external_subject, email, display_name)
       VALUES
         ('entra:race-one', 'race-one@example.test', 'Race One'),
         ('entra:race-two', 'race-two@example.test', 'Race Two')`,
    );
    const { provisionAdministrator } = await import(
      "../modules/access/server/admin-bootstrap"
    );

    const results = await Promise.allSettled([
      provisionAdministrator("entra:race-one"),
      provisionAdministrator("entra:race-two"),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );

    const administrators = await client.query<{ external_subject: string }>(
      `SELECT external_subject
         FROM app_users
        WHERE role = 'admin' AND active = true`,
    );
    assert.equal(administrators.rowCount, 1);

    const audits = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_events
        WHERE action = 'user.access.bootstrap'`,
    );
    assert.equal(audits.rows[0]?.count, "1");
  },
);

test(
  "break-glass is explicit, audited, and requires administrator lockout",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async (t) => {
    const client = await isolatedDatabase(t);
    await client.query(
      `INSERT INTO app_users (external_subject, email, display_name)
       VALUES
         ('entra:initial-admin', 'initial@example.test', 'Initial Admin'),
         ('entra:recovery-user', 'recovery@example.test', 'Recovery User')`,
    );
    const { provisionAdministrator } = await import(
      "../modules/access/server/admin-bootstrap"
    );

    const initial = await provisionAdministrator("entra:initial-admin");
    await assert.rejects(
      provisionAdministrator("entra:recovery-user", "break-glass"),
      /only when no active administrator remains/,
    );

    await client.query(
      `UPDATE app_users SET active = false WHERE id = $1`,
      [initial.id],
    );
    const recovered = await provisionAdministrator(
      "entra:recovery-user",
      "break-glass",
    );
    assert.equal(recovered.role, "admin");

    const audits = await client.query<{
      action: string;
      metadata: { mode: string };
    }>(
      `SELECT action, metadata
         FROM audit_events
        WHERE action = 'user.access.break_glass'`,
    );
    assert.equal(audits.rowCount, 1);
    assert.equal(audits.rows[0]?.metadata.mode, "break-glass");
  },
);
