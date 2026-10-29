import assert from "node:assert/strict";
import test from "node:test";
import { isolatedDatabase } from "./support/database";
import { seedDemo } from "../scripts/demo-seed";
import { listEngineerRoster } from "../modules/engineers/server";
import { authenticateRequest, listPagePermissions } from "../modules/access/server";
import { buildEngineerRoutes } from "../modules/routing/domain";
import { findRouteIssues } from "../modules/routing/issues";
import { describeCacheFreshness, IDLE_CACHE_REFRESH, operationalIdsConfiguration, projectReadyToBook } from "../modules/work/domain";
import type { PlanningDemandSnapshot, ScheduleSnapshot } from "../modules/work/contracts";
import { claimCacheRefreshJobs, getCachedScheduleMonth, getCacheSnapshot, releaseCacheRefreshJob, requestCacheRefresh, storeCacheSnapshot } from "../modules/work/server";
import { addIsoCalendarDays, londonCalendarDate } from "../shared/calendar";

const environment = {
  NODE_ENV: "development", AUTH_MODE: "development", DEMO_SEED: "1", AUTOTASK_WEB_URL: "https://tickets.example.test",
  AUTOTASK_SUPPORT_QUEUE_IDS: "7101,7102", AUTOTASK_INSTALL_QUEUE_IDS: "7201", AUTOTASK_SURVEY_QUEUE_IDS: "7301",
  AUTOTASK_REQUESTED_STATUS_IDS: "7401,7402", AUTOTASK_ACCESS_STATUS_IDS: "7501", AUTOTASK_THIRD_PARTY_REQUEST_STATUS_IDS: "7601",
  AUTOTASK_READY_TO_BOOK_QUEUE_ID: "7101", AUTOTASK_READY_TO_BOOK_STATUS_ID: "7401",
};
const skip = process.env.TEST_DATABASE_URL ? false : "TEST_DATABASE_URL is not configured";

test("demo seed persists fresh, ID-configured snapshots with route issues and replaces them on rerun", { skip }, async (t) => {
  const client = await isolatedDatabase(t, { environment });
  t.mock.method(globalThis, "fetch", () => { throw new Error("The demo seed must not call a provider."); });
  const first = await seedDemo();
  const actor = await authenticateRequest(new Request("http://localhost:3100"));
  assert.equal(actor.role, "viewer");
  assert.deepEqual((await listPagePermissions(actor.id)).map(({ key, granted }) => ({ key, granted })), [
    { key: "dispatch_review", granted: true }, { key: "engineer_management", granted: false },
  ]);
  const { GET: getSchedule } = await import("../app/api/autotask-schedule/route");
  const { GET: getDemand } = await import("../app/api/planning-demand/route");
  const scheduleResponse = await getSchedule(new Request("http://localhost:3100/api/autotask-schedule"));
  const demandResponse = await getDemand(new Request("http://localhost:3100/api/planning-demand"));
  assert.equal(scheduleResponse.status, 200);
  assert.equal(demandResponse.status, 200);
  const schedulePayload = await scheduleResponse.json();
  const demandPayload = await demandResponse.json();
  assert.equal(schedulePayload.visits.length, 18);
  assert.equal(demandPayload.items.length, 8);
  assert.ok(schedulePayload.visits.every((visit: { autotaskUrl: string | null }) => visit.autotaskUrl === null));
  assert.ok(demandPayload.items.every((item: { autotaskUrl: string | null }) => item.autotaskUrl === null));
  const today = londonCalendarDate();
  const schedule = await getCacheSnapshot<ScheduleSnapshot>("schedule", today);
  const demand = await getCacheSnapshot<PlanningDemandSnapshot>("planning_demand", today);
  assert.ok(schedule);
  assert.ok(demand);
  for (const [kind, snapshot] of [["schedule", schedule], ["planning_demand", demand]] as const) {
    const freshness = describeCacheFreshness(kind, today, snapshot, IDLE_CACHE_REFRESH);
    assert.equal(freshness.status, "fresh");
    assert.equal(freshness.usable, true);
    assert.ok(Math.abs(Date.now() - Date.parse(snapshot.sourceRefreshedAt)) < 30_000);
    assert.ok(Date.parse(snapshot.expiresAt) > Date.now());
  }
  assert.equal(schedule.payload.visits.length, 18);
  const ids = operationalIdsConfiguration();
  assert.deepEqual(new Set(schedule.payload.visits.map(visit => visit.queueId)), new Set([7101, 7201, 7301]));
  assert.ok(schedule.payload.visits.every(visit => ids.requestedStatusIds.has(visit.ticketStatusId) && visit.latitude !== null && visit.longitude !== null));
  assert.equal(demand.payload.items.length, 8);
  assert.ok(demand.payload.items.every(item => ids.planningDemandStatusIds.includes(item.statusId) && [7101, 7201].includes(item.queueId)));
  assert.equal(demand.payload.counts.blocked, 0);
  assert.equal(projectReadyToBook(demand.payload, today, ids.readyToBook).items.length, 3);
  const roster = await listEngineerRoster();
  assert.equal(roster.length, 6);
  const routes = buildEngineerRoutes(schedule.payload.visits, roster);
  const roads = routes.map(route => ({ id: route.id, legDurationsMinutes: route.coordinates.slice(1).map(() => 20) }));
  const issues = findRouteIssues(routes, roads);
  assert.ok(issues.some(issue => issue.kind === "booking-overlap" && issue.resourceId === 990001));
  assert.ok(issues.some(issue => issue.kind === "insufficient-travel" && issue.resourceId === 990002));
  assert.ok(issues.some(issue => issue.kind === "out-of-range" && issue.resourceId === 990003));
  let nextWorkingDay = addIsoCalendarDays(today, 1);
  while ([0, 6].includes(new Date(`${nextWorkingDay}T12:00:00Z`).getUTCDay())) nextWorkingDay = addIsoCalendarDays(nextWorkingDay, 1);
  assert.equal((await getCacheSnapshot<ScheduleSnapshot>("schedule", nextWorkingDay))?.payload.visits.length, 18);
  assert.ok((await getCachedScheduleMonth(today.slice(0, 7))).some(day => day.date === today && day.calls === 18));
  const before = await client.query("SELECT cache_key FROM cache_snapshots ORDER BY cache_key");
  assert.equal(before.rowCount, 16);
  const second = await seedDemo();
  assert.deepEqual(second, first);
  assert.deepEqual((await client.query("SELECT cache_key FROM cache_snapshots ORDER BY cache_key")).rows, before.rows);
  assert.deepEqual((await listEngineerRoster()).map(row => row.id), roster.map(row => row.id));
  assert.equal((await getCacheSnapshot<ScheduleSnapshot>("schedule", today))?.payload.visits.length, 18);
  assert.equal((await getCacheSnapshot<PlanningDemandSnapshot>("planning_demand", today))?.payload.items.length, 8);
  assert.equal((await client.query("SELECT * FROM cache_refresh_queue")).rowCount, 0);
});

