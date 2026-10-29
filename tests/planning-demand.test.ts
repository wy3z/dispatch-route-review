import assert from "node:assert/strict";
import test from "node:test";
import {
  assertConfiguredIdsExist,
  operationalIdsConfiguration,
  readyToBookConfiguration,
} from "../modules/work/operational-ids";
import {
  buildPlanningDemandSnapshot,
  classifyPlanningDemandCandidate,
  resolvePlanningDemandDuration,
  territoryGroupForLabel,
} from "../modules/work/demand/model";
import type { PlanningDemandCandidate, PlanningDemandItem } from "../modules/work/demand/model";
import { filterRegionForDemand, routeFilterRegions } from "../modules/dispatch/model/regions";
import { haversineKm } from "../shared/coordinates";
import { resolveSiteCoverage as resolveCoverage } from "../modules/work/demand/coverage";
import { findRouteSuggestions } from "../modules/routing/suggestions";
import type { EngineerBase } from "../modules/engineers/contracts";
import type { EngineerRoute } from "../modules/routing/contracts";
import type { ScheduledVisit } from "../modules/work/contracts";

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

const engineerBases: EngineerBase[] = [
  {
    resourceId: 1,
    name: "North engineer",
    base: "Manchester",
    region: "North",
    latitude: 53.48,
    longitude: -2.24,
  },
];

function resolveSiteCoverage(args: Parameters<typeof resolveCoverage>[0]) {
  return resolveCoverage(args, engineerBases);
}

function candidate(
  overrides: Partial<PlanningDemandCandidate> = {},
): PlanningDemandCandidate {
  return {
    ticketId: 101,
    ticketNumber: "T20260001",
    title: "Replace player",
    companyLabel: "Example Retail",
    siteLabel: "Manchester",
    city: "Manchester",
    postcode: "M1 1AA",
    countryCode: "GB",
    latitude: 53.48,
    longitude: -2.24,
    durationMinutes: 60,
    durationSource: "assumed",
    routeRegion: "North",
    logisticsTerritory: "North West",
    queueId: 101,
    queueLabel: "Support",
    statusId: 401,
    statusLabel: "Unassigned request",
    statusChangedAt: "2026-08-06T08:00:00.000Z",
    dueDate: "2026-08-06T17:00:00.000Z",
    exclusionReason: null,
    exclusionDetail: null,
    ...overrides,
  };
}

test("neutral duration and geography transforms preserve planning coverage", () => {
  assert.deepEqual(resolvePlanningDemandDuration(1.25), {
    durationMinutes: 75,
    durationSource: "estimated",
  });
  assert.deepEqual(resolvePlanningDemandDuration(null), {
    durationMinutes: 60,
    durationSource: "assumed",
  });

  const ukCoverage = resolveSiteCoverage({
    latitude: 53.48,
    longitude: -2.24,
    postcode: "M1 1AA",
    countryCode: "GB",
    countryName: "United Kingdom",
  });
  assert.equal(ukCoverage.region, "North");
  assert.equal(ukCoverage.exclusionReason, null);

  const overseasCoverage = resolveSiteCoverage({
    latitude: 50.85,
    longitude: 4.35,
    postcode: "1000",
    countryCode: "BE",
    countryName: "Belgium",
  });
  assert.equal(overseasCoverage.region, null);
  assert.equal(overseasCoverage.exclusionReason, "no_covered_base");

  assert.deepEqual(
    resolveSiteCoverage({
      latitude: null,
      longitude: null,
      postcode: "",
      countryCode: "",
      countryName: "",
    }),
    {
      region: null,
      exclusionReason: "no_postcode",
      exclusionDetail: "No postcode and no usable coordinates — excluded.",
    },
  );
  assert.ok(haversineKm(53.48, -2.24, 53.48, -2.24) < 0.001);
});

test("planning demand derives workstream, request type, age, due state and territory", () => {
  const item = classifyPlanningDemandCandidate(
    candidate(),
    "2026-08-07",
    "2026-08-07T12:00:00.000Z",
    ids,
  );
  assert.ok(item);
  assert.equal(item.workstream, "support");
  assert.equal(item.requestType, "requested");
  assert.equal(item.ageBand, "aged");
  assert.equal(item.overdue, true);
  assert.equal(item.territoryGroup, "North");
  assert.equal(item.readiness, "eligible");
  assert.equal(item.queueId, 101);
  assert.equal(item.statusId, 401);
});

