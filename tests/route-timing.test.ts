import assert from "node:assert/strict";
import test from "node:test";
import { routeTimingForLeg, routeTimingForStop } from "../modules/routing/timing";
import type { EngineerRoute, RoadRoute, RouteStop } from "../modules/routing/contracts";
import type { ScheduledVisit } from "../modules/work/contracts";

function stop(
  id: string,
  startDateTime: string,
  endDateTime: string,
  inboundLegIndex: number | null,
): RouteStop {
  const visit: ScheduledVisit = {
    id,
    serviceCallId: Number(id.replace(/\D/g, "")) || 1,
    ticketId: 1,
    ticketNumber: "T20260001.0001",
    title: "Service visit",
    autotaskUrl: null,
    companyName: "Example Company",
    locationName: "Example Site",
    address: "1 Example Street",
    city: "Manchester",
    postcode: "M1 1AE",
    resourceId: 1,
    resourceName: "Engineer",
    routeOwnerKey: "1",
    ownerType: "internal",
    ticketStatusId: 1,
    ticketStatusLabel: "Scheduled",
    queueId: 1,
    queueLabel: "Support",
    jobType: "support",
    ignoredResourceCount: 0,
    startDateTime,
    endDateTime,
    durationMinutes: 60,
    status: 1,
    isComplete: false,
    latitude: 52,
    longitude: -1,
    additionalTicketCount: 0,
  };
  return { ...visit, sequence: inboundLegIndex === null ? 1 : inboundLegIndex + 1, inboundLegIndex, isOutOfRange: false };
}

function route(overrides: Partial<EngineerRoute> = {}): EngineerRoute {
  const first = stop("first", "2026-01-15T09:00:00.000Z", "2026-01-15T10:00:00.000Z", 0);
  const second = stop("second", "2026-01-15T11:00:00.000Z", "2026-01-15T12:00:00.000Z", 1);
  return {
    id: "engineer-1",
    resourceId: 1,
    resourceName: "Engineer",
    base: null,
    colour: "#2563A9",
    stops: [first, second],
    coordinates: [],
    returnLegIndex: 2,
    ...overrides,
  };
}

function road(overrides: Partial<RoadRoute> = {}): RoadRoute {
  return {
    id: "engineer-1",
    legDurationsMinutes: [30, 45, 35],
    ...overrides,
  };
}

test("inbound home timing is a static leave-by estimate anchored to booked arrival", () => {
  const timing = routeTimingForLeg(route(), road(), 0);
  assert.deepEqual(timing, {
    availability: "available",
    kind: "inbound",
    legIndex: 0,
    durationMinutes: 30,
    destinationStopId: "first",
    bookedArrivalDateTime: "2026-01-15T09:00:00.000Z",
    estimatedTravelStartDateTime: "2026-01-15T08:30:00.000Z",
    source: "home",
  });
});

test("inter-visit timing reports booked arrival, earliest static arrival, and margin", () => {
  const timing = routeTimingForLeg(route(), road(), 1);
  assert.deepEqual(timing, {
    availability: "available",
    kind: "inbound",
    legIndex: 1,
    durationMinutes: 45,
    destinationStopId: "second",
    bookedArrivalDateTime: "2026-01-15T11:00:00.000Z",
    estimatedTravelStartDateTime: "2026-01-15T10:15:00.000Z",
    source: "previous-booked-visit",
    previousStopId: "first",
    previousBookedEndDateTime: "2026-01-15T10:00:00.000Z",
    earliestArrivalDateTime: "2026-01-15T10:45:00.000Z",
    marginMinutes: 15,
  });
});

test("inter-visit timing preserves a negative margin for an impossible booked sequence", () => {
  const timing = routeTimingForLeg(route(), road({ legDurationsMinutes: [30, 75, 35] }), 1);
  assert.equal(timing.availability, "available");
  assert.equal(timing.kind, "inbound");
  if (timing.kind !== "inbound") return;
  assert.equal(timing.earliestArrivalDateTime, "2026-01-15T11:15:00.000Z");
  assert.equal(timing.marginMinutes, -15);
});

test("return timing starts at the last booked end and is only a static estimate", () => {
  const timing = routeTimingForLeg(route(), road(), 2);
  assert.deepEqual(timing, {
    availability: "available",
    kind: "return",
    legIndex: 2,
    durationMinutes: 35,
    sourceStopId: "second",
    sourceBookedEndDateTime: "2026-01-15T12:00:00.000Z",
    estimatedTravelStartDateTime: "2026-01-15T12:00:00.000Z",
    estimatedArrivalDateTime: "2026-01-15T12:35:00.000Z",
  });
});

test("unavailable road and discontinuous stops produce explicit unavailable states", () => {
  assert.deepEqual(routeTimingForLeg(route(), undefined, 1), {
    availability: "unavailable",
    kind: "inbound",
    legIndex: 1,
    reason: "road-route-unavailable",
  });
  assert.deepEqual(routeTimingForLeg(route(), road({ legDurationsMinutes: [30, null, 35] }), 1), {
    availability: "unavailable",
    kind: "inbound",
    legIndex: 1,
    reason: "road-duration-unavailable",
  });
  assert.deepEqual(routeTimingForStop(route(), road(), { inboundLegIndex: null }), {
    availability: "unavailable",
    kind: "inbound",
    legIndex: -1,
    reason: "inbound-destination-unavailable",
  });
});

test("ISO arithmetic remains correct across the London spring DST transition", () => {
  const first = stop("first", "2026-03-29T00:30:00.000Z", "2026-03-29T01:30:00.000Z", 0);
  const second = stop("second", "2026-03-29T03:00:00.000Z", "2026-03-29T04:00:00.000Z", 1);
  const timing = routeTimingForLeg(route({ stops: [first, second] }), road({ legDurationsMinutes: [30, 45, 35] }), 1);
  assert.equal(timing.availability, "available");
  assert.equal(timing.kind, "inbound");
  if (timing.kind !== "inbound") return;
  assert.equal(timing.estimatedTravelStartDateTime, "2026-03-29T02:15:00.000Z");
  assert.equal(timing.earliestArrivalDateTime, "2026-03-29T02:15:00.000Z");
  assert.equal(timing.marginMinutes, 45);
});
