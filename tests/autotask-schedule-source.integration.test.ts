import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { loadAutotaskSchedule } from "../modules/work/worker/schedule-source";
import { projectScheduleSnapshot } from "../modules/work/schedule/projection";
import { buildEngineerRoutes } from "../modules/routing/route-builder";
import { operationalIdsConfiguration } from "../modules/work/operational-ids";
import { runCacheWorker } from "../modules/work/worker/run";
import { loadPlanningDemand } from "../modules/work/worker/demand-source";
import { isolatedDatabase } from "./support/database";
import { selectedThirdPartyVisitStatusIds, syncThirdPartyVisitStatusCatalog, listThirdPartyVisitStatuses } from "../modules/work/server/third-party-statuses";

const environment = {
  AUTOTASK_SUPPORT_QUEUE_IDS: "101,102",
  AUTOTASK_INSTALL_QUEUE_IDS: "201",
  AUTOTASK_SURVEY_QUEUE_IDS: "301",
  AUTOTASK_REQUESTED_STATUS_IDS: "401,402,403,404,405",
  AUTOTASK_ACCESS_STATUS_IDS: "501,502",
  AUTOTASK_THIRD_PARTY_REQUEST_STATUS_IDS: "601,602",
  AUTOTASK_READY_TO_BOOK_QUEUE_ID: "101",
  AUTOTASK_READY_TO_BOOK_STATUS_ID: "401",
};
const ids = operationalIdsConfiguration(environment);

