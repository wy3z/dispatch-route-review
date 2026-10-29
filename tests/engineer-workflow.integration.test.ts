import assert from "node:assert/strict";
import test from "node:test";
import { isolatedDatabase } from "./support/database";
import type { AppUser } from "../modules/access/contracts";
import type { EngineerRosterPayload } from "../modules/engineers/contracts";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

test("roster workflows preserve atomic audit and invalidation", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async (t) => {
  const admin = await isolatedDatabase(t);
  const workflow = await import("../workflows/engineer-management");
  const user = await admin.query<{ id: string }>(
    `INSERT INTO app_users (external_subject, email, display_name, role)
     VALUES ('test:roster', 'roster@example.test', 'Roster admin', 'admin') RETURNING id`,
  );
  const actor: AppUser = {
    id: user.rows[0].id, externalSubject: "test:roster", email: "roster@example.test",
    displayName: "Roster admin", role: "admin", active: true,
  };
  const context = { requestId: "roster-workflow-test", ipAddress: null, userAgent: null };
  const payload: EngineerRosterPayload = {
    resourceId: 99001, name: "Fixture Engineer", base: "Fixture Base", region: "North",
    latitude: 53.4, longitude: -2.1, active: true, workingDays: [1, 2, 3, 4, 5],
    workdayStart: "09:00", workdayEnd: "17:00", aliases: [],
  };
  await admin.query(`INSERT INTO cache_snapshots
    (cache_key, kind, scope_date, payload, source_refreshed_at, expires_at)
    SELECT kind || ':2030-01-01', kind, '2030-01-01', '{}'::jsonb, now(), now() + interval '1 hour'
    FROM unnest(ARRAY['schedule', 'planning_demand']) AS kind`);

  const created = await workflow.createManagedEngineer(payload, actor, context);
  assert.equal(created.resourceId, payload.resourceId);
  assert.equal((await admin.query("SELECT * FROM cache_refresh_queue")).rowCount, 2);
  const updated = await workflow.updateManagedEngineer(created.id, { ...payload, base: "New Base" }, actor, context);
  assert.equal(updated?.base, "New Base");
  assert.equal(updated?.colourIndex, created.colourIndex);
  await assert.rejects(
    workflow.updateManagedEngineer(created.id, { ...payload, resourceId: 99002 }, actor, context),
    /resource ID cannot be changed/,
  );
  await workflow.deactivateManagedEngineer(created.id, actor, context);
  await workflow.deactivateManagedEngineer(created.id, actor, context);
  const roster = await admin.query("SELECT active, base FROM engineer_roster WHERE id = $1", [created.id]);
  assert.deepEqual(roster.rows, [{ active: false, base: "New Base" }]);
  const events = await admin.query("SELECT action FROM audit_events ORDER BY id");
  assert.deepEqual(events.rows.map((row) => row.action), [
    "engineer.created", "engineer.updated", "engineer.deactivated",
  ]);

  // Fail the last step: neither the roster write nor its audit may commit alone.
  await admin.query(`CREATE FUNCTION fail_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture invalidation failure'; END; $$;
    CREATE TRIGGER fail_invalidation BEFORE INSERT OR UPDATE ON cache_refresh_queue
    FOR EACH ROW EXECUTE FUNCTION fail_invalidation()`);
  await assert.rejects(
    workflow.createManagedEngineer({ ...payload, resourceId: 99003 }, actor, context),
    /fixture invalidation failure/,
  );
  assert.equal((await admin.query("SELECT * FROM engineer_roster")).rowCount, 1);
  assert.equal((await admin.query("SELECT * FROM audit_events")).rowCount, 3);
});