test("request families and queue groups follow immutable operational IDs", () => {
  const snapshot = buildPlanningDemandSnapshot({
    ids,
    scopeDate: "2026-08-07",
    generatedAt: "2026-08-07T12:00:00.000Z",
    candidates: [
      candidate(),
      candidate({
        ticketId: 102,
        queueId: 201,
        queueLabel: "Install",
        statusId: 502,
        statusLabel: "Access Requested & Kit",
      }),
      candidate({
        ticketId: 103,
        queueId: 202,
        queueLabel: "Field Services",
        statusId: 601,
        statusLabel: "3rd Party Requested",
      }),
      candidate({
        ticketId: 104,
        queueId: 301,
        queueLabel: "Surveys",
        statusLabel: "Unassigned request",
      }),
    ],
  });
  assert.deepEqual(
    snapshot.items.map((item) => [item.ticketId, item.workstream, item.requestType]),
    [
      [101, "support", "requested"],
      [102, "install", "access"],
      [103, "other", "third_party"],
    ],
  );
  assert.equal(snapshot.counts.total, 3);
});

test("configured request statuses validate and retain every demand family", () => {
  // Renamed labels must not affect scope or classification.
  const currentStatuses = new Map([
    [401, "requested"], [402, "requested"], [403, "requested"],
    [404, "requested"], [405, "requested"],
    [501, "access"], [502, "access"],
    [601, "third_party"], [602, "third_party"],
  ]);
  const metadata = new Map([...currentStatuses.keys()].map((id) => [id, `Renamed ${id}`]));
  assert.doesNotThrow(() => assertConfiguredIdsExist(
    "Planning-demand status", ids.planningDemandStatusIds, metadata,
  ));
  for (const [statusId, requestType] of currentStatuses) {
    assert.ok(ids.planningDemandStatusIds.includes(statusId));
    const item = classifyPlanningDemandCandidate(
      candidate({ statusId, statusLabel: `Renamed ${statusId}` }),
      "2026-09-07", "2026-09-07T12:00:00.000Z", ids,
    );
    assert.equal(item?.requestType, requestType);
  }
  for (const statusId of [701, 702, 703, 704]) {
    assert.equal(ids.planningDemandStatusIds.includes(statusId), false);
    assert.equal(classifyPlanningDemandCandidate(
      candidate({ statusId }), "2026-09-07", "2026-09-07T12:00:00.000Z", ids,
    ), null);
  }
  // A future unexpected metadata omission must still fail visibly.
  metadata.delete(401);
  assert.throws(() => assertConfiguredIdsExist(
    "Planning-demand status", ids.planningDemandStatusIds, metadata,
  ), /missing configured numeric IDs: 401/);
});

test("planning demand classification is stable when tenant labels are renamed", () => {
  const item = classifyPlanningDemandCandidate(
    candidate({
      queueLabel: "Support renamed by tenant",
      statusLabel: "Request renamed by tenant",
    }),
    "2026-08-07",
    "2026-08-07T12:00:00.000Z",
    ids,
  );
  assert.ok(item);
  assert.equal(item.workstream, "support");
  assert.equal(item.requestType, "requested");
});

function stop(overrides: Partial<ScheduledVisit> = {}): ScheduledVisit {
  return {
    id: "visit:1",
    serviceCallId: 1,
    ticketId: 201,
    ticketNumber: "TBOOKED",
    title: "Booked job",
    autotaskUrl: null,
    companyName: "Booked Store",
    locationName: "Manchester",
    address: "",
    city: "Manchester",
    postcode: "M1 2AA",
    resourceId: 1,
    resourceName: "Engineer One",
    routeOwnerKey: "resource:1",
    ownerType: "internal",
    ticketStatusId: 1,
    ticketStatusLabel: "Engineer Attending",
    queueId: 1,
    queueLabel: "Support",
    jobType: "support",
    ignoredResourceCount: 0,
    startDateTime: "2026-08-07T13:00:00.000Z",
    endDateTime: "2026-08-07T14:00:00.000Z",
    durationMinutes: 60,
    status: 1,
    isComplete: false,
    latitude: 53.481,
    longitude: -2.241,
    additionalTicketCount: 0,
    ...overrides,
  };
}

function route(overrides: Partial<EngineerRoute> = {}): EngineerRoute {
  return {
    id: "route:1",
    resourceId: 1,
    resourceName: "Engineer One",
    base: null,
    colour: "#123456",
    stops: [{ ...stop(), sequence: 1, inboundLegIndex: 0, isOutOfRange: false }],
    coordinates: [[53.481, -2.241]],
    returnLegIndex: null,
    ...overrides,
  };
}

