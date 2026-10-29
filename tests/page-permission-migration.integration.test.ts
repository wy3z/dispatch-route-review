import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { isolatedDatabase } from "./support/database";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const migrationsDirectory = join(process.cwd(), "db/migrations");

type Fixture = {
  email: string;
  active?: boolean;
  rows: Array<["audit" | "dispatch", boolean]>;
  expected: boolean;
};

const fixtures: Fixture[] = [
  { email: "missing@example.test", rows: [], expected: true },
  { email: "audit-false@example.test", rows: [["audit", false]], expected: true },
  { email: "dispatch-false@example.test", rows: [["dispatch", false]], expected: true },
  {
    email: "both-false@example.test",
    active: false,
    rows: [["audit", false], ["dispatch", false]],
    expected: false,
  },
  {
    email: "audit-true@example.test",
    rows: [["audit", true], ["dispatch", false]],
    expected: true,
  },
  {
    email: "dispatch-true@example.test",
    rows: [["audit", false], ["dispatch", true]],
    expected: true,
  },
];

test(
  "page-permission migration preserves effective access and enforces the new contract",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async (t) => {
    const migrationNames = (await readdir(migrationsDirectory))
      .filter((name) => /^00[1-7]_.*\.sql$/.test(name))
      .sort();
    assert.equal(migrationNames.length, 7);
    const client = await isolatedDatabase(t, { migrations: migrationNames });
    const userIds = new Map<string, string>();
    for (const [index, fixture] of fixtures.entries()) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO app_users
           (external_subject, email, display_name, active)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          `permission-fixture-${index}`,
          fixture.email,
          fixture.email,
          fixture.active ?? true,
        ],
      );
      const userId = inserted.rows[0].id;
      userIds.set(fixture.email, userId);
      for (const [pageKey, visible] of fixture.rows) {
        await client.query(
          `INSERT INTO app_user_page_visibility (user_id, page_key, visible)
           VALUES ($1, $2, $3)`,
          [userId, pageKey, visible],
        );
      }
    }

    const historyOwner = userIds.get(fixtures[0].email);
    assert.ok(historyOwner);
    const plan = await client.query<{ id: string }>(
      `INSERT INTO scheduler_plans
         (planning_date, region, name, plan, created_by, updated_by)
       VALUES ('2026-08-12', 'London', 'Retained plan', '{}'::jsonb, $1, $1)
       RETURNING id`,
      [historyOwner],
    );
    await client.query(
      `INSERT INTO scheduler_plan_revisions
         (plan_id, revision, plan, change_summary, created_by)
       VALUES ($1, 1, '{}'::jsonb, 'Retained revision', $2)`,
      [plan.rows[0].id, historyOwner],
    );
    await client.query(
      `INSERT INTO audit_events
         (actor_user_id, actor_subject, actor_email, action, entity_type,
          entity_id, request_id, metadata)
       VALUES ($1, 'permission-fixture-0', $2, 'fixture.created',
               'test_fixture', 'retained', 'migration-test', '{}'::jsonb)`,
      [historyOwner, fixtures[0].email],
    );

    const migration = await readFile(
      join(migrationsDirectory, "008_page_permissions.sql"),
      "utf8",
    );
    await client.query(migration);

    const permissions = await client.query<{
      email: string;
      granted: boolean;
      updated_by: string | null;
    }>(
      `SELECT users.email, permissions.granted, permissions.updated_by
         FROM app_users AS users
         JOIN app_user_permissions AS permissions ON permissions.user_id = users.id
        WHERE users.email LIKE '%@example.test'
        ORDER BY users.email`,
    );
    assert.equal(permissions.rowCount, fixtures.length);
    const grants = new Map(
      permissions.rows.map((row) => [row.email, row.granted]),
    );
    for (const fixture of fixtures) {
      assert.equal(grants.get(fixture.email), fixture.expected, fixture.email);
    }
    assert.ok(permissions.rows.every((row) => row.updated_by === null));

    await assert.rejects(
      client.query(
        `INSERT INTO app_user_permissions (user_id, permission_key, granted)
         VALUES ($1, 'audit', true)`,
        [historyOwner],
      ),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error &&
        error.code === "23514",
    );

    const engineerRosterMigration = await readFile(
      join(migrationsDirectory, "009_engineer_roster.sql"),
      "utf8",
    );
    await client.query(engineerRosterMigration);
    await client.query(
      `INSERT INTO app_user_permissions (user_id, permission_key, granted)
       VALUES ($1, 'engineer_management', true)`,
      [historyOwner],
    );
    const engineerPermission = await client.query<{ granted: boolean }>(
      `SELECT granted FROM app_user_permissions
        WHERE user_id = $1 AND permission_key = 'engineer_management'`,
      [historyOwner],
    );
    assert.equal(engineerPermission.rows[0]?.granted, true);

    const emptyRoster = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM engineer_roster",
    );
    assert.equal(emptyRoster.rows[0].count, "0");

    await client.query(
      `INSERT INTO engineer_roster
         (autotask_resource_id, name, base, region, latitude, longitude)
       VALUES (1001, 'Test Engineer', 'Test Base', 'North', 53.5, -2.2)`,
    );
    const roster = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM engineer_roster",
    );
    assert.equal(roster.rows[0].count, "1");

    await assert.rejects(
      client.query(
        `INSERT INTO engineer_roster
           (autotask_resource_id, name, base, region, latitude, longitude)
         VALUES (1001, 'Duplicate Engineer', 'Other Base', 'North', 53.4, -2.1)`,
      ),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error &&
        error.code === "23505",
    );

    const newcomer = await client.query<{ id: string }>(
      `INSERT INTO app_users (external_subject, email, display_name)
       VALUES ('new-user', 'new-user@example.test', 'New user')
       RETURNING id`,
    );
    const newcomerPermission = await client.query(
      `SELECT 1 FROM app_user_permissions WHERE user_id = $1`,
      [newcomer.rows[0].id],
    );
    assert.equal(newcomerPermission.rowCount, 0);

    const retained = await client.query<{
      plans: string;
      revisions: string;
      events: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM scheduler_plans) AS plans,
         (SELECT count(*)::text FROM scheduler_plan_revisions) AS revisions,
         (SELECT count(*)::text FROM audit_events) AS events`,
    );
    assert.deepEqual(retained.rows[0], {
      plans: "1",
      revisions: "1",
      events: "1",
    });

    await client.query(`DELETE FROM app_users WHERE id = $1`, [
      userIds.get("both-false@example.test"),
    ]);
    const cascaded = await client.query(
      `SELECT 1 FROM app_user_permissions WHERE user_id = $1`,
      [userIds.get("both-false@example.test")],
    );
    assert.equal(cascaded.rowCount, 0);

  },
);
