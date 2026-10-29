import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchReviewInteractionReducer as transition,
  initialDispatchReviewInteractionState,
} from "../modules/dispatch/state/review-interaction";
import { resolveReviewRoutes } from "../modules/dispatch/model/review";
import type { EngineerRoute } from "../modules/routing/contracts";

function state() {
  return initialDispatchReviewInteractionState("2026-08-20");
}

test("repeated explicit route and demand focus replays camera intent", () => {
  let current = transition(state(), { type: "focus-route", routeId: "route:7", visitId: "visit:1" });
  current = transition(current, { type: "focus-route", routeId: "route:7", visitId: "visit:1" });
  assert.equal(current.routeFocusToken, 2);

  current = transition(current, { type: "focus-map-demand", demandId: "ticket:2", routeId: "route:7" });
  current = transition(current, { type: "focus-map-demand", demandId: "ticket:2", routeId: "route:7" });
  assert.equal(current.routeFocusToken, 4);
  assert.deepEqual(
    [current.selectedRouteId, current.selectedVisitId, current.focusedDemandId],
    ["route:7", null, "ticket:2"],
  );
});

test("map, rail and timeline demand origins retain distinct policy", () => {
  const hidden = { ...state(), showReadyToBook: false };
  const map = transition(hidden, {
    type: "focus-map-demand",
    demandId: "ticket:2",
    routeId: "route:7",
  });
  assert.equal(map.selectedVisitId, null, "map suggestions never select the booked anchor");
  assert.equal(map.showReadyToBook, false, "map selection does not rewrite explicit layers");

  const rail = transition(hidden, {
    type: "focus-rail-demand",
    demandId: "ticket:2",
    routeId: "route:7",
    anchorVisitId: "visit:1",
  });
  assert.equal(rail.selectedVisitId, "visit:1");
  assert.equal(rail.showReadyToBook, true);

  const plainRail = transition(hidden, {
    type: "focus-rail-demand",
    demandId: "ticket:3",
    routeId: null,
    anchorVisitId: null,
  });
  assert.equal(plainRail.selectedRouteId, "all");
  assert.equal(plainRail.showReadyToBook, true);

  const timeline = transition(hidden, {
    type: "focus-timeline-suggestion",
    demandId: "ticket:2",
    routeId: "route:7",
    anchorVisitId: "visit:1",
  });
  assert.equal(timeline.selectedVisitId, "visit:1");
  assert.equal(timeline.showReadyToBook, false);
});

test("selection clearing, visible fit and details are independent", () => {
  let current = transition(state(), { type: "focus-route", routeId: "route:7" });
  current = transition(current, { type: "open-visit-details", visitId: "visit:1" });
  const cleared = transition(current, { type: "clear-selection" });
  assert.equal(cleared.selectedRouteId, "all");
  assert.equal(cleared.detailVisitId, "visit:1");
  assert.equal(cleared.selectionClearToken, 1);
  assert.equal(cleared.visibleMarkerFitToken, 0);

  const fitted = transition(cleared, { type: "fit-visible" });
  assert.equal(fitted.selectionClearToken, 2);
  assert.equal(fitted.visibleMarkerFitToken, 1);
  assert.equal(fitted.detailVisitId, "visit:1");
});

test("visit filters preserve opposite-status and unresolved selected visits exactly", () => {
  const selected = transition(state(), { type: "focus-route", routeId: "route:7", visitId: "visit:selected" });

  assert.equal(transition(selected, {
    type: "toggle-open-visits",
    selectedVisitIsComplete: true,
  }).selectedVisitId, "visit:selected");
  assert.equal(transition(selected, {
    type: "toggle-open-visits",
    selectedVisitIsComplete: false,
  }).selectedVisitId, null);
  assert.equal(transition(selected, {
    type: "toggle-open-visits",
    selectedVisitIsComplete: undefined,
  }).selectedVisitId, null, "original optional-chain semantics clear unresolved visits when Open is hidden");

  assert.equal(transition(selected, {
    type: "toggle-complete-visits",
    selectedVisitIsComplete: false,
  }).selectedVisitId, "visit:selected");
  assert.equal(transition(selected, {
    type: "toggle-complete-visits",
    selectedVisitIsComplete: true,
  }).selectedVisitId, null);
  assert.equal(transition(selected, {
    type: "toggle-complete-visits",
    selectedVisitIsComplete: undefined,
  }).selectedVisitId, "visit:selected", "original negated optional-chain semantics retain unresolved visits when Complete is hidden");
});

