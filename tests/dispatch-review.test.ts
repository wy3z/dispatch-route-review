import assert from "node:assert/strict";
import test from "node:test";
import {
  adjacentReviewDate,
  buildRouteDayOverview,
  buildUnbookedEngineerRoutes,
  groupReviewRoutes,
  isPrimaryRouteSummary,
  issueCountsForRoutes,
  issueSeveritiesByVisit,
  projectVisibleRoutes,
  resolveRequestedReviewDate,
  resolveReviewRoutes,
  reviewDayStats,
  reviewRegionCounts,
  routeCardHomeLegs,
  sortReviewRoutes,
  suggestionContextsForRoutes,
  thirdPartyScheduledVisitCount,
} from "../modules/dispatch/model/review";
import { scheduledVisitStatusCounts } from "../modules/work/schedule/counts";
import { londonCalendarDate } from "../shared/calendar";
import {
  dispatchTimelineBounds,
  hasTravelConflictIssue,
  minutesOnReviewDate,
  timelineLabel,
  timelineStyle,
} from "../modules/dispatch/model/timeline";
import type { EngineerRoute, RoadRoute } from "../modules/routing/contracts";
import type { ScheduledVisit } from "../modules/work/contracts";
import { projectScheduleSnapshot } from "../modules/work/schedule/projection";

const STANDARD_ENGINEER_DAY_MINUTES = 8 * 60;

function visit(
  id: string,
  sequence: number,
  overrides: Partial<ScheduledVisit> = {},
): EngineerRoute["stops"][number] {
  return {
    id,
    serviceCallId: sequence,
    ticketId: sequence,
    ticketNumber: `T${sequence}`,
    title: `Visit ${sequence}`,
    autotaskUrl: null,
    companyName: `Company ${sequence}`,
    locationName: "Site",
    address: "",
    city: "London",
    postcode: "SW1A 1AA",
    resourceId: 77,
    resourceName: "Engineer",
    routeOwnerKey: "77",
    ownerType: "internal",
    ticketStatusId: 1,
    ticketStatusLabel: "Booked",
    queueId: 10,
    queueLabel: "Support",
    jobType: "support",
    ignoredResourceCount: 0,
    startDateTime: `2026-08-10T${String(7 + sequence).padStart(2, "0")}:00:00.000Z`,
    endDateTime: `2026-08-10T${String(8 + sequence).padStart(2, "0")}:00:00.000Z`,
    durationMinutes: 60,
    status: 1,
    isComplete: false,
    latitude: 51.5 + sequence / 100,
    longitude: -0.1,
    additionalTicketCount: 0,
    sequence,
    inboundLegIndex: sequence - 1,
    isOutOfRange: false,
    ...overrides,
  };
}

function route(): EngineerRoute {
  return {
    id: "77",
    resourceId: 77,
    resourceName: "Engineer",
    base: null,
    colour: "#3366CC",
    stops: [
      visit("open-1", 1),
      visit("complete-2", 2, { isComplete: true }),
      visit("open-3", 3),
    ],
    coordinates: [
      [51.51, -0.1],
      [51.52, -0.1],
      [51.53, -0.1],
    ],
    returnLegIndex: null,
  };
}

function routedEngineer(): EngineerRoute {
  return {
    ...route(),
    base: {
      resourceId: 77,
      name: "Engineer",
      base: "London",
      region: "South",
      latitude: 51.5,
      longitude: -0.1,
    },
    returnLegIndex: 3,
  };
}

test("Dispatch Review resolves URL dates through the strict London calendar boundary", () => {
  const fallback = londonCalendarDate(new Date("2026-07-01T23:30:00.000Z"));
  assert.equal(fallback, "2026-07-02");
  assert.equal(resolveRequestedReviewDate("2026-02-30", fallback), fallback);
  assert.equal(resolveRequestedReviewDate("2026-2-28", fallback), fallback);
  assert.equal(resolveRequestedReviewDate("2028-02-29", fallback), "2028-02-29");
});

test("Dispatch Review date movement crosses month and year boundaries", () => {
  assert.equal(adjacentReviewDate("2026-03-01", "previous"), "2026-02-28");
  assert.equal(adjacentReviewDate("2026-12-31", "next"), "2027-01-01");
  assert.equal(adjacentReviewDate("2028-02-28", "next"), "2028-02-29");
});

