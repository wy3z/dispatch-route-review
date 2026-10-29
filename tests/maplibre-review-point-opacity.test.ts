import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import type { FeatureCollection } from "geojson";
import { ReviewPointOpacity } from "../modules/map/runtime/maplibre-review-point-opacity";
import { SOURCE, reviewLayers } from "../modules/map/runtime/maplibre-review-layers";

const require = createRequire(import.meta.url);
// Use the exact evaluator shipped with the pinned engine, without a new dependency.
const { createPropertyExpression, latest } = createRequire(require.resolve("maplibre-gl"))("@maplibre/maplibre-gl-style-spec");
const data = (rows: [string, string, boolean][]): FeatureCollection => ({ type: "FeatureCollection", features: rows.map(([id, routeId, complete]) => ({
  type: "Feature", id, properties: { routeId, complete }, geometry: { type: "Point", coordinates: [0, 0] },
})) });
function fixture() {
  const opacity = new ReviewPointOpacity();
  const writes: [string, string, number | null][] = [];
  const values = new Map<string, number>();
  const reconcile = (routes: string[]) => {
    writes.length = 0;
    opacity.reconcile(routes, (source, id, value) => {
      writes.push([source, id, value]);
      if (value === null) values.delete(`${source}:${id}`);
      else values.set(`${source}:${id}`, value);
    });
  };
  return { opacity, writes, values, reconcile };
}

test("fixed native expressions accept feature state and preserve exact overview/emphasis opacity", () => {
  for (const id of ["review-booked-icon", "review-issues-icon", "review-homes-icon"]) {
    const layer = reviewLayers().find(item => item.id === id)!;
    assert.equal(layer.type, "symbol");
    if (layer.type !== "symbol") throw new Error("expected symbol");
    const result = createPropertyExpression(layer.paint!["icon-opacity"], latest.paint_symbol["icon-opacity"]);
    assert.equal(result.result, "success");
    assert.equal(result.value.isStateDependent, true);
    for (const complete of [false, true]) {
      assert.equal(result.value.evaluate({ zoom: 12 }, { properties: { complete } }, {}), complete ? .64 : 1);
      for (const reviewOpacity of [1, .38, .64]) {
        assert.equal(result.value.evaluate({ zoom: 12 }, { properties: { complete } }, { reviewOpacity }), reviewOpacity);
      }
    }
  }
  const focus = reviewLayers().find(layer => layer.id === "review-focus-icon")!;
  assert.ok(focus.type === "symbol" && focus.paint!["icon-opacity"] === 1, "bounded focus remains fully opaque");
});

test("route switches touch only changed route IDs; entering/clearing initializes all canonical context", () => {
  const f = fixture();
  for (const source of [SOURCE.booked, SOURCE.issues, SOURCE.homes]) {
    f.opacity.stage(source, data([["a", "A", true], ["b", "B", false], ["c", "C", false], ["hidden", "outside-scope", true]]));
  }
  f.reconcile([]);
  assert.equal(f.writes.length, 12);
  assert.equal(f.values.get(`${SOURCE.booked}:a`), .64);
  f.reconcile(["A"]);
  assert.equal(f.writes.length, 12, "global dim mode includes hidden canonical points for later scope entry");
  f.reconcile(["B"]);
  assert.equal(f.writes.length, 6);
  assert.deepEqual(new Set(f.writes.map(([, id]) => id)), new Set(["a", "b"]));
  f.reconcile(["B", "A"]);
  assert.equal(f.writes.length, 3, "only newly emphasised A is touched");
  f.reconcile(["A", "B", "A"]);
  assert.deepEqual(f.writes, [], "membership order and duplicate preview cause no state writes");
  f.reconcile([]);
  assert.equal(f.values.get(`${SOURCE.issues}:a`), .64);
  assert.equal(f.values.get(`${SOURCE.issues}:hidden`), .64);
  assert.equal(f.values.get(`${SOURCE.homes}:b`), 1);
  f.reconcile([]);
  assert.deepEqual(f.writes, []);
});

test("real publications update added/reassigned/completed points and remove only stale owned keys", () => {
  const f = fixture();
  f.opacity.stage(SOURCE.booked, data([["a", "A", false], ["old", "B", false]]));
  f.reconcile(["A"]);
  f.opacity.stage(SOURCE.booked, data([["a", "B", true], ["new", "A", true]]));
  f.reconcile(["A"]);
  assert.deepEqual(f.writes, [[SOURCE.booked, "old", null], [SOURCE.booked, "a", .38], [SOURCE.booked, "new", 1]]);
  f.reconcile([]);
  assert.equal(f.values.get(`${SOURCE.booked}:a`), .64);
  f.opacity.stage(SOURCE.booked, data([["a", "B", false], ["new", "A", true]]));
  f.reconcile([]);
  assert.deepEqual(f.writes, [[SOURCE.booked, "a", 1]], "same ID completion change updates even without emphasis change");
  f.opacity.stage(SOURCE.booked, data([]));
  f.reconcile([]);
  assert.equal(f.values.size, 0, "empty date leaves no owned state");
});

test("retained style diffs state; full fallback replays latest staged data even for equal route selection", () => {
  const f = fixture();
  f.opacity.stage(SOURCE.issues, data([["same", "A", true]]));
  f.reconcile(["A"]);
  f.reconcile(["A"]);
  assert.deepEqual(f.writes, [], "proven C3 retention needs no reset or replay");
  // Several updates can stage while a style is loading; only the latest is applied.
  f.opacity.stage(SOURCE.issues, data([["obsolete", "B", false]]));
  f.opacity.stage(SOURCE.issues, data([["same", "A", true], ["latest", "B", false]]));
  f.values.clear(); // new native manager has no state, even though IDs match
  f.opacity.reset();
  f.reconcile(["A"]);
  assert.deepEqual(f.writes, [[SOURCE.issues, "same", 1], [SOURCE.issues, "latest", .38]]);
  f.reconcile(["B"]);
  assert.deepEqual(f.writes, [[SOURCE.issues, "latest", 1], [SOURCE.issues, "same", .38]]);
});
