import assert from "node:assert/strict";
import test from "node:test";
import { reviewDayStats } from "../modules/dispatch/model/review";
import type { EngineerRoute, RoadRoute } from "../modules/routing/contracts";
import type { ScheduledVisit } from "../modules/work/contracts";

const ENGINEER_DAY_MINUTES = 8 * 60;

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
    startDateTime: `2026-08-20T${String(8 + sequence).padStart(2, "0")}:00:00.000Z`,
    endDateTime: `2026-08-20T${String(9 + sequence).padStart(2, "0")}:00:00.000Z`,
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

function internalRoute(): EngineerRoute {
  return {
    id: "77",
    resourceId: 77,
    resourceName: "Engineer",
    base: {
      resourceId: 77,
      name: "Engineer",
      base: "London",
      region: "South",
      latitude: 51.5,
      longitude: -0.1,
    },
    colour: "#3366CC",
    stops: [visit("visit-1", 1), visit("visit-2", 2)],
    coordinates: [
      [51.5, -0.1],
      [51.51, -0.1],
      [51.52, -0.1],
      [51.5, -0.1],
    ],
    returnLegIndex: 2,
  };
}

function capacityFor(route: EngineerRoute, roadRoutes: RoadRoute[]) {
  return reviewDayStats({
    routes: [route],
    roadRoutes,
    unassignedRequiredCount: 0,
    engineerCapacityMinutes: ENGINEER_DAY_MINUTES,
  }).capacityMinutes;
}

test("remaining capacity is unknown while a required road route is unavailable", () => {
  const route = internalRoute();

  assert.equal(capacityFor(route, []), null, "routing still loading or absent");
  assert.equal(
    capacityFor(route, [{ id: route.id, error: "Route service unavailable" }]),
    null,
    "route-level routing failure",
  );
  assert.equal(
    capacityFor(route, [{
      id: route.id,
      legDurationsMinutes: [30, null, 25],
      legErrors: [null, "No route", null],
    }]),
    null,
    "partial leg failure",
  );
  assert.equal(
    capacityFor({ ...route, base: null }, [{
      id: route.id,
      legDurationsMinutes: [30, 20, 25],
    }]),
    null,
    "missing home leg",
  );
});

test("remaining capacity uses travel only when every required leg is known", () => {
  const route = internalRoute();
  const road: RoadRoute = {
    id: route.id,
    legDurationsMinutes: [30, 20, 25],
    totalDurationMinutes: 75,
  };

  assert.equal(
    capacityFor(route, [road]),
    ENGINEER_DAY_MINUTES - 120 - 75,
  );
});

test("an idle review scope has known zero travel", () => {
  const stats = reviewDayStats({
    routes: [],
    roadRoutes: [],
    unassignedRequiredCount: 0,
    engineerCapacityMinutes: ENGINEER_DAY_MINUTES,
  });

  assert.equal(stats.capacityMinutes, ENGINEER_DAY_MINUTES);
});