test("schedule status selectors count service calls and third-party work canonically", () => {
  const visits = [
    visit("shared-open-a", 1, { serviceCallId: 100, isComplete: false }),
    visit("shared-open-b", 2, { serviceCallId: 100, isComplete: false }),
    visit("complete", 3, { serviceCallId: 200, isComplete: true }),
    visit("third-party", 4, {
      serviceCallId: 300,
      ownerType: "third-party",
    }),
  ];

  assert.deepEqual(scheduledVisitStatusCounts(visits), {
    all: 3,
    open: 2,
    complete: 1,
  });
  assert.equal(thirdPartyScheduledVisitCount(visits), 1);
});

test("presentation filters preserve canonical route sequence and road leg identity", () => {
  const canonical = route();
  const [visible] = projectVisibleRoutes([canonical], {
    showOpenVisits: true,
    showCompleteVisits: false,
    showThirdParty: true,
  });

  assert.deepEqual(
    visible.stops.map((stop) => [stop.id, stop.sequence, stop.inboundLegIndex]),
    [
      ["open-1", 1, 0],
      ["open-3", 3, 2],
    ],
  );
  assert.deepEqual(visible.coordinates, canonical.coordinates);
  assert.equal(canonical.stops.length, 3, "canonical route is not mutated");
});

test("a focused visit remains visible as a selected exception to filters", () => {
  const canonical = route();
  const projected = projectVisibleRoutes([canonical], {
    showOpenVisits: true,
    showCompleteVisits: false,
    showThirdParty: true,
  });
  const result = resolveReviewRoutes({
    canonicalRoutes: [canonical],
    projectedRoutes: projected,
    visibleRoutes: projected,
    selectedRouteId: canonical.id,
    selectedVisitId: "complete-2",
  });

  assert.equal(result.focusedOutsideFilters, true);
  assert.deepEqual(
    result.routes[0].stops.map((stop) => stop.id),
    ["open-1", "complete-2", "open-3"],
  );
  assert.equal(canonical.stops.length, 3, "canonical route is not mutated");
});

test("review projections calculate region, issue, suggestion and route-list facts", () => {
  const booked = routedEngineer();
  const bookedEngineer = {
    ...booked.base!,
    id: "00000000-0000-4000-8000-000000000077",
    resourceId: 77,
    colourIndex: 1,
    active: true,
    workingDays: [1, 2, 3, 4, 5],
    workdayStart: "09:00",
    workdayEnd: "17:00",
  };
  const idleEngineer = {
    id: "00000000-0000-4000-8000-000000000088",
    resourceId: 88,
    name: "Idle Engineer",
    base: "Manchester",
    region: "North" as const,
    latitude: 53.48,
    longitude: -2.24,
    colourIndex: 2,
    active: true,
    workingDays: [1, 2, 3, 4, 5],
    workdayStart: "09:00",
    workdayEnd: "17:00",
  };
  const demand = {
    requestType: "requested",
    routeRegion: "North",
  } as Parameters<typeof reviewRegionCounts>[0]["demandItems"][number];
  const counts = reviewRegionCounts({
    canonicalRoutes: [booked],
    engineers: [bookedEngineer, idleEngineer],
    demandItems: [demand],
  });
  assert.deepEqual(counts.get("South"), { booked: 1, engineers: 1, unbooked: 0 });
  assert.deepEqual(counts.get("North"), { booked: 0, engineers: 1, unbooked: 1 });

  const homes = buildUnbookedEngineerRoutes({
    canonicalRoutes: [booked],
    engineers: [bookedEngineer, idleEngineer],
    selectedRegions: new Set(["North"]),
  });
  assert.equal(homes.length, 1);
  assert.equal(homes[0].id, "unbooked-engineer-88");
  assert.deepEqual(homes[0].coordinates, [[53.48, -2.24]]);

  const issues = [
    { id: "warning", kind: "tight-travel", routeId: booked.id, resourceId: 77, resourceName: "Engineer", visitId: "open-1", severity: "warning", title: "Warning", detail: "Warning" },
    { id: "critical", kind: "insufficient-travel", routeId: booked.id, resourceId: 77, resourceName: "Engineer", visitId: "open-1", severity: "critical", title: "Critical", detail: "Critical" },
  ] as Parameters<typeof issueCountsForRoutes>[0];
  assert.deepEqual(issueCountsForRoutes(issues).get(booked.id), { total: 2, critical: 1 });
  assert.deepEqual(issueSeveritiesByVisit(issues), { "open-1": "critical" });

  const second = { ...booked, id: "88", resourceName: "Z Fixture Engineer" };
  const issueCounts = issueCountsForRoutes(issues);
  assert.deepEqual(sortReviewRoutes([second, booked], "issues", issueCounts).map((item) => item.id), [booked.id, second.id]);
  assert.equal(groupReviewRoutes([booked, second]).length, 1);

  const contexts = suggestionContextsForRoutes([booked], [{
    id: "suggestion:1", method: "nearest-upcoming-stop", demandId: "demand:1",
    routeId: booked.id, resourceId: 77, resourceName: booked.resourceName,
    stopId: "open-1", stopCompany: "Company", stopStartDateTime: "2026-08-10T08:00:00.000Z",
    distanceKm: 2,
  }]);
  assert.equal(contexts["demand:1"].routeColour, booked.colour);
  assert.equal(contexts["demand:1"].stopId, "open-1");
});

