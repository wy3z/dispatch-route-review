import assert from "node:assert/strict";
import test from "node:test";
import { indexReviewMapBookings, reviewMapSelection } from "../modules/map/selection";
import { projectVisibleRoutes, resolveReviewRoutes } from "../modules/dispatch/model/review";
import type { EngineerRoute, RouteStop } from "../modules/routing/contracts";

test("semantic selection preserves demand association without turning demand into a booked visit", () => {
  assert.deepEqual(reviewMapSelection({ selectedRouteId: "all", selectedVisitId: null, focusedDemandId: null }), { kind: "none" });
  assert.deepEqual(reviewMapSelection({ selectedRouteId: "r", selectedVisitId: null, focusedDemandId: null }), { kind: "route", routeId: "r" });
  assert.deepEqual(reviewMapSelection({ selectedRouteId: "r", selectedVisitId: "v", focusedDemandId: null }), { kind: "visit", routeId: "r", visitId: "v" });
  assert.deepEqual(reviewMapSelection({ selectedRouteId: "r", selectedVisitId: "v", focusedDemandId: "d" }), { kind: "demand", demandId: "d", routeId: "r", anchorVisitId: "v" });
  assert.deepEqual(reviewMapSelection({ selectedRouteId: "all", selectedVisitId: null, focusedDemandId: "d" }), { kind: "demand", demandId: "d", routeId: null, anchorVisitId: null });
});

test("renderer index keeps canonical identity when scope hides and refocuses a completed stop", () => {
  // Only presentation fields are needed by the existing projection under test.
  const stops = [
    { id: "a", isComplete: false, sequence: 1, inboundLegIndex: 0, ownerType: "internal" },
    { id: "b", isComplete: true, sequence: 2, inboundLegIndex: 1, ownerType: "internal" },
    { id: "c", isComplete: false, sequence: 3, inboundLegIndex: 2, ownerType: "internal" },
  ] as RouteStop[];
  const canonical: EngineerRoute = {
    id: "r", resourceId: 7, resourceName: "Fixture", base: null,
    colour: "#123456", stops, coordinates: [[51, 0], [52, 0], [53, 0]], returnLegIndex: null,
  };
  const routes = [canonical];
  const booked = indexReviewMapBookings(routes);
  const projected = projectVisibleRoutes(routes, { showOpenVisits: true, showCompleteVisits: false, showThirdParty: true });
  assert.deepEqual(projected[0].stops.map((stop) => stop.inboundLegIndex), [0, 2]);
  const focused = resolveReviewRoutes({ canonicalRoutes: routes, projectedRoutes: projected, visibleRoutes: projected, selectedRouteId: "r", selectedVisitId: "b" });
  assert.equal(focused.focusedOutsideFilters, true);
  assert.equal(booked.routes, routes);
  assert.equal(booked.routeById.get("r"), canonical);
  assert.equal(booked.visitById.get("b")?.visit, stops[1]);
  assert.equal(booked.visitById.get("b")?.routeId, "r");
  assert.deepEqual(focused.routes[0].stops.map((stop) => stop.sequence), [1, 2, 3]);
  assert.equal(focused.routes[0].coordinates, canonical.coordinates);
});