// Replay API-shaped tickets through the real worker, with HTTP and PostgreSQL
// boundaries replaced. No live credentials, database, or Autotask writes.
test("worker carries company UDFs through cache projection into supplier groups", async (t) => {
  const env = {
    CACHE_WORKER: "1", NODE_ENV: "test", AUTOTASK_THIRD_PARTY_COMPANY_FIELD: " Supplier field ", AUTOTASK_BASE_URL: "https://autotask.test/V1.0",
    AUTOTASK_API_CODE: "fixture", AUTOTASK_USERNAME: "fixture", AUTOTASK_SECRET: "fixture",
  };
  const original = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  const oldPool = globalThis.__dispatchDatabasePool;
  const statuses = [710, 711, 710, 710, 711, 712, 710];
  const suppliers = ["Supplier A", "Supplier A", "Supplier B", null, null, null, "Supplier C"];
  const selectedStatuses = [710, 711, 712];
  const tickets = statuses.map((status, index) => ({
    id: index + 101, status, queueID: [...ids.supportQueueIds][0],
    userDefinedFields: [
      { name: "Supplier field", value: suppliers[index] },
      { name: "Third Party Engineer", value: "Individual engineer" },
      { name: "Private unrelated field", value: "must not escape" },
    ],
  }));
  const calls = tickets.map((_, index) => ({
    id: index + 1, startDateTime: "2026-09-07T10:00:00Z", endDateTime: "2026-09-07T11:00:00Z",
  }));
  const links = tickets.map((ticket, index) => ({ id: index + 201, serviceCallID: index + 1, ticketID: ticket.id }));
  const query = async (sql: string) => {
    if (sql.includes("FROM engineer_roster")) return { rows: [{
      id: "fixture", autotask_resource_id: "77", name: "Internal engineer", base: "York",
      region: "North", latitude: 53.96, longitude: -1.08, colour_index: 0, active: true,
      working_days: [1, 2, 3, 4, 5], workday_start: "09:00", workday_end: "17:00",
    }] };
    if (sql.includes("WHERE selected = true")) return { rows: selectedStatuses.map((status_id) => ({ status_id: String(status_id) })) };
    if (/^(BEGIN|COMMIT|ROLLBACK|UPDATE third_party_visit_statuses|INSERT INTO third_party_visit_statuses|INSERT INTO autotask_api_activity)/.test(sql.trim())) return { rows: [] };
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  };
  globalThis.__dispatchDatabasePool = {
    query, connect: async () => ({ query, release() {} }),
  } as unknown as Pool;
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://autotask.test");
    if (url.pathname.endsWith("/Tickets/entityInformation/fields")) {
      assert.equal(init.method ?? "GET", "GET");
      return Response.json({ fields: [
        { name: "status", picklistValues: [
          { value: "710", label: "Third Party Attending" },
          { value: "711", label: "Third Party Attending with equipment" },
          { value: "712", label: "Legacy supplier attending" },
        ] },
        { name: "queueID", picklistValues: [...ids.supportQueueIds, ...ids.installQueueIds, ...ids.surveyQueueIds].map((value) => ({ value, label: `Queue ${value}` })) },
      ] });
    }
    assert.equal(init.method, "POST");
    assert.ok(url.pathname.endsWith("/query"));
    const entity = url.pathname.split("/").at(-2);
    const items = entity === "Tickets" ? tickets
      : entity === "ServiceCalls" ? calls
      : entity === "ServiceCallTickets" ? links
      : entity === "ServiceCallTicketResources" ? [{ id: 301, serviceCallTicketID: 207, resourceID: 77 }]
      : entity === "Resources" ? [{ id: 77, firstName: "Internal", lastName: "engineer" }]
      : null;
    assert.ok(items, `Unexpected fixture entity: ${entity}`);
    return Response.json({ items });
  });
  try {
    Object.assign(process.env, env);
    const snapshot = await loadAutotaskSchedule("2026-09-07", new AbortController().signal, ids);
    // Serialisation simulates the JSON snapshot persisted by the cache worker.
    const projected = projectScheduleSnapshot(JSON.parse(JSON.stringify(snapshot)));
    const groups = buildEngineerRoutes(projected.visits, []);
    const supplierA = groups.find((group) => group.resourceName === "Supplier A");
    assert.equal(supplierA?.stops.length, 2);
    assert.deepEqual(supplierA?.stops.map((stop) => stop.ticketStatusId), [710, 711]);
    assert.ok(groups.some((group) => group.resourceName === "Supplier B"));
    assert.ok(groups.some((group) => group.resourceName === "Legacy supplier attending"));
    assert.equal(new Set(groups.map((group) => group.resourceName)).size, 6);
    assert.equal(projected.visits.length, calls.length);
    assert.ok(projected.visits.every((visit) => visit.resourceId === null));
    assert.ok(projected.warnings.some((warning) => warning.startsWith("3 third-party attendance records")));
    assert.equal(projected.visits.find((visit) => visit.serviceCallId === 1)?.thirdPartyCompany, "Supplier A");
    assert.doesNotMatch(JSON.stringify(projected), /Individual engineer|must not escape|userDefinedFields/);

    // An unset field must not silently recognise a supplier custom field.
    delete process.env.AUTOTASK_THIRD_PARTY_COMPANY_FIELD;
    const fallback = await loadAutotaskSchedule("2026-09-07", new AbortController().signal, ids);
    assert.ok(fallback.visits.every((visit) => visit.thirdPartyCompany === null));
    assert.ok(fallback.visits.every((visit) => visit.routeOwnerKey === `third-party:${visit.ticketStatusId}`));
    assert.ok(fallback.visits.every((visit) => visit.autotaskUrl === undefined), "the worker does not resolve web links");
    assert.ok(!fallback.warnings.some((warning) => warning.includes("company field")));
    process.env.AUTOTASK_THIRD_PARTY_COMPANY_FIELD = "Supplier field";

    // An operator's status selection still gates third-party ownership.
    selectedStatuses.splice(0, selectedStatuses.length, 712);
    const unselected = await loadAutotaskSchedule("2026-09-07", new AbortController().signal, ids);
    const internal = unselected.visits.find((visit) => visit.serviceCallId === 7);
    assert.equal(internal?.ownerType, "internal");
    assert.equal(internal?.resourceId, 77);
    assert.equal(internal?.thirdPartyCompany, null);
  } finally {
    globalThis.__dispatchDatabasePool = oldPool;
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("worker rejects each invalid setting at startup and before direct source reads", async (t) => {
  const previous = Object.fromEntries(["CACHE_WORKER", ...Object.keys(environment)].map((key) => [key, process.env[key]]));
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    throw new Error("Unexpected Autotask call");
  });
  try {
    process.env.CACHE_WORKER = "1";
    for (const name of Object.keys(environment)) {
      Object.assign(process.env, environment, { [name]: "" });
      await assert.rejects(runCacheWorker(), new RegExp(name));
      await assert.rejects(loadAutotaskSchedule("2026-09-07", new AbortController().signal), new RegExp(name));
      await assert.rejects(loadPlanningDemand(new AbortController().signal), new RegExp(name));
    }
    assert.equal(fetches, 0);
  } finally {
    for (const key of ["CACHE_WORKER", ...Object.keys(environment)]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("third-party visit migration starts empty and catalog sync selects nothing", {
  skip: process.env.TEST_DATABASE_URL ? false : "TEST_DATABASE_URL is not configured",
}, async (t) => {
  const client = await isolatedDatabase(t);
  assert.deepEqual(await listThirdPartyVisitStatuses(), []);
  assert.deepEqual([...(await selectedThirdPartyVisitStatusIds())], []);
  const indexes = await client.query("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'third_party_visit_statuses'");
  assert.ok(indexes.rows.some((row) => row.indexname === "third_party_visit_statuses_selected_idx"));
  await syncThirdPartyVisitStatusCatalog(new Map([[710, "Supplier attending"], [711, "Supplier attending with kit"]]));
  const statuses = await listThirdPartyVisitStatuses();
  assert.equal(statuses.length, 2);
  assert.ok(statuses.every((status) => status.available && !status.selected));
  assert.deepEqual([...(await selectedThirdPartyVisitStatusIds())], []);
});
