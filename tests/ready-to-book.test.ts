import assert from "node:assert/strict";
import test from "node:test";
import {
  isReadyToBookDateEligible,
  projectReadyToBook,
} from "../modules/work/demand/ready-to-book";
import { readyToBookConfiguration } from "../modules/work/operational-ids";
import { GET as getReadyToBook } from "../app/api/ready-to-book/route";
import { isolatedDatabase } from "./support/database";
import { autotaskTicketUrl } from "../modules/work/links";
import type { PlanningDemandItem, PlanningDemandSnapshot } from "../modules/work/demand/model";

const scope = readyToBookConfiguration({
  AUTOTASK_READY_TO_BOOK_QUEUE_ID: "101",
  AUTOTASK_READY_TO_BOOK_STATUS_ID: "401",
});

function demandItem(
  overrides: Partial<PlanningDemandItem> = {},
): PlanningDemandItem {
  return {
    id: "ticket:101",
    ticketId: 101,
    ticketNumber: "T20260101",
    title: "Replace player",
    companyLabel: "Example Company",
    siteLabel: "Warrington",
    city: "Warrington",
    postcode: "WA1 1AA",
    countryCode: "GB",
    latitude: 53.3875,
    longitude: -2.5962,
    durationMinutes: 60,
    durationSource: "assumed",
    routeRegion: "North",
    logisticsTerritory: "North West",
    territoryGroup: "North",
    queueId: 101,
    queueLabel: "Support",
    statusId: 401,
    statusLabel: "Unassigned request",
    workstream: "support",
    requestType: "requested",
    statusChangedAt: "2026-08-05T08:00:00.000Z",
    ageBand: "fresh",
    dueDate: null,
    dueBucket: "none",
    overdue: false,
    readiness: "eligible",
    exclusionReason: null,
    exclusionDetail: null,
    ...overrides,
  };
}

function snapshot(items: PlanningDemandItem[]): PlanningDemandSnapshot {
  return {
    source: "autotask-planning-demand",
    scopeDate: "2026-08-05",
    generatedAt: "2026-08-05T09:00:00.000Z",
    warnings: ["Location data may be incomplete."],
    counts: {
      total: items.length,
      mapped: items.filter((item) => item.latitude !== null).length,
      unmapped: items.filter((item) => item.latitude === null).length,
      eligible: items.filter((item) => item.readiness === "eligible").length,
      blocked: items.filter((item) => item.readiness === "blocked").length,
      aged: 0,
      overdue: 0,
    },
    items,
  };
}

test("ready-to-book projection selects immutable scope IDs and a strict DTO", () => {
  const result = projectReadyToBook(
    snapshot([
      demandItem({
        queueLabel: "Support renamed by tenant",
        statusLabel: "Request renamed by tenant",
      }),
      demandItem({
        id: "ticket:202",
        ticketId: 202,
        queueId: 99,
        queueLabel: "Install",
        workstream: "install",
      }),
      demandItem({
        id: "ticket:303",
        ticketId: 303,
        latitude: null,
        longitude: null,
        exclusionReason: "ungeocoded",
        exclusionDetail: "No usable coordinates.",
      }),
    ]),
    undefined, scope,
  );

  assert.equal(result.source, "postgres-planning-demand-cache");
  assert.equal(result.planningDate, "2026-08-05");
  assert.deepEqual(result.warnings, ["Location data may be incomplete."]);
  assert.deepEqual(result.counts, {
    total: 2,
    mapped: 1,
    unmapped: 1,
    excluded: 1,
  });
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["ticket:101", "ticket:303"],
  );
  assert.deepEqual(Object.keys(result.items[0] ?? {}).sort(), [
    "autotaskUrl",
    "city",
    "companyLabel",
    "durationMinutes",
    "durationSource",
    "exclusionDetail",
    "exclusionReason",
    "id",
    "latitude",
    "longitude",
    "postcode",
    "region",
    "siteLabel",
    "ticketId",
    "ticketNumber",
    "title",
  ]);
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /Install|logisticsTerritory|statusChangedAt/);
  assert.doesNotMatch(json, /lockedResourceId|lockedStartDateTime|lockedEndDateTime/);
});

test("ready-to-book distinguishes missing IDs from an exact scope with no matches", () => {
  const missingIds = projectReadyToBook(
    snapshot([demandItem({ queueId: 0, statusId: 0 })]),
    undefined, scope,
  );
  assert.match(missingIds.warnings.at(-1) ?? "", /missing immutable queue\/status IDs/);
  assert.doesNotMatch(missingIds.warnings.at(-1) ?? "", /none match required/);

  const noMatches = projectReadyToBook(
    snapshot([demandItem({ queueId: 99, statusId: 101 })]),
    undefined, scope,
  );
  assert.match(
    noMatches.warnings.at(-1) ?? "",
    /none match required queue ID 101 and status ID 401/,
  );
  assert.equal(noMatches.items.length, 0);
});

test("ready-to-book eligibility uses real London calendar weekdays", () => {
  const wednesdayLondon = new Date("2026-08-05T11:00:00.000Z");
  assert.equal(isReadyToBookDateEligible("2026-08-05", wednesdayLondon), true);
  assert.equal(isReadyToBookDateEligible("2026-08-06", wednesdayLondon), true);
  assert.equal(isReadyToBookDateEligible("2026-08-04", wednesdayLondon), false);
  assert.equal(isReadyToBookDateEligible("2026-08-08", wednesdayLondon), false);
  assert.equal(isReadyToBookDateEligible("2026-08-09", wednesdayLondon), false);
  assert.equal(isReadyToBookDateEligible("2026-02-29", wednesdayLondon), false);
  assert.equal(isReadyToBookDateEligible("2028-02-29", wednesdayLondon), true);
  assert.equal(isReadyToBookDateEligible("05-08-2026", wednesdayLondon), false);
});