test("rail day overview derives start, finish, travel and home legs", () => {
  const canonical = routedEngineer();
  const road: RoadRoute = {
    id: canonical.id,
    legDurationsMinutes: [33, 72, 40, 38],
    totalDurationMinutes: 183,
  };
  const overview = buildRouteDayOverview({
    route: canonical,
    canonicalRoute: canonical,
    road,
  });

  assert.deepEqual(
    overview.map((item) => item.type),
    ["home", "travel", "stop", "travel", "stop", "travel", "stop", "travel", "home"],
  );
  const start = overview[0];
  const firstTravel = overview[1];
  const returnTravel = overview.at(-2);
  const end = overview.at(-1);
  assert.equal(start?.type, "home");
  if (start?.type === "home") {
    assert.equal(start.role, "start");
    assert.equal(start.baseLabel, "London");
    assert.equal(start.time, "2026-08-10T07:27:00.000Z");
  }
  assert.equal(firstTravel?.type, "travel");
  if (firstTravel?.type === "travel") assert.equal(firstTravel.minutes, 33);
  assert.equal(returnTravel?.type, "travel");
  if (returnTravel?.type === "travel") {
    assert.equal(returnTravel.destination, "home");
    assert.equal(returnTravel.minutes, 38);
  }
  assert.equal(end?.type, "home");
  if (end?.type === "home") {
    assert.equal(end.role, "return");
    assert.equal(end.time, "2026-08-10T11:38:00.000Z");
  }

  const midRoute = buildRouteDayOverview({
    route: { ...canonical, stops: [canonical.stops[1]] },
    canonicalRoute: canonical,
    road,
  });
  assert.deepEqual(midRoute.map((item) => item.type), ["stop"]);
});

test("review day stats cover required work and average inter-visit travel", () => {
  const booked = routedEngineer();
  const road: RoadRoute = {
    id: booked.id,
    legDurationsMinutes: [33, 24, 18, 40],
    totalDurationMinutes: 115,
  };
  const stats = reviewDayStats({
    routes: [booked],
    roadRoutes: [road],
    unassignedRequiredCount: 1,
    engineerCapacityMinutes: STANDARD_ENGINEER_DAY_MINUTES,
  });

  assert.equal(stats.coveragePercent, 75);
  assert.equal(
    stats.capacityMinutes,
    STANDARD_ENGINEER_DAY_MINUTES - 180 - 115,
  );
  assert.equal(stats.avgDriveMinutes, 21);
  assert.equal(
    reviewDayStats({
      routes: [],
      roadRoutes: [],
      unassignedRequiredCount: 0,
      engineerCapacityMinutes: 0,
    }).coveragePercent,
    null,
  );
  assert.equal(
    reviewDayStats({
      routes: [booked],
      roadRoutes: [{ id: booked.id }],
      unassignedRequiredCount: 1,
      engineerCapacityMinutes: STANDARD_ENGINEER_DAY_MINUTES,
    }).avgDriveMinutes,
    null,
  );
});