test("suggestions select one nearest booked route without mutating route data", () => {
  const snapshot = buildPlanningDemandSnapshot({
    ids,
    scopeDate: "2026-08-07",
    generatedAt: "2026-08-07T09:00:00.000Z",
    candidates: [
      candidate({ statusChangedAt: "2026-08-07T08:00:00.000Z" }),
      candidate({ ticketId: 102, statusId: 501, statusLabel: "Access Requested" }),
      candidate({ ticketId: 103, latitude: null, longitude: null }),
    ],
  });
  const bookedRoute = route();
  const before = JSON.stringify(bookedRoute);
  const suggestions = findRouteSuggestions({
    items: snapshot.items,
    routes: [bookedRoute],
    radiusKm: 10,
    now: new Date("2026-08-07T10:00:00.000Z"),
  });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.demandId, "ticket:101");
  assert.equal(suggestions[0]?.routeId, "route:1");
  assert.equal(suggestions[0]?.resourceId, 1);
  assert.equal(suggestions[0]?.method, "nearest-upcoming-stop");
  assert.ok((suggestions[0]?.distanceKm ?? 999) < 1);
  assert.equal(JSON.stringify(bookedRoute), before);
});

test("suggestions can use an engineer home base as the nearest point", () => {
  const snapshot = buildPlanningDemandSnapshot({
    ids,
    scopeDate: "2026-08-07",
    generatedAt: "2026-08-07T09:00:00.000Z",
    candidates: [candidate({ statusChangedAt: "2026-08-07T08:00:00.000Z" })],
  });
  const idleHome = route({
    base: {
      resourceId: 1,
      name: "Engineer One",
      base: "Salford",
      region: "North",
      latitude: 53.4805,
      longitude: -2.2405,
    },
    stops: [],
    coordinates: [[53.4805, -2.2405]],
  });
  const suggestions = findRouteSuggestions({
    items: snapshot.items,
    routes: [idleHome],
    radiusKm: 10,
    now: new Date("2026-08-07T10:00:00.000Z"),
  });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.method, "nearest-home-base");
  assert.equal(suggestions[0]?.stopCompany, "Salford");
  assert.ok((suggestions[0]?.distanceKm ?? 999) < 1);

  const nearerHome = findRouteSuggestions({
    items: snapshot.items,
    routes: [
      route({
        base: idleHome.base,
        stops: [
          {
            ...stop({
              id: "visit:far",
              companyName: "Distant Store",
              latitude: 53.8,
              longitude: -1.55,
            }),
            sequence: 1,
            inboundLegIndex: 0,
            isOutOfRange: false,
          },
        ],
      }),
    ],
    radiusKm: 80,
    now: new Date("2026-08-07T10:00:00.000Z"),
  });
  assert.equal(nearerHome[0]?.method, "nearest-home-base");
  assert.equal(nearerHome[0]?.stopCompany, "Salford");
});

test("suggestions exclude certification demand", () => {
  const snapshot = buildPlanningDemandSnapshot({
    ids,
    scopeDate: "2026-08-07",
    generatedAt: "2026-08-07T09:00:00.000Z",
    candidates: [
      candidate({
        companyLabel: "Engineer Certification",
        title: "Airport induction",
        statusChangedAt: "2026-08-07T08:00:00.000Z",
      }),
    ],
  });
  assert.equal(
    findRouteSuggestions({
      items: snapshot.items,
      routes: [route()],
      radiusKm: 10,
      now: new Date("2026-08-07T10:00:00.000Z"),
    }).length,
    0,
  );
});

test("territory grouping keeps Ireland and continental Europe distinct", () => {
  assert.equal(territoryGroupForLabel("Ireland", null), "Ireland");
  assert.equal(territoryGroupForLabel("Republic of Ireland", null), "Ireland");
  assert.equal(territoryGroupForLabel(null, "IE"), "Ireland");
  assert.equal(territoryGroupForLabel("Northern Ireland", "GB"), "North");
  assert.equal(territoryGroupForLabel("Sweden", null), "Northern Europe");
  assert.equal(territoryGroupForLabel("Poland", null), "Eastern Europe");
  assert.equal(territoryGroupForLabel("Spain", null), "Southern Europe");
  assert.equal(territoryGroupForLabel("Belgium", null), "Western Europe");
  assert.equal(territoryGroupForLabel(null, "NO"), "Northern Europe");
  assert.equal(territoryGroupForLabel(null, "CZ"), "Eastern Europe");
  assert.equal(territoryGroupForLabel(null, "IT"), "Southern Europe");
  assert.equal(territoryGroupForLabel(null, "FR"), "Western Europe");
  assert.equal(territoryGroupForLabel("Europe", null), "Other");
});