test("demo seed releases unrelated claims without replacing their snapshot or pending work", { skip }, async (t) => {
  const client = await isolatedDatabase(t, { environment });
  const date = addIsoCalendarDays(londonCalendarDate(), 100);
  await requestCacheRefresh("schedule", date, null, 100);
  const claim = (await claimCacheRefreshJobs(1))[0];
  assert.ok(claim);
  assert.deepEqual(await storeCacheSnapshot(claim, { fixture: "unrelated snapshot" }, new Date().toISOString()), { stored: true, refreshPending: false });
  const snapshot = await getCacheSnapshot("schedule", date);
  await requestCacheRefresh("schedule", date, null, 100);
  await client.query("UPDATE cache_refresh_queue SET last_error = 'unrelated failure', attempts = 2 WHERE cache_key = $1", [claim.cacheKey]);
  const before = (await client.query("SELECT cache_key, requested_at, priority, attempts, last_error, request_generation FROM cache_refresh_queue")).rows;
  const seedStartedAt = Date.now();
  await seedDemo();
  assert.deepEqual(await getCacheSnapshot("schedule", date), snapshot);
  assert.deepEqual((await client.query("SELECT cache_key, requested_at, priority, attempts, last_error, request_generation FROM cache_refresh_queue")).rows, before);
  // Normal release advances availability while retaining the requested work.
  const availableAt = (await client.query<{ available_at: Date }>("SELECT available_at FROM cache_refresh_queue")).rows[0].available_at.getTime();
  assert.ok(availableAt >= seedStartedAt && availableAt <= Date.now());
  assert.deepEqual((await client.query("SELECT leased_at, lease_owner FROM cache_refresh_queue")).rows, [{ leased_at: null, lease_owner: null }]);
});

test("demo seed reports when its key is held by another lease", { skip }, async (t) => {
  const client = await isolatedDatabase(t, { environment });
  await requestCacheRefresh("schedule", londonCalendarDate());
  const claim = (await claimCacheRefreshJobs(1))[0];
  assert.ok(claim);
  await assert.rejects(seedDemo(), /Demo seed could not claim its remaining keys:.*held by a lease/);
  assert.equal(await getCacheSnapshot("schedule", londonCalendarDate()), null);
  assert.equal((await client.query("SELECT * FROM cache_refresh_queue WHERE lease_owner IS NOT NULL")).rowCount, 1);
  assert.deepEqual(await releaseCacheRefreshJob(claim), { released: true, refreshPending: false });
});

test("demo bookings keep London daytime hours on both clock-change Sundays", { skip }, async (t) => {
  await isolatedDatabase(t, { environment });
  for (const [date, expectedStart] of [["2026-03-29", "2026-03-29T08:00:00.000Z"], ["2026-10-25", "2026-10-25T09:00:00.000Z"]]) {
    await seedDemo(new Date(`${date}T12:00:00Z`));
    const snapshot = await getCacheSnapshot<ScheduleSnapshot>("schedule", date);
    assert.ok(snapshot);
    assert.equal(snapshot.payload.visits[0].startDateTime, expectedStart);
    assert.equal(snapshot.payload.visits.length, 18);
  }
});

