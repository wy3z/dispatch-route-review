import assert from "node:assert/strict";
import test from "node:test";
import { buildEngineerRoutes as buildRoutes } from "../modules/routing/route-builder";
import { findRouteIssues } from "../modules/routing/issues";
import { compareRouteRegions, routeRegion } from "../modules/dispatch/model/regions";
import type { RouteRegion } from "../modules/dispatch/model/regions";
import { findEngineerBase as findBase } from "../modules/engineers/model";
import type { EngineerBase } from "../modules/engineers/contracts";
import type { ScheduledVisit } from "../modules/work/contracts";
import {
  formatServiceCallDate,
  joinServiceCallAddress,
  ownerTypeLabel,
} from "../modules/dispatch/ui/service-call-detail-helpers";
import { jobTypeLabel } from "../modules/work/presentation";

const engineerBases: EngineerBase[] = [
  {
    resourceId: 101,
    name: "Primary Engineer",
    base: "Midlands Base",
    region: "Midlands",
    latitude: 52.32,
    longitude: -1.91,
  },
  {
    resourceId: 102,
    name: "Secondary Engineer",
    base: "East Midlands Base",
    region: "Midlands",
    latitude: 52.64,
    longitude: -1.16,
  },
  {
    resourceId: 103,
    name: "Remote Midlands Engineer",
    base: "West Midlands Base",
    region: "Midlands",
    latitude: 52.12,
    longitude: -2.08,
  },
  {
    resourceId: 104,
    name: "North Engineer",
    base: "North Base",
    region: "North",
    latitude: 53.56,
    longitude: -2.65,
  },
  {
    resourceId: 105,
    name: "Second North Engineer",
    base: "Coastal North Base",
    region: "North",
    latitude: 53.8,
    longitude: -3.04,
  },
  {
    resourceId: 106,
    name: "Ireland Engineer",
    base: "Ireland Base",
    region: "Ireland",
    latitude: 54.53,
    longitude: -6.05,
  },
];

function buildEngineerRoutes(visits: ScheduledVisit[]) {
  return buildRoutes(visits, engineerBases);
}

function findEngineerBase(resourceId: number | null, name?: string) {
  return findBase(engineerBases, resourceId, name);
}

function visit(overrides: Partial<ScheduledVisit> = {}): ScheduledVisit {
  return {
    id: "visit-1",
    serviceCallId: 1,
    ticketId: 1,
    ticketNumber: "T20260001.0001",
    title: "Reboot player",
    autotaskUrl: null,
    companyName: "Example Company",
    locationName: "Example Site",
    address: "1 Example Street",
    city: "Example City",
    postcode: "AB1 2CD",
    resourceId: 101,
    resourceName: "Primary Engineer",
    routeOwnerKey: "internal:101",
    ownerType: "internal",
    ticketStatusId: 1,
    ticketStatusLabel: "Scheduled",
    queueId: 1,
    queueLabel: "Support",
    jobType: "support",
    ignoredResourceCount: 0,
    startDateTime: "2026-07-27T09:00:00.000Z",
    endDateTime: "2026-07-27T10:00:00.000Z",
    durationMinutes: 60,
    status: 1,
    isComplete: false,
    latitude: 52.12,
    longitude: -1.95,
    additionalTicketCount: 0,
    ...overrides,
  };
}

test("buildEngineerRoutes orders calls chronologically from and back to the engineer base", () => {
  const later = visit({
    id: "later",
    startDateTime: "2026-07-27T13:00:00.000Z",
    endDateTime: "2026-07-27T14:00:00.000Z",
    latitude: 52.2,
    longitude: -1.8,
  });
  const earlier = visit({
    id: "earlier",
    startDateTime: "2026-07-27T08:00:00.000Z",
    endDateTime: "2026-07-27T09:00:00.000Z",
    latitude: 52.1,
    longitude: -1.9,
  });

  const [route] = buildEngineerRoutes([later, earlier]);

  assert.equal(route.resourceName, "Primary Engineer");
  assert.equal(route.base?.base, "Midlands Base");
  assert.deepEqual(
    route.stops.map(({ id, sequence, inboundLegIndex }) => ({
      id,
      sequence,
      inboundLegIndex,
    })),
    [
      { id: "earlier", sequence: 1, inboundLegIndex: 0 },
      { id: "later", sequence: 2, inboundLegIndex: 1 },
    ],
  );
  assert.deepEqual(route.coordinates, [
    [52.32, -1.91],
    [52.1, -1.9],
    [52.2, -1.8],
    [52.32, -1.91],
  ]);
  assert.equal(route.returnLegIndex, 2);
});