test("Autotask ticket links use only positive immutable ticket ids", () => {
  assert.equal(
    autotaskTicketUrl(101, "https://tickets.example.test"),
    "https://tickets.example.test/Mvc/ServiceDesk/TicketDetail.mvc?ticketId=101",
  );
  assert.equal(autotaskTicketUrl(0, "https://tickets.example.test"), null);
  assert.equal(autotaskTicketUrl(-1, "https://tickets.example.test"), null);
  assert.equal(autotaskTicketUrl(1.5, "https://tickets.example.test"), null);
  assert.equal(autotaskTicketUrl(Number.NaN, "https://tickets.example.test"), null);
  assert.equal(autotaskTicketUrl(null, "https://tickets.example.test"), null);
});

test("ready-to-book projection uses the supplied tenant scope and rejects missing config even for empty data", (t) => {
  const configured = readyToBookConfiguration({
    AUTOTASK_READY_TO_BOOK_QUEUE_ID: "701",
    AUTOTASK_READY_TO_BOOK_STATUS_ID: "801",
  });
  const result = projectReadyToBook(snapshot([
    demandItem(), demandItem({ id: "ticket:202", queueId: 701, statusId: 801 }),
  ]), undefined, configured);
  assert.deepEqual(result.items.map((item) => item.id), ["ticket:202"]);
  assert.equal(result.scope.queueId, 701);
  assert.equal(result.scope.statusId, 801);
  const previous = process.env.AUTOTASK_READY_TO_BOOK_QUEUE_ID;
  t.after(() => {
    if (previous === undefined) delete process.env.AUTOTASK_READY_TO_BOOK_QUEUE_ID;
    else process.env.AUTOTASK_READY_TO_BOOK_QUEUE_ID = previous;
  });
  delete process.env.AUTOTASK_READY_TO_BOOK_QUEUE_ID;
  assert.throws(() => projectReadyToBook(snapshot([])), /AUTOTASK_READY_TO_BOOK_QUEUE_ID/);
});

test("ready-to-book API audits invalid scope as an explicit 500 before reading an empty cache", {
  skip: process.env.TEST_DATABASE_URL ? false : "TEST_DATABASE_URL is not configured",
}, async (t) => {
  const client = await isolatedDatabase(t, { environment: {
    AUTH_MODE: "development", DEV_USER_SUBJECT: "dev:ready-to-book",
    DEV_USER_EMAIL: "viewer@example.test", DEV_USER_NAME: "Ready to book viewer",
    DEV_PAGE_PERMISSIONS: "dispatch_review",
    AUTOTASK_READY_TO_BOOK_QUEUE_ID: "101", AUTOTASK_READY_TO_BOOK_STATUS_ID: "401",
  } });
  for (const name of ["AUTOTASK_READY_TO_BOOK_QUEUE_ID", "AUTOTASK_READY_TO_BOOK_STATUS_ID"]) {
    for (const value of [undefined, "", "bad", "9007199254740992"]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      const response = await getReadyToBook(new Request("https://planner.example.test/api/ready-to-book"));
      assert.equal(response.status, 500);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.match((await response.json()).message, new RegExp(name));
    }
    process.env[name] = name.endsWith("QUEUE_ID") ? "101" : "401";
  }
  const audit = await client.query("SELECT metadata FROM audit_events WHERE action = 'api.request.failed' AND entity_id = '/api/ready-to-book'");
  assert.equal(audit.rows.length, 8);
  assert.ok(audit.rows.every((row) => row.metadata.status === 500));
});

test("ticket link configuration is optional and rejects non-HTTPS or non-origin values", async () => {
  const { autotaskWebUrl } = await import("../modules/work/server/link-config");
  assert.equal(autotaskWebUrl({}), null);
  assert.equal(autotaskWebUrl({ AUTOTASK_WEB_URL: "  " }), null);
  assert.equal(autotaskWebUrl({ AUTOTASK_WEB_URL: " https://tickets.example.test/ " }), "https://tickets.example.test");
  for (const value of ["invalid", "http://tickets.example.test", "javascript:alert(1)", "https://user:password@tickets.example.test", "https://tickets.example.test/path", "https://tickets.example.test/?q=1", "https://tickets.example.test/#fragment"]) {
    assert.throws(() => autotaskWebUrl({ AUTOTASK_WEB_URL: value }), /AUTOTASK_WEB_URL/);
  }
  assert.equal(autotaskTicketUrl(101), null);
});

test("app demand projections use configured links and respect snapshot nulls", async () => {
  const { projectPlanningDemandSnapshot } = await import("../modules/work/demand/model");
  const input = snapshot([demandItem(), demandItem({ id: "ticket:102", ticketId: 102, autotaskUrl: null })]);
  const webUrl = "https://tickets.example.test";
  for (const result of [projectPlanningDemandSnapshot(input, webUrl), projectReadyToBook(input, undefined, scope, webUrl)]) {
    assert.equal(result.items[0].autotaskUrl, `${webUrl}/Mvc/ServiceDesk/TicketDetail.mvc?ticketId=101`);
    assert.equal(result.items[1].autotaskUrl, null);
  }
  for (const result of [projectPlanningDemandSnapshot(input), projectReadyToBook(input, undefined, scope)]) {
    assert.ok(result.items.every((item) => item.autotaskUrl === null));
  }
  assert.equal(input.items[0].autotaskUrl, undefined, "projections do not mutate snapshots");
});
