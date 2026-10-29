import assert from "node:assert/strict";
import test from "node:test";
import {
  MAP_MARKER_TOKENS,
  mapMarkerZoomTier,
  planningMarkersForLayers,
} from "../modules/map/markers";

test("zoom tiers preserve growing native marker sizes", () => {
  assert.equal(mapMarkerZoomTier(MAP_MARKER_TOKENS.zoom.city - 1), "regional");
  assert.equal(mapMarkerZoomTier(MAP_MARKER_TOKENS.zoom.city), "city");
  assert.equal(mapMarkerZoomTier(MAP_MARKER_TOKENS.zoom.street), "street");
  assert.equal(mapMarkerZoomTier(MAP_MARKER_TOKENS.zoom.detail), "detail");
  const sizes = Object.values(MAP_MARKER_TOKENS.size);
  for (let index = 1; index < sizes.length; index++) {
    for (const marker of ["complete", "open", "demand", "suggestion", "home"] as const) {
      assert.ok(sizes[index][marker] > sizes[index - 1][marker]);
    }
  }
});

test("demand and suggestion filters project one marker per demand item", () => {
  const items = [{ id: "suggested" }, { id: "ordinary" }];
  const suggestionIds = ["suggested"];
  assert.deepEqual(
    planningMarkersForLayers(items, {
      showDemand: true,
      showSuggestions: true,
      suggestionIds,
    }),
    items,
  );
  assert.deepEqual(
    planningMarkersForLayers(items, {
      showDemand: false,
      showSuggestions: true,
      suggestionIds,
    }),
    [items[0]],
  );
  assert.deepEqual(
    planningMarkersForLayers(items, {
      showDemand: false,
      showSuggestions: false,
      suggestionIds: [],
    }),
    [],
  );
});
