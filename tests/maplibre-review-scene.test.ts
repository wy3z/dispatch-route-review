import assert from "node:assert/strict";
import test from "node:test";
import {
  advisoryMapLines,
  bookedMapPoints,
  demandMapPoints,
  issueMapPoints,
  mapCoordinate,
  roadMapLines,
  selectedMapPoint,
  visibleMapBounds,
} from "../modules/map/scene";
import { indexReviewMapBookings } from "../modules/map/selection";
import type { ReviewMapScene } from "../modules/map/contracts";
import type { EngineerRoute, RouteStop } from "../modules/routing/contracts";
import type { PlanningDemandItem } from "../modules/work/demand/model";

function scene(): ReviewMapScene {
  const visits = ([
    { id: "a", sequence: 1, inboundLegIndex: 0, ownerType: "internal", latitude: 52, longitude: -1, isComplete: false },
    { id: "b", sequence: 2, inboundLegIndex: 1, ownerType: "internal", latitude: 52.1, longitude: -1.1, isComplete: true },
    { id: "missing", sequence: 3, inboundLegIndex: null, ownerType: "internal", latitude: null, longitude: null, isComplete: false },
    { id: "after", sequence: 4, inboundLegIndex: null, ownerType: "internal", latitude: 53, longitude: -2, isComplete: false },
    { id: "outlier", sequence: 5, inboundLegIndex: null, ownerType: "third-party", latitude: 60, longitude: 10, isOutOfRange: true },
  ] satisfies Partial<RouteStop>[]).map((visit, index): RouteStop => ({
    serviceCallId: index + 1, ticketId: index + 1, ticketNumber: `Fixture-${index}`, title: "Fixture visit", autotaskUrl: null,
    companyName: "Fixture Company", locationName: "Fixture Site", address: "", city: "Fixture City", postcode: "",
    resourceId: 7, resourceName: "Fixture Engineer", routeOwnerKey: "r", ticketStatusId: 1, ticketStatusLabel: "Booked",
    queueId: 1, queueLabel: "Support", jobType: "support", ignoredResourceCount: 0, startDateTime: "2026-09-04T09:00:00Z",
    endDateTime: "2026-09-04T10:00:00Z", durationMinutes: 60, status: 1, isComplete: false, additionalTicketCount: 0,
    isOutOfRange: false, ...visit,
  }));
  const route: EngineerRoute = { id: "r", resourceId: 7, resourceName: "Fixture Engineer", colour: "#7357bd",
    base: { resourceId: 7, name: "Fixture Engineer", base: "Base", region: "North", latitude: 51.9, longitude: -.9 },
    stops: visits, coordinates: [[51.9, -.9], [52, -1], [52.1, -1.1]], returnLegIndex: null };
  const demand = { id: "d", latitude: 52.05, longitude: -1.05, workstream: "support", readiness: "blocked", overdue: true,
    exclusionReason: "no_covered_base", ageBand: "aged" } as PlanningDemandItem;
  return { booked: indexReviewMapBookings([route]), roads: new Map(), homes: new Map(), demand: new Map([["d", demand]]),
    scope: { routes: [route], demandIds: ["d"], includeOutOfCoverageInFit: false },
    annotations: { issueSeverityByVisit: { b: "critical" }, suggestedDemandIds: [], suggestions: {} } };
}

test("GPU scene keeps canonical sequence, missing-location breaks and immutable road leg IDs across filtered scope", () => {
  const input = scene();
  const fallback = roadMapLines(input.booked, input.roads);
  assert.deepEqual(fallback.features[0].geometry.coordinates, [[-.9, 51.9], [-1, 52], [-1.1, 52.1]]);
  assert.equal(fallback.features[0].properties.kind, "fallback");
  const roads = new Map([["r", { id: "r", legGeometries: [[[51.9, -.9], [52, -1]], [], [[52, -1], [52.1, -1.1]]], legErrors: [null, "unavailable", null] } as const]]);
  input.roads = new Map([["r", { ...roads.get("r")!, legGeometries: [[[51.9, -.9], [52, -1]], [], [[52, -1], [52.1, -1.1]]], legErrors: [null, "unavailable", null] }]]);
  input.scope.routes = [{ ...input.booked.routes[0], stops: [input.booked.routes[0].stops[0]] }];
  const lines = roadMapLines(input.booked, input.roads);
  assert.deepEqual(lines.features.map((feature) => feature.id), ["r:road:0", "r:road:2"]);
  assert.equal(lines.features.length, 2, "a missing road leg is not fabricated from aggregate or visible stops");
  assert.deepEqual(bookedMapPoints(input.booked).features.filter((point) => point.properties.kind === "visit").map((point) => point.properties.label), ["1", "2", "4", "5"]);
});

test("GPU demand, issue and home modifiers remain distinct from booked roads and source coordinates", () => {
  const input = scene();
  const booked = bookedMapPoints(input.booked);
  const index = new Map(booked.features.map((point) => [String(point.id), point]));
  assert.equal(booked.features[0].properties.kind, "home");
  assert.equal(index.get("visit:b")?.properties.complete, true);
  assert.equal(index.get("visit:outlier")?.properties.thirdParty, true);
  assert.equal(issueMapPoints(input, index).features[0].properties.severity, "critical");
  assert.equal(issueMapPoints(input, index).features[0].properties.colour, "#7357bd");
  const demand = demandMapPoints(input.demand).features[0];
  assert.equal(demand.properties.label, "S");
  assert.equal(demand.properties.excluded, true);
  assert.equal(demand.properties.attention, true);
  assert.deepEqual(demand.geometry.coordinates, [-1.05, 52.05]);
  index.set(String(demand.id), demand);
  assert.equal(selectedMapPoint({ kind: "demand", demandId: "d", routeId: "r", anchorVisitId: "a" }, index), demand);
});

test("advisory connectors accept canonical visit and home anchors without becoming road legs", () => {
  const input = scene();
  input.annotations.suggestedDemandIds = ["d"];
  input.annotations.suggestions.d = { routeId: "r", stopId: "a", routeColour: "#7357bd", resourceName: "Fixture Engineer", distanceKm: 2,
    method: "nearest-upcoming-stop", stopCompany: "Fixture", stopStartDateTime: "2026-09-04T12:00:00Z" };
  const before = roadMapLines(input.booked, input.roads);
  const visit = advisoryMapLines(input).features[0];
  assert.equal(visit.properties.kind, "advisory");
  assert.deepEqual(visit.geometry.coordinates, [[-1.05, 52.05], [-1, 52]]);
  input.annotations.suggestions.d = { ...input.annotations.suggestions.d, method: "nearest-home-base", stopId: "home:r" };
  assert.deepEqual(advisoryMapLines(input).features[0].geometry.coordinates[1], [-.9, 51.9]);
  assert.deepEqual(roadMapLines(input.booked, input.roads), before);
  input.scope.demandIds = [];
  assert.equal(advisoryMapLines(input).features.length, 0);
});

test("automatic map fit excludes outliers, missing locations and uncovered demand until explicitly included", () => {
  const input = scene();
  assert.deepEqual(visibleMapBounds(input), [[-.9, 51.9], [-1, 52], [-1.1, 52.1], [-2, 53]]);
  input.scope.includeOutOfCoverageInFit = true;
  assert.equal(visibleMapBounds(input).length, 6);
  assert.equal(mapCoordinate({ latitude: NaN, longitude: 0 }), null);
  assert.equal(mapCoordinate({ latitude: 91, longitude: 0 }), null);
});
