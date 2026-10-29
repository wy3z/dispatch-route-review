import assert from "node:assert/strict";
import test from "node:test";
import { engineerWorkingMinutesForDate } from "../modules/engineers/model";
import type { PlanningDemandItem } from "../modules/work/demand/model";
import {
  findRouteSuggestions,
  resolveRouteSuggestionContext,
} from "../modules/routing/suggestions";
import type { EngineerRosterEntry } from "../modules/engineers/contracts";
import type { EngineerRoute, RouteStop } from "../modules/routing/contracts";

const weekdayEngineer: EngineerRosterEntry = {
  id: "00000000-0000-4000-8000-000000000007",
  resourceId: 7,
  name: "Weekday Engineer",
  base: "Manchester",
  region: "North",
  latitude: 53.4808,
  longitude: -2.2426,
  colourIndex: 1,
  active: true,
  workingDays: [1, 2, 3, 4, 5],
  workdayStart: "09:00",
  workdayEnd: "17:00",
};

function demand(overrides: Partial<PlanningDemandItem> = {}): PlanningDemandItem {
  return {
    id: "ticket:101",
    ticketId: 101,
    ticketNumber: "T20260101",
    title: "Replace player",
    companyLabel: "Nearby Store",
    siteLabel: "Manchester",
    city: "Manchester",
    postcode: "M1 1AA",
    latitude: 53.481,
    longitude: -2.242,
    durationMinutes: 60,
    durationSource: "estimated",
    routeRegion: "North",
    logisticsTerritory: "North West",
    countryCode: "GB",
    territoryGroup: "North",
    queueId: 1,
    queueLabel: "Support",
    statusId: 1,
    statusLabel: "Unassigned request",
    workstream: "support",
    requestType: "requested",
    statusChangedAt: "2026-08-20T08:00:00.000Z",
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

function stop(overrides: Partial<RouteStop> = {}): RouteStop {
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
    resourceId: 7,
    resourceName: weekdayEngineer.name,
    routeOwnerKey: "resource:7",
    ownerType: "internal",
    ticketStatusId: 1,
    ticketStatusLabel: "Engineer Attending",
    queueId: 1,
    queueLabel: "Support",
    jobType: "support",
    ignoredResourceCount: 0,
    startDateTime: "2026-08-20T10:00:00.000Z",
    endDateTime: "2026-08-20T11:00:00.000Z",
    durationMinutes: 60,
    status: 1,
    isComplete: false,
    latitude: 53.4811,
    longitude: -2.2421,
    additionalTicketCount: 0,
    sequence: 1,
    inboundLegIndex: 0,
    isOutOfRange: false,
    ...overrides,
  };
}

function route(
  engineer: EngineerRosterEntry = weekdayEngineer,
  stops: RouteStop[] = [],
): EngineerRoute {
  return {
    id: `route:${engineer.resourceId}`,
    resourceId: engineer.resourceId,
    resourceName: engineer.name,
    base: engineer,
    colourIndex: engineer.colourIndex,
    colour: "#123456",
    stops,
    coordinates: [[engineer.latitude, engineer.longitude]],
    returnLegIndex: null,
  };
}

test("suggestions use the same selected-date availability rule as capacity", () => {
  const sunday = "2026-08-16";
  const sundayContext = resolveRouteSuggestionContext({
    selectedDate: sunday,
    backlogDate: sunday,
  });

  assert.equal(engineerWorkingMinutesForDate(weekdayEngineer, sunday), 0);
  assert.deepEqual(
    findRouteSuggestions({
      items: [demand()],
      routes: [route()],
      context: sundayContext,
      now: new Date("2026-08-16T10:00:00.000Z"),
    }),
    [],
    "an off-day engineer must not receive a home-base suggestion",
  );

  const customPattern = {
    ...weekdayEngineer,
    resourceId: 8,
    id: "00000000-0000-4000-8000-000000000008",
    workingDays: [2, 4],
  };
  const monday = "2026-08-17";
  assert.equal(engineerWorkingMinutesForDate(customPattern, monday), 0);
  assert.deepEqual(
    findRouteSuggestions({
      items: [demand()],
      routes: [route(customPattern)],
      context: resolveRouteSuggestionContext({
        selectedDate: monday,
        backlogDate: monday,
      }),
      now: new Date("2026-08-17T10:00:00.000Z"),
    }),
    [],
    "custom non-working days must be excluded",
  );
});

test("historical, today and future suggestion dates have explicit semantics", () => {
  const historical = resolveRouteSuggestionContext({
    selectedDate: "2026-08-19",
    backlogDate: "2026-08-20",
  });
  const today = resolveRouteSuggestionContext({
    selectedDate: "2026-08-20",
    backlogDate: "2026-08-20",
  });
  const future = resolveRouteSuggestionContext({
    selectedDate: "2026-08-21",
    backlogDate: "2026-08-20",
  });

  assert.equal(historical.mode, "historical");
  assert.equal(today.mode, "today");
  assert.equal(future.mode, "future");

  const distantBaseEngineer = {
    ...weekdayEngineer,
    latitude: 53.8,
    longitude: -2.8,
  };
  const bookedRoute = route(distantBaseEngineer, [stop()]);
  assert.deepEqual(
    findRouteSuggestions({
      items: [demand()],
      context: historical,
      routes: [bookedRoute],
      now: new Date("2026-08-20T12:00:00.000Z"),
    }),
    [],
    "current backlog must not appear date-feasible on a historical schedule",
  );

  assert.deepEqual(
    findRouteSuggestions({
      items: [demand()],
      context: today,
      routes: [bookedRoute],
      radiusKm: 5,
      now: new Date("2026-08-20T12:00:00.000Z"),
    }),
    [],
    "today excludes stops that have already ended",
  );

  const futureRoute = route(distantBaseEngineer, [
    stop({
      startDateTime: "2026-08-21T10:00:00.000Z",
      endDateTime: "2026-08-21T11:00:00.000Z",
    }),
  ]);
  const futureSuggestions = findRouteSuggestions({
    items: [demand()],
    context: future,
    routes: [futureRoute],
    radiusKm: 5,
    now: new Date("2026-08-22T12:00:00.000Z"),
  });
  assert.equal(futureSuggestions.length, 1);
  assert.equal(futureSuggestions[0]?.method, "nearest-upcoming-stop");
});