test("route cards show home legs only at canonical journey boundaries", () => {
  const canonical = routedEngineer();
  assert.deepEqual(routeCardHomeLegs(canonical, canonical), {
    showStartHome: true,
    showReturnHome: true,
  });
  assert.deepEqual(
    routeCardHomeLegs({ ...canonical, stops: [canonical.stops[1]] }, canonical),
    { showStartHome: false, showReturnHome: false },
  );
  assert.deepEqual(
    routeCardHomeLegs({ ...canonical, stops: [canonical.stops[0]] }, canonical),
    { showStartHome: true, showReturnHome: false },
  );
  assert.deepEqual(
    routeCardHomeLegs({ ...canonical, stops: [canonical.stops.at(-1)!] }, canonical),
    { showStartHome: false, showReturnHome: true },
  );
});

test("only recognised internal road journeys receive primary engineer summaries", () => {
  const routed = routedEngineer();
  assert.equal(isPrimaryRouteSummary(routed), true);
  assert.equal(
    isPrimaryRouteSummary({
      ...routed,
      stops: routed.stops.map((stop) => ({ ...stop, isOutOfRange: true })),
    }),
    false,
  );
  assert.equal(
    isPrimaryRouteSummary({
      ...routed,
      stops: routed.stops.map((stop) => ({
        ...stop,
        ownerType: "third-party",
      })),
    }),
    false,
  );
  assert.equal(isPrimaryRouteSummary({ ...routed, resourceId: null }), false);
});

test("timeline helpers use London calendar days and label cross-midnight work", () => {
  assert.equal(
    minutesOnReviewDate("2026-08-09T23:30:00.000Z", "2026-08-10"),
    30,
  );
  assert.equal(timelineLabel(-60), "-1d 23:00");
  assert.equal(timelineLabel(24 * 60 + 60), "+1d 01:00");
  assert.deepEqual(
    timelineStyle(9 * 60, 60, { start: 8 * 60, end: 12 * 60 }),
    { left: "25%", width: "25%" },
  );
});

test("timeline bounds include booked service and known travel", () => {
  const booked = route();
  const road: RoadRoute = {
    id: booked.id,
    legDurationsMinutes: [30, 20, 10],
  };
  const bounds = dispatchTimelineBounds("2026-08-10", [booked], [road]);
  assert.ok(bounds.start <= 8 * 60 + 30);
  assert.ok(bounds.end >= 11 * 60);
  assert.ok(bounds.hours.length >= 5);
});

test("timeline conflict styling is driven by canonical issue kinds", () => {
  assert.equal(hasTravelConflictIssue([{ kind: "insufficient-travel" }]), true);
  assert.equal(hasTravelConflictIssue([{ kind: "booking-overlap" }]), true);
  assert.equal(hasTravelConflictIssue([{ kind: "tight-travel" }]), false);
  assert.equal(hasTravelConflictIssue([{ kind: "missing-location" }]), false);
});

test("legacy cached schedule fields are stripped at the browser boundary", () => {
  const legacyVisit = {
    ...visit("legacy", 1),
    description: "sensitive service-call body",
    contactEmail: "person@example.test",
    userDefinedFields: [{ name: "Private field", value: "private value" }],
  };
  const projected = projectScheduleSnapshot({
    source: "autotask",
    date: "2026-08-10",
    generatedAt: "2026-08-09T12:00:00.000Z",
    visits: [legacyVisit],
    warnings: [],
  });

  assert.equal("description" in projected.visits[0], false);
  assert.equal("contactEmail" in projected.visits[0], false);
  assert.equal("userDefinedFields" in projected.visits[0], false);
  assert.equal(projected.visits[0].thirdPartyCompany, null);
});

test("schedule projection resolves configured ticket links without reviving explicit nulls", () => {
  const input = {
    source: "autotask" as const, date: "2026-08-10", generatedAt: "2026-08-09T12:00:00.000Z", warnings: [],
    visits: [visit("worker", 1, { autotaskUrl: undefined }), visit("demo", 2),
      visit("legacy", 3, { autotaskUrl: "https://old.example.test/ticket" }), visit("invalid", 4, { ticketId: null, autotaskUrl: undefined })],
  };
  assert.deepEqual(projectScheduleSnapshot(input, "https://tickets.example.test").visits.map((item) => item.autotaskUrl), [
    "https://tickets.example.test/Mvc/ServiceDesk/TicketDetail.mvc?ticketId=1", null,
    "https://tickets.example.test/Mvc/ServiceDesk/TicketDetail.mvc?ticketId=3", null,
  ]);
  assert.ok(projectScheduleSnapshot(input).visits.every((item) => item.autotaskUrl === null));
  assert.equal(input.visits[0].autotaskUrl, undefined);
});