test("region, third-party and query resets differ without clear-token changes", () => {
  const selected = {
    ...transition(state(), { type: "focus-route", routeId: "route:7", visitId: "visit:1" }),
    engineerFilterRouteId: "route:7",
    engineerQuery: "Engineer",
    engineerPickerOpen: true,
  };
  const region = transition(selected, { type: "set-regions", regions: new Set(["North"]) });
  assert.equal(region.selectedRouteId, "all");
  assert.equal(region.engineerPickerOpen, false);
  assert.equal(region.selectionClearToken, 0);

  const thirdParty = transition(selected, { type: "toggle-third-party" });
  assert.equal(thirdParty.selectedRouteId, "all");
  assert.equal(thirdParty.engineerPickerOpen, true, "third-party toggle leaves picker state unchanged");
  assert.equal(thirdParty.selectionClearToken, 0);

  const query = transition(selected, { type: "set-engineer-query", query: "New" });
  assert.equal(query.selectedRouteId, "route:7", "querying retains selected route");
  assert.equal(query.selectedVisitId, null);
  assert.equal(query.focusedDemandId, null);
  assert.equal(query.engineerPickerOpen, true);
  assert.equal(query.selectionClearToken, 0);
});

test("schedule publications preserve a present visit and clear an absent visit only", () => {
  const selected = transition(state(), { type: "focus-route", routeId: "route:7", visitId: "visit:1" });
  const retained = transition(selected, { type: "preserve-loaded-visit", visitIds: new Set(["visit:1"]) });
  assert.equal(retained, selected, "unchanged publication returns the same interaction reference");
  const removed = transition(selected, { type: "preserve-loaded-visit", visitIds: new Set() });
  assert.equal(removed.selectedVisitId, null);
  assert.equal(removed.selectedRouteId, "route:7");
  assert.equal(removed.routeFocusToken, 1);
});

test("date changes apply the full reset set and preserve explicit exceptions", () => {
  let current = {
    ...state(),
    showOpenVisits: false,
    showCompleteVisits: false,
    showThirdParty: false,
    showReadyToBook: false,
    suggestionRadiusKm: 25,
    engineerFilterRouteId: "route:7",
    engineerQuery: "Engineer",
    engineerPickerOpen: true,
  };
  current = transition(current, { type: "focus-map-demand", demandId: "ticket:2", routeId: "route:7" });
  current = transition(current, { type: "open-visit-details", visitId: "visit:1" });
  current = transition(current, { type: "open-demand-details", demandId: "ticket:2" });
  assert.equal(transition(current, { type: "change-date", date: current.date }), current);

  const changed = transition(current, { type: "change-date", date: "2026-08-21" });
  assert.deepEqual([...changed.selectedRegions], ["North", "Midlands", "South", "EU", "Ireland"]);
  assert.equal(changed.selectedRouteId, "all");
  assert.equal(changed.detailVisitId, null);
  assert.equal(changed.detailDemandId, "ticket:2");
  assert.equal(changed.showOpenVisits, true);
  assert.equal(changed.showCompleteVisits, true);
  assert.equal(changed.showThirdParty, false);
  assert.equal(changed.showReadyToBook, false);
  assert.equal(changed.suggestionRadiusKm, 25);
  assert.equal(changed.selectionClearToken, 1);
});

test("visible route projection retains its publication across visible selections and filter reset", () => {
  const route = { id: "route:7", stops: [] } as unknown as EngineerRoute;
  const canonicalRoutes = [route];
  const visibleRoutes = [route];
  const project = (interaction: ReturnType<typeof state>) =>
    resolveReviewRoutes({
      canonicalRoutes,
      projectedRoutes: visibleRoutes,
      visibleRoutes,
      selectedRouteId: interaction.selectedRouteId,
      selectedVisitId: interaction.selectedVisitId,
    });

  let interaction = transition(state(), { type: "focus-route", routeId: route.id });
  assert.equal(project(interaction).routes, visibleRoutes);

  interaction = transition(interaction, {
    type: "focus-map-demand",
    demandId: "ticket:2",
    routeId: route.id,
  });
  assert.equal(project(interaction).routes, visibleRoutes);

  interaction = transition(
    { ...interaction, showOpenVisits: false },
    { type: "reset-review-filters" },
  );
  const resetProjection = project(interaction);
  assert.equal(resetProjection.routes, visibleRoutes);
  assert.equal(resetProjection.focusedOutsideFilters, false);
  assert.equal(interaction.focusedDemandId, "ticket:2");
  assert.equal(interaction.routeFocusToken, 2);
});