test("demo seed reports retry backoff without clearing it", { skip }, async (t) => {
  const client = await isolatedDatabase(t, { environment });
  const date = londonCalendarDate();
  await requestCacheRefresh("schedule", date);
  await client.query("UPDATE cache_refresh_queue SET available_at = now() + interval '1 hour' WHERE scope_date = $1", [date]);
  await assert.rejects(seedDemo(), /in retry backoff until/);
  assert.equal((await client.query("SELECT * FROM cache_refresh_queue WHERE lease_owner IS NOT NULL")).rowCount, 0);
  assert.equal((await client.query("SELECT * FROM cache_refresh_queue WHERE available_at > now()")).rowCount, 1);
});

for (const cleanupFails of [false, true]) {
  test(`demo seed fails mid-batch and ${cleanupFails ? "preserves the original error when cleanup fails" : "releases all its claims"}`, { skip }, async (t) => {
    const client = await isolatedDatabase(t, { environment });
    // An unrelated high-priority key must be held alongside the batch being written.
    await requestCacheRefresh("schedule", addIsoCalendarDays(londonCalendarDate(), 100), null, 100);
    await client.query(`
      CREATE FUNCTION fail_second_seed_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM cache_snapshots) THEN
          RAISE EXCEPTION 'fixture mid-batch storage failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_second_seed_write BEFORE INSERT ON cache_snapshots
        FOR EACH ROW EXECUTE FUNCTION fail_second_seed_write();
    `);
    if (cleanupFails) {
      await client.query(`
        CREATE FUNCTION fail_seed_release() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.lease_owner IS NOT NULL AND NEW.lease_owner IS NULL THEN
            RAISE EXCEPTION 'fixture release failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER fail_seed_release BEFORE UPDATE ON cache_refresh_queue
          FOR EACH ROW EXECUTE FUNCTION fail_seed_release();
      `);
    }
    await assert.rejects(seedDemo(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /fixture mid-batch storage failure/);
      if (cleanupFails) {
        assert.ok(error instanceof AggregateError);
        assert.match(error.errors[0].message, /fixture mid-batch storage failure/);
        assert.ok(error.errors.slice(1).every((entry: Error) => /fixture release failure/.test(entry.message)));
      }
      return true;
    });
    assert.equal((await client.query("SELECT * FROM cache_snapshots")).rowCount, 1, "failure happens after a successful write in the same claimed batch");
    if (!cleanupFails) {
      assert.equal((await client.query("SELECT * FROM cache_refresh_queue WHERE lease_owner IS NOT NULL OR leased_at IS NOT NULL")).rowCount, 0, "no seed-owned lease remains, including unrelated claims");
    }
  });
}

test("cached APIs resolve app-only links and change validators when link configuration changes", { skip }, async (t) => {
  const client = await isolatedDatabase(t, { environment });
  await seedDemo();
  // Model worker snapshots: URLs are absent, while explicit nulls remain a demo opt-out.
  await client.query(`
    UPDATE cache_snapshots SET payload = jsonb_set(payload, '{visits}',
      (SELECT jsonb_agg(visit - 'autotaskUrl') FROM jsonb_array_elements(payload->'visits') AS visit))
      WHERE kind = 'schedule' AND scope_date = $1;
    `, [londonCalendarDate()]);
  await client.query(`
    UPDATE cache_snapshots SET payload = jsonb_set(payload, '{items}',
      (SELECT jsonb_agg(item - 'autotaskUrl') FROM jsonb_array_elements(payload->'items') AS item))
      WHERE kind = 'planning_demand';
  `);
  const { GET: getSchedule } = await import("../app/api/autotask-schedule/route");
  const { GET: getDemand } = await import("../app/api/planning-demand/route");
  const { GET: getReady } = await import("../app/api/ready-to-book/route");
  let date = londonCalendarDate();
  while ([0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())) date = addIsoCalendarDays(date, 1);
  for (const [handler, path, key] of [
    [getSchedule, "/api/autotask-schedule", "visits"],
    [getDemand, "/api/planning-demand", "items"],
    [getReady, `/api/ready-to-book?date=${date}`, "items"],
  ] as const) {
    process.env.AUTOTASK_WEB_URL = "https://tickets.example.test";
    const url = `http://localhost:3100${path}`;
    const response = await handler(new Request(url));
    assert.equal(response.status, 200);
    const rows = (await response.json())[key];
    assert.ok(rows.length > 0);
    for (const row of rows) assert.equal(row.autotaskUrl, `https://tickets.example.test/Mvc/ServiceDesk/TicketDetail.mvc?ticketId=${row.ticketId}`);
    const etag = response.headers.get("ETag");
    assert.ok(etag);
    assert.equal((await handler(new Request(url, { headers: { "If-None-Match": etag } }))).status, 304);
    delete process.env.AUTOTASK_WEB_URL;
    const disabled = await handler(new Request(url, { headers: { "If-None-Match": etag } }));
    assert.equal(disabled.status, 200, "configuration changes must not return an unchanged validator");
    assert.notEqual(disabled.headers.get("ETag"), etag);
    assert.ok((await disabled.json())[key].every((row: { autotaskUrl: string | null }) => row.autotaskUrl === null));
  }
});
