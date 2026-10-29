import assert from "node:assert/strict";
import test from "node:test";
import {
  currentRoadRouteReview,
  roadRouteReviewInputKey,
} from "../modules/routing/client/use-road-route-review";
import type { EngineerRoute } from "../modules/routing/contracts";

function route(coordinates: Array<[number, number]>): EngineerRoute {
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
    stops: [
      {
        id: "visit-1",
        serviceCallId: 1,
        ticketId: 1,
        ticketNumber: "T1",
        title: "Visit",
        autotaskUrl: null,
        companyName: "Company",
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
        startDateTime: "2026-08-20T09:00:00.000Z",
        endDateTime: "2026-08-20T10:00:00.000Z",
        durationMinutes: 60,
        status: 1,
        isComplete: false,
        latitude: coordinates[1]?.[0] ?? null,
        longitude: coordinates[1]?.[1] ?? null,
        additionalTicketCount: 0,
        sequence: 1,
        inboundLegIndex: 0,
        isOutOfRange: false,
      },
    ],
    coordinates,
    returnLegIndex: 1,
  };
}

test("road review results are fenced to the exact routing input", () => {
  const previousRoute = route([
    [51.5, -0.1],
    [51.51, -0.1],
    [51.5, -0.1],
  ]);
  const revisedRoute = route([
    [51.5, -0.1],
    [51.6, -0.2],
    [51.5, -0.1],
  ]);
  const previousKey = roadRouteReviewInputKey([previousRoute]);

  const previousReview = {
    inputKey: previousKey,
    roadRoutes: [{ id: "77", legDurationsMinutes: [15, 15] }],
    issues: [],
    loading: false,
  };

  assert.equal(
    currentRoadRouteReview(previousReview, [previousRoute]).roadRoutes.length,
    1,
  );
  assert.notEqual(previousKey, roadRouteReviewInputKey([revisedRoute]));

  const revisedReview = currentRoadRouteReview(previousReview, [revisedRoute]);
  assert.deepEqual(revisedReview.roadRoutes, []);
  assert.equal(
    revisedReview.issues.some((issue) => issue.kind === "road-route-unavailable"),
    true,
  );
  assert.equal(revisedReview.loading, true);
});

test("road issues are reprojected when non-geometry schedule facts change", () => {
  const previousRoute = route([
    [51.5, -0.1],
    [51.51, -0.1],
    [51.5, -0.1],
  ]);
  const revisedRoute = structuredClone(previousRoute);
  revisedRoute.stops[0].ticketId = null;
  const inputKey = roadRouteReviewInputKey([previousRoute]);

  assert.equal(inputKey, roadRouteReviewInputKey([revisedRoute]));

  const previous = currentRoadRouteReview(
    {
      inputKey,
      roadRoutes: [{ id: "77", legDurationsMinutes: [15, 15] }],
      loading: false,
    },
    [previousRoute],
  );
  const revised = currentRoadRouteReview(
    {
      inputKey,
      roadRoutes: [{ id: "77", legDurationsMinutes: [15, 15] }],
      loading: false,
    },
    [revisedRoute],
  );

  assert.equal(
    previous.issues.some((issue) => issue.kind === "missing-ticket-link"),
    false,
  );
  assert.equal(
    revised.issues.some((issue) => issue.kind === "missing-ticket-link"),
    true,
  );
  assert.equal(revised.roadRoutes.length, 1);
});