test("route colours stay stable when the visible route set changes", () => {
  const primary = visit({ routeOwnerKey: "internal:101" });
  const anotherEngineer = visit({
    id: "another-engineer",
    resourceId: 102,
    resourceName: "Secondary Engineer",
    routeOwnerKey: "internal:102",
  });

  const allPrimaryRoute = buildEngineerRoutes([primary, anotherEngineer]).find(
    (route) => route.id === primary.routeOwnerKey,
  );
  const [filteredPrimaryRoute] = buildEngineerRoutes([primary]);

  assert.ok(allPrimaryRoute);
  assert.equal(filteredPrimaryRoute.colour, allPrimaryRoute.colour);
  assert.match(filteredPrimaryRoute.colour, /^#[\dA-F]{6}$/);

  const [ireland, north, thirdParty] = buildEngineerRoutes([
    visit({
      id: "ireland",
      resourceId: 106,
      resourceName: "Ireland Engineer",
      routeOwnerKey: "internal:106",
    }),
    visit({
      id: "north",
      resourceId: 105,
      resourceName: "Second North Engineer",
      routeOwnerKey: "internal:105",
    }),
    visit({
      id: "third-party",
      resourceId: null,
      resourceName: "Vendor Attending",
      routeOwnerKey: "third-party:vendor attending",
      ownerType: "third-party",
    }),
  ]).sort((first, second) => first.id.localeCompare(second.id));
  assert.equal(new Set([ireland.colour, north.colour, thirdParty.colour]).size, 3);
});

test("third-party and discontinuous routes do not invent road legs", () => {
  const [thirdPartyRoute] = buildEngineerRoutes([
    visit({
      ownerType: "third-party",
      resourceName: "Primary Engineer",
      routeOwnerKey: "third-party:vendor attending",
    }),
  ]);
  assert.deepEqual(thirdPartyRoute.coordinates, [[52.32, -1.91]]);
  assert.equal(thirdPartyRoute.stops[0]?.inboundLegIndex, null);
  assert.equal(thirdPartyRoute.returnLegIndex, null);

  const [interruptedRoute] = buildEngineerRoutes([
    visit({ id: "first" }),
    visit({
      id: "unmapped",
      startDateTime: "2026-07-27T11:00:00.000Z",
      endDateTime: "2026-07-27T12:00:00.000Z",
      latitude: null,
      longitude: null,
    }),
    visit({
      id: "after-gap",
      startDateTime: "2026-07-27T13:00:00.000Z",
      endDateTime: "2026-07-27T14:00:00.000Z",
    }),
  ]);
  assert.deepEqual(interruptedRoute.coordinates, [
    [52.32, -1.91],
    [52.12, -1.95],
  ]);
  assert.deepEqual(
    interruptedRoute.stops.map((stop) => stop.inboundLegIndex),
    [0, null, null],
  );
  assert.equal(interruptedRoute.returnLegIndex, null);
});

test("findRouteIssues ignores road legs under ten minutes", () => {
  const [route] = buildEngineerRoutes([
    visit({ id: "first", endDateTime: "2026-07-27T10:00:00.000Z" }),
    visit({
      id: "second",
      serviceCallId: 2,
      ticketId: 2,
      ticketNumber: "T20260001.0002",
      startDateTime: "2026-07-27T10:05:00.000Z",
      endDateTime: "2026-07-27T11:00:00.000Z",
    }),
  ]);

  const issues = findRouteIssues([route], [
    { id: route.id, legDurationsMinutes: [8, 9, 8] },
  ]);

  assert.equal(issues.some((issue) => issue.title === "Insufficient travel time"), false);
  assert.equal(issues.some((issue) => issue.title === "Tight travel margin"), false);
});

test("findRouteIssues treats service calls for one ticket as one job window", () => {
  const [route] = buildEngineerRoutes([
    visit({
      id: "first-service-call",
      serviceCallId: 1,
      startDateTime: "2026-07-27T09:00:00.000Z",
      endDateTime: "2026-07-27T10:00:00.000Z",
    }),
    visit({
      id: "second-service-call",
      serviceCallId: 2,
      startDateTime: "2026-07-27T09:00:00.000Z",
      endDateTime: "2026-07-27T10:00:00.000Z",
    }),
  ]);

  const issues = findRouteIssues([route], [
    { id: route.id, legDurationsMinutes: [8, 20, 8] },
  ]);

  assert.equal(
    issues.some(
      (issue) =>
        issue.kind === "booking-overlap" ||
        issue.kind === "insufficient-travel" ||
        issue.kind === "tight-travel",
    ),
    false,
  );
});

test("findRouteIssues flags insufficient travel and explains unmapped locations", () => {
  const [route] = buildEngineerRoutes([
    visit({ id: "first", endDateTime: "2026-07-27T10:00:00.000Z" }),
    visit({
      id: "second",
      serviceCallId: 2,
      ticketId: 2,
      ticketNumber: "T20260001.0002",
      startDateTime: "2026-07-27T10:05:00.000Z",
      endDateTime: "2026-07-27T11:00:00.000Z",
    }),
  ]);
  const travelIssues = findRouteIssues([route], [
    { id: route.id, legDurationsMinutes: [8, 10, 8] },
  ]);
  assert.deepEqual(
    travelIssues
      .filter((issue) => issue.title === "Insufficient travel time")
      .map((issue) => ({ visitId: issue.visitId, detail: issue.detail })),
    [
      {
        visitId: "second",
        detail: "10 minutes by road, but only 5 minutes are booked between visits.",
      },
    ],
  );

  const [unmappedRoute] = buildEngineerRoutes([
    visit({
      id: "no-postcode",
      latitude: null,
      longitude: null,
      postcode: "",
      city: "",
    }),
  ]);
  const locationIssues = findRouteIssues([unmappedRoute], []);
  const locationIssue = locationIssues.find(
    (issue) => issue.visitId === "no-postcode",
  );
  assert.equal(locationIssue?.title, "European location could not be mapped");
  assert.match(locationIssue?.detail ?? "", /Check the address, city, postcode and country in Autotask\./);
});

test("engineer regions have a stable operational order and safe fallbacks", () => {
  assert.equal(
    findEngineerBase(null, "North-Engineer")?.name,
    "North Engineer",
  );
  assert.deepEqual(findEngineerBase(null, "North Engineer"), {
    resourceId: 104,
    name: "North Engineer",
    base: "North Base",
    region: "North",
    latitude: 53.56,
    longitude: -2.65,
  });

  const [midlandsRoute] = buildEngineerRoutes([visit()]);
  const [thirdPartyRoute] = buildEngineerRoutes([
    visit({ ownerType: "third-party", routeOwnerKey: "third-party:vendor" }),
  ]);
  const [unassignedRoute] = buildEngineerRoutes([
    visit({
      resourceId: null,
      resourceName: "No assigned engineer",
      routeOwnerKey: "unassigned",
      ownerType: "unassigned",
    }),
  ]);

  assert.equal(routeRegion(midlandsRoute), "Midlands");
  assert.equal(routeRegion(thirdPartyRoute), "Third-party");
  assert.equal(routeRegion(unassignedRoute), "Unassigned");
  const regions: RouteRegion[] = [
    "Unassigned",
    "South",
    "Third-party",
    "North",
    "Midlands",
  ];
  assert.deepEqual(
    regions.sort(compareRouteRegions),
    ["North", "Midlands", "South", "Third-party", "Unassigned"],
  );
});

test("service-call detail helpers render the dispatch overlay copy", () => {
  const base = visit({
    address: " 1 Example Street ",
    city: " Example City ",
    postcode: " AB1 2CD ",
    ownerType: "internal",
  });
  assert.equal(
    joinServiceCallAddress(base),
    "1 Example Street, Example City, AB1 2CD",
  );
  assert.equal(
    joinServiceCallAddress({ ...base, address: "", city: "", postcode: "" }),
    "",
  );

  assert.equal(ownerTypeLabel("internal"), "Internal engineer");
  assert.equal(ownerTypeLabel("third-party"), "Third-party attendance");
  assert.equal(ownerTypeLabel("unassigned"), "Unassigned");
  assert.equal(jobTypeLabel("install"), "Install");
  assert.equal(jobTypeLabel("support"), "Support");
  assert.equal(jobTypeLabel("survey"), "Survey");
  assert.equal(jobTypeLabel("other", "Custom queue"), "Custom queue");

  const formatted = formatServiceCallDate("2026-07-27T09:00:00.000Z");
  assert.match(formatted, /Monday/);
  assert.match(formatted, /27 July 2026/);
});

test("an overseas stop stays visible but contributes no travel geometry", () => {
  // A continental stop is real work, but not a drivable UK day.
  const routes = buildEngineerRoutes([
    visit({
      id: "uk-1",
      resourceId: 103,
      resourceName: "Remote Midlands Engineer",
      routeOwnerKey: "internal:103",
      city: "Example City",
      latitude: 52.3,
      longitude: -1.94,
      startDateTime: "2026-08-10T08:00:00.000Z",
      endDateTime: "2026-08-10T09:00:00.000Z",
    }),
    visit({
      id: "se-1",
      resourceId: 103,
      resourceName: "Remote Midlands Engineer",
      routeOwnerKey: "internal:103",
      companyName: "Example Overseas Site",
      city: "Stockholm",
      postcode: "111 35",
      latitude: 59.34,
      longitude: 18.06,
      startDateTime: "2026-08-10T12:00:00.000Z",
      endDateTime: "2026-08-10T13:00:00.000Z",
    }),
  ]);

  assert.equal(routes.length, 1);
  const route = routes[0];

  // The stop is still listed — the audit shows what is actually booked.
  assert.equal(route.stops.length, 2);
  const stockholm = route.stops.find((stop) => stop.id === "se-1");
  const localStop = route.stops.find((stop) => stop.id === "uk-1");
  assert.ok(stockholm);
  assert.ok(localStop);

  // ...but it draws no travel and adds no coordinate.
  assert.equal(stockholm.isOutOfRange, true);
  assert.equal(stockholm.inboundLegIndex, null);
  assert.equal(localStop.isOutOfRange, false);
  assert.ok(
    route.coordinates.every(([, lon]) => lon < 10),
    "Stockholm must not appear in the route geometry or map bounds",
  );

  const issues = findRouteIssues(routes, []);
  const outOfRange = issues.find(
    (issue) => issue.title === "Booked outside the engineer's routing range",
  );
  assert.ok(outOfRange, "the suppressed stop must be surfaced as an issue");
  assert.equal(outOfRange.visitId, "se-1");
  assert.match(outOfRange.detail, /mi from West Midlands Base/);
  assert.match(outOfRange.detail, /travel to and from it is not calculated/i);
});

test("cross-border Irish routes stay fully routable", () => {
  // A route across the island is a normal day and must not be suppressed.
  const routes = buildEngineerRoutes([
    visit({
      id: "ni-1",
      resourceId: 106,
      resourceName: "Ireland Engineer",
      routeOwnerKey: "internal:106",
      city: "Northern Ireland Site",
      postcode: "BT1 1AA",
      latitude: 54.53,
      longitude: -6.05,
      startDateTime: "2026-08-10T08:00:00.000Z",
      endDateTime: "2026-08-10T09:00:00.000Z",
    }),
    visit({
      id: "ie-1",
      resourceId: 106,
      resourceName: "Ireland Engineer",
      routeOwnerKey: "internal:106",
      city: "Republic of Ireland Site",
      postcode: "R32 000",
      latitude: 53.03,
      longitude: -7.3,
      startDateTime: "2026-08-10T12:00:00.000Z",
      endDateTime: "2026-08-10T13:00:00.000Z",
    }),
  ]);

  const route = routes[0];
  assert.ok(route.stops.every((stop) => stop.isOutOfRange === false));
  assert.equal(route.base?.region, "Ireland");
  assert.equal(routeRegion(route), "Ireland");
});

test("Ireland is a first-class engineer region ordered after the mainland", () => {
  assert.equal(findEngineerBase(null, "Ireland Engineer")?.region, "Ireland");
  const order: RouteRegion[] = ["Ireland", "North", "Third-party"];
  assert.deepEqual(
    [...order].sort(compareRouteRegions),
    ["North", "Ireland", "Third-party"],
  );
});