test("country code overrides stale territory labels", () => {
  assert.equal(territoryGroupForLabel("Europe", "BE"), "Western Europe");
  assert.equal(territoryGroupForLabel("South East", "FR"), "Western Europe");
  assert.equal(territoryGroupForLabel("Scotland", "IE"), "Ireland");
  assert.equal(territoryGroupForLabel("South East", "US"), "Other");
  assert.equal(territoryGroupForLabel("Yorkshire", "GB"), "North");
  assert.equal(territoryGroupForLabel("West Midlands", "GB"), "Midlands");
  assert.equal(territoryGroupForLabel("London", "GB"), "South");
});

test("demand maps onto the fixed route filter regions", () => {
  const demand = (
    territoryGroup: PlanningDemandItem["territoryGroup"],
    routeRegion: PlanningDemandItem["routeRegion"] = null,
  ) => ({ territoryGroup, routeRegion });

  assert.equal(filterRegionForDemand(demand("North")), "North");
  assert.equal(filterRegionForDemand(demand("Midlands")), "Midlands");
  assert.equal(filterRegionForDemand(demand("South")), "South");
  assert.equal(filterRegionForDemand(demand("Ireland")), "Ireland");
  assert.equal(filterRegionForDemand(demand("Northern Europe")), "EU");
  assert.equal(filterRegionForDemand(demand("Eastern Europe")), "EU");
  assert.equal(filterRegionForDemand(demand("Southern Europe")), "EU");
  assert.equal(filterRegionForDemand(demand("Western Europe")), "EU");
  assert.equal(filterRegionForDemand(demand("Western Europe", null)), "EU");
  assert.equal(filterRegionForDemand(demand("Ireland", null)), "Ireland");
  assert.equal(filterRegionForDemand(demand("Other", "South")), "South");
  assert.equal(filterRegionForDemand(demand("Other", null)), null);
});

test("the route filter always offers every region in a stable order", () => {
  assert.deepEqual(
    [...routeFilterRegions],
    ["North", "Midlands", "South", "EU", "Ireland"],
  );
});

test("operational IDs trim input, deduplicate sets and accept safe integer boundaries", () => {
  const configured = operationalIdsConfiguration({
    ...environment,
    AUTOTASK_SUPPORT_QUEUE_IDS: " 1, 2, 1 ",
    AUTOTASK_READY_TO_BOOK_STATUS_ID: " 9007199254740991 ",
  });
  assert.deepEqual([...configured.supportQueueIds], [1, 2]);
  assert.equal(configured.readyToBook.statusId, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(configured.planningDemandStatusIds, [401, 402, 403, 404, 405, 501, 502, 601, 602]);
});

test("every operational ID setting rejects missing, empty and malformed values by variable name", () => {
  for (const name of Object.keys(environment)) {
    for (const value of [undefined, "", " ", "abc", "1.5", "0", "-1", "9007199254740992", "1e2", "0x10", "1,,2", "1,", ",1"]) {
      assert.throws(
        () => operationalIdsConfiguration({ ...environment, [name]: value }),
        (error: unknown) => error instanceof Error && error.message.includes(name),
        `${name}: ${value}`,
      );
    }
    if (name.includes("READY_TO_BOOK")) {
      assert.throws(() => operationalIdsConfiguration({ ...environment, [name]: "1,2" }), new RegExp(name));
    }
  }
});

test("web configuration needs only the two ready-to-book settings", () => {
  assert.deepEqual(readyToBookConfiguration({
    AUTOTASK_READY_TO_BOOK_QUEUE_ID: " 701 ",
    AUTOTASK_READY_TO_BOOK_STATUS_ID: " 801 ",
  }), { queueId: 701, statusId: 801 });
  assert.throws(() => readyToBookConfiguration({}), /AUTOTASK_READY_TO_BOOK_QUEUE_ID/);
  assert.throws(() => readyToBookConfiguration({ AUTOTASK_READY_TO_BOOK_QUEUE_ID: "701" }), /AUTOTASK_READY_TO_BOOK_STATUS_ID/);
});
