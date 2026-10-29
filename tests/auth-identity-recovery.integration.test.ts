import assert from "node:assert/strict";
import test from "node:test";
import { isolatedDatabase } from "./support/database";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

function authenticatedRequest(subject: string, email: string, name: string) {
  return new Request("https://planner.example.test/api/me", {
    headers: {
      "x-auth-request-user": subject,
      "x-auth-request-email": email,
      "x-auth-request-preferred-username": name,
    },
  });
}

test(
  "OIDC identity cutover preserves users, retires old subjects, and supports audited final-admin recovery",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async (t) => {
    const client = await isolatedDatabase(t, {
      environment: { AUTH_MODE: "forward-auth", BOOTSTRAP_ADMIN_EMAILS: "" },
    });
    const seeded = await client.query<{ id: string; external_subject: string }>(
      `INSERT INTO app_users (external_subject, email, display_name, role)
       VALUES
         ('admin-subject', 'admin@example.test', 'Admin', 'admin'),
         ('target-subject-a', 'target@example.test', 'Target', 'scheduler')
       RETURNING id, external_subject`,
    );
    const ids = new Map(seeded.rows.map((row) => [row.external_subject, row.id]));
    const adminId = ids.get("admin-subject");
    const targetId = ids.get("target-subject-a");
    assert.ok(adminId && targetId);

    const { authenticateRequest, AuthenticationError } = await import(
      "../modules/access/server/auth"
    );
    const {
      AuthIdentityChangeError,
      recoverFinalAdministratorIdentity,
      updateUserIdentity,
    } = await import("../modules/access/server/auth-identities");

    const actor = await authenticateRequest(
      authenticatedRequest("admin-subject", "admin@example.test", "Admin"),
    );
    const primary = await client.query<{ id: string }>(
      `SELECT id FROM auth_identities
        WHERE user_id = $1 AND is_primary AND retired_at IS NULL`,
      [targetId],
    );
    const context = { requestId: "identity-test", ipAddress: null, userAgent: null };

    await updateUserIdentity(
      {
        operation: "stage",
        userId: targetId,
        expectedPrimaryIdentityId: primary.rows[0].id,
        replacementSubject: "target-subject-b",
        reason: "Pre-link replacement subject",
      },
      actor,
      context,
    );
    const stagedLogin = await authenticateRequest(
      authenticatedRequest("target-subject-b", "target@example.test", "Target"),
    );
    assert.equal(stagedLogin.id, targetId);
    assert.equal(stagedLogin.role, "scheduler");

    await updateUserIdentity(
      {
        operation: "replace",
        userId: targetId,
        expectedPrimaryIdentityId: primary.rows[0].id,
        replacementSubject: "target-subject-b",
        retainPrevious: false,
        reason: "Promote verified replacement subject",
      },
      actor,
      context,
    );
    await assert.rejects(
      authenticateRequest(
        authenticatedRequest("target-subject-a", "target@example.test", "Target"),
      ),
      (error: unknown) =>
        error instanceof AuthenticationError && error.status === 403,
    );
    const preserved = await client.query<{ role: string; external_subject: string }>(
      "SELECT role, external_subject FROM app_users WHERE id = $1",
      [targetId],
    );
    assert.deepEqual(preserved.rows[0], {
      role: "scheduler",
      external_subject: "target-subject-b",
    });

    const adminPrimary = await client.query<{ id: string }>(
      `SELECT id FROM auth_identities
        WHERE user_id = $1 AND is_primary AND retired_at IS NULL`,
      [adminId],
    );
    await assert.rejects(
      updateUserIdentity(
        {
          operation: "stage",
          userId: adminId,
          expectedPrimaryIdentityId: adminPrimary.rows[0].id,
          replacementSubject: "admin-online-replacement",
          reason: "Should require break-glass recovery",
        },
        actor,
        context,
      ),
      (error: unknown) => error instanceof AuthIdentityChangeError && error.status === 409,
    );

    const dryRun = await recoverFinalAdministratorIdentity({
      userId: adminId,
      expectedCurrentSubject: "admin-subject",
      replacementSubject: "admin-recovered-subject",
      operator: "TEST-74",
      reason: "Validate final-admin recovery",
      execute: false,
    });
    assert.equal(dryRun.executed, false);
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM auth_identities WHERE external_subject = 'admin-recovered-subject'",
        )
      ).rowCount,
      0,
    );

    const recovered = await recoverFinalAdministratorIdentity({
      userId: adminId,
      expectedCurrentSubject: "admin-subject",
      replacementSubject: "admin-recovered-subject",
      operator: "TEST-74",
      reason: "Validate final-admin recovery",
      execute: true,
    });
    assert.equal(recovered.executed, true);
    const recoveredLogin = await authenticateRequest(
      authenticatedRequest(
        "admin-recovered-subject",
        "admin@example.test",
        "Recovered Admin",
      ),
    );
    assert.equal(recoveredLogin.id, adminId);
    assert.equal(recoveredLogin.role, "admin");
    const rollbackLogin = await authenticateRequest(
      authenticatedRequest("admin-subject", "admin@example.test", "Admin"),
    );
    assert.equal(rollbackLogin.id, adminId);

    const audits = await client.query<{ action: string }>(
      `SELECT action FROM audit_events
        WHERE entity_id IN ($1, $2)
          AND action IN (
            'user.identity.staged',
            'user.identity.replaced',
            'user.identity.recovered'
          )
        ORDER BY id`,
      [targetId, adminId],
    );
    assert.deepEqual(
      audits.rows.map((row) => row.action).sort(),
      [
        "user.identity.recovered",
        "user.identity.replaced",
        "user.identity.staged",
      ],
    );
  },
);
