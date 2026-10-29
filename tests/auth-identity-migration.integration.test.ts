import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const initialMigration = join(process.cwd(), "db/migrations/001_initial_schema.sql");
const identityMigration = join(process.cwd(), "db/migrations/019_auth_identities.sql");

function hasCode(expected: string) {
  return (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === expected;
}

test(
  "auth identity migration backfills and permanently reserves exact subject ownership",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(databaseUrl);
    const client = new Client({ connectionString: databaseUrl });
    const schema = `auth_identity_migration_${process.pid}_${Date.now()}`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}", public`);
      await client.query(await readFile(initialMigration, "utf8"));
      const seeded = await client.query<{ id: string }>(
        `INSERT INTO app_users
           (external_subject, email, display_name, role, last_seen_at)
         VALUES
           ('subject-before-migration', 'before@example.test', 'Before', 'admin',
            '2026-08-20T10:00:00Z')
         RETURNING id`,
      );

      await client.query(await readFile(identityMigration, "utf8"));
      const backfilled = await client.query<{
        user_id: string;
        external_subject: string;
        is_primary: boolean;
        last_seen_at: Date;
      }>("SELECT user_id, external_subject, is_primary, last_seen_at FROM auth_identities");
      assert.deepEqual(backfilled.rows[0], {
        user_id: seeded.rows[0].id,
        external_subject: "subject-before-migration",
        is_primary: true,
        last_seen_at: new Date("2026-08-20T10:00:00.000Z"),
      });

      const legacyInsert = await client.query<{ id: string }>(
        `INSERT INTO app_users (external_subject, email, display_name)
         VALUES ('new-subject', 'new@example.test', 'New')
         RETURNING id`,
      );
      const createdIdentity = await client.query<{ user_id: string; is_primary: boolean }>(
        `SELECT user_id, is_primary FROM auth_identities
          WHERE external_subject = 'new-subject'`,
      );
      assert.deepEqual(createdIdentity.rows[0], {
        user_id: legacyInsert.rows[0].id,
        is_primary: true,
      });

      await assert.rejects(
        client.query(
          `UPDATE auth_identities SET user_id = $1
            WHERE external_subject = 'subject-before-migration'`,
          [legacyInsert.rows[0].id],
        ),
        hasCode("55000"),
      );
      await assert.rejects(
        client.query(
          "DELETE FROM auth_identities WHERE external_subject = 'subject-before-migration'",
        ),
        hasCode("55000"),
      );
      await assert.rejects(
        client.query(
          `UPDATE app_users SET external_subject = 'mirror-drift' WHERE id = $1`,
          [seeded.rows[0].id],
        ),
        hasCode("23514"),
      );
      await assert.rejects(client.query("TRUNCATE auth_identities"), hasCode("55000"));
      await assert.rejects(client.query("TRUNCATE audit_events"), hasCode("55000"));
      await assert.rejects(
        client.query(
          `INSERT INTO auth_identities
             (user_id, provider_key, external_subject)
           VALUES ($1, 'entra_oidc_sub', 'subject-before-migration')`,
          [legacyInsert.rows[0].id],
        ),
        hasCode("23505"),
      );
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  },
);
