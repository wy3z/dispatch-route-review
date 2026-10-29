import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { ReviewPointOpacity } from "../modules/map/runtime/maplibre-review-point-opacity";
import { SOURCE, reviewLayers, pointContainsPointer } from "../modules/map/runtime/maplibre-review-layers";
import type { ReviewPointProperties } from "../modules/map/scene";

// MapLibre's browser bundle is CJS; tsx's require hook exposes its actual runtime.
const { MapLibreReviewRuntime } = createRequire(import.meta.url)("../modules/map/runtime/maplibre-review-runtime.ts");

const properties: ReviewPointProperties = { kind: "demand", entityId: "d1", routeId: "", colour: "#765432", label: "S", complete: false, thirdParty: false, attention: false, excluded: false, priority: 5000 };
const feature = (id: string, kind: string, layer: string, extra = {}) => ({ id, source: "fixture", layer: { id: layer }, geometry: { type: "Point", coordinates: [100, 100] }, properties: { ...properties, kind, ...extra } });

test("unassigned pins keep their tapered tips clickable without square corner targets", () => {
  for (const [zoom, radius] of [[6, 16], [8, 19], [11, 22], [14, 25]]) {
    assert.equal(pointContainsPointer(properties, zoom, 0, radius * 1.4), true);
    assert.equal(pointContainsPointer(properties, zoom, radius, radius), false);
    assert.equal(pointContainsPointer(properties, zoom, 0, radius * 1.4 + 5), false);
    assert.equal(pointContainsPointer(properties, zoom, 0, 0), true);
  }
});

test("native hit resolution excludes transparent padding, preserves badges and real overlap priority at every tier", () => {
  const runtime = Object.create(MapLibreReviewRuntime.prototype);
  const road = { id: "77:road:0", layer: { id: "review-roads-hit" }, geometry: { type: "LineString" }, properties: {} };
  let candidates = [feature("demand:d1", "demand", "review-demand-icon"), road];
  let zoom = 6, queries = 0;
  Object.assign(runtime, { ready: true, map: { queryRenderedFeatures: () => { queries++; return candidates; }, getZoom: () => zoom, project: ([x,y]: number[]) => ({ x,y }) } });
  const hit = (x: number, y: number) => runtime.hit({ point: { x: 100+x, y: 100+y } });
  assert.equal(hit(-38, 38)?.id, road.id, "road outside visible demand body wins over transparent sprite padding");
  candidates = [candidates[0]];
  assert.equal(hit(-38,38), undefined, "clear background outside artwork remains clear");
  for (const [level, radius] of [[6,16],[8,19],[11,22],[14,25]]) {
    zoom = level;
    candidates = [feature("demand:d1", "demand", "review-demand-icon"), feature("visit:v1", "visit", "review-booked-icon"), road];
    assert.equal(hit(0,0)?.id, "demand:d1", "true overlap retains priority");
    assert.equal(hit(radius+6,0)?.id, road.id, "hit margin is bounded");
    candidates = [feature("issue:v1", "issue", "review-issues-icon"), road];
    assert.equal(hit(18,-16)?.id, "issue:v1", "visible attention badge stays interactive");
    candidates = [feature("visit:v1", "visit", "review-booked-icon", { thirdParty: true }), road];
    assert.equal(hit(-20,-14)?.id, "visit:v1", "third-party badge stays interactive");
  }
  assert.equal(queries, 18, "one local rendered query per pointer operation");
});

test("route bodies use fixed state opacity while demand, roads and home visibility keep existing behavior", () => {
  const runtime = Object.create(MapLibreReviewRuntime.prototype);
  const paints = new Map<string, unknown>();
  const states = new Map<string, number>();
  const pointOpacity = new ReviewPointOpacity();
  for (const source of [SOURCE.booked, SOURCE.issues, SOURCE.homes]) pointOpacity.stage(source, {
    type: "FeatureCollection", features: ["A", "B", "home-route"].map(routeId => ({
      type: "Feature", id: routeId, geometry: { type: "Point", coordinates: [0, 0] }, properties: { routeId, complete: true },
    })),
  });
  const filters = new Map<string, unknown>();
  const d = feature("demand:d1", "demand", "review-demand-icon");
  const props = { scene: { homes: new Map([["home-route", {}]]), scope: { demandIds: ["d1","d2"] }, annotations: { issueSeverityByVisit: {}, suggestedDemandIds: ["d1","d2"] } }, selection: { kind: "route", routeId: "A" }, previewRouteId: null };
  Object.assign(runtime, { props, pointOpacity, ready: true, scopeDirty: false, visibleRoutes: new Set(["A","B"]), points: new Map([[d.id,d]]), issuePoints: new Map(), focusKey: "", interactionKey: "", metrics: { layerUpdates: 0, featureStates: 0 },
    map: { setFeatureState: ({ source, id }: { source: string; id: string }, state: { reviewOpacity: number }) => states.set(`${source}:${id}`, state.reviewOpacity), setPaintProperty: (layer: string, property: string, value: unknown) => paints.set(`${layer}:${property}`, value) },
    publish() {}, stage() {}, state() {}, setFilter(id: string, value: unknown) { filters.set(id, value); }, syncPopup() {}, navigate() {}, report() {} });
  const compareRoutes = () => {
    for (const id of ["A", "B", "home-route"]) {
      assert.equal(states.get(`${SOURCE.issues}:${id}`), states.get(`${SOURCE.booked}:${id}`), "issue body and badge follow route context");
      assert.equal(states.get(`${SOURCE.homes}:${id}`), states.get(`${SOURCE.booked}:${id}`));
    }
    for (const layer of ["review-booked-icon", "review-issues-icon", "review-homes-icon"]) {
      assert.ok(!paints.has(`${layer}:icon-opacity`), "reconciliation never replaces fixed point paint");
      const definition = reviewLayers().find(item => item.id === layer)!;
      assert.ok(definition.type === "symbol" && definition.paint!["icon-opacity"]);
    }
  };
  runtime.reconcile(); compareRoutes();
  assert.equal(states.get(`${SOURCE.booked}:A`), 1);
  assert.equal(states.get(`${SOURCE.booked}:B`), .38);
  assert.deepEqual(paints.get("review-roads-line:line-opacity"), ["case", ["in", ["get", "routeId"], ["literal", ["A"]]], ["case", ["get", "complete"], .78, .95], .25]);
  runtime.props = { ...props, selection: { kind: "none" }, previewRouteId: "B" }; runtime.reconcile(); compareRoutes();
  assert.equal(states.get(`${SOURCE.issues}:B`), 1);
  assert.equal(states.get(`${SOURCE.issues}:A`), .38);
  runtime.props = { ...props, selection: { kind: "demand", demandId: "d1", routeId: "A" } }; runtime.reconcile();
  assert.deepEqual(paints.get("review-suggested-icon:icon-opacity"), paints.get("review-demand-icon:icon-opacity"));
  assert.deepEqual(paints.get("review-suggested-halo:circle-opacity"), ["case",["==",["get","entityId"],"d1"],.16,.064]);
  runtime.interactionKey = ""; runtime.focusKey = ""; runtime.reconcile(); compareRoutes();
  runtime.props = { ...props, selection: { kind: "route", routeId: "home-route" } }; runtime.reconcile(); compareRoutes();
  assert.equal(states.get(`${SOURCE.homes}:home-route`), 1, "selected home stays bright outside booked scope");
  assert.deepEqual(filters.get("review-homes-icon"), ["in", ["get", "routeId"], ["literal", ["home-route"]]], "hidden homes stay filtered out of both rendering and hits");
  runtime.interactionKey = ""; runtime.reconcile(); compareRoutes();
  runtime.props = { ...props, selection: { kind: "demand", demandId: "d2", routeId: "home-route" } }; runtime.reconcile(); compareRoutes();
  assert.equal(states.get(`${SOURCE.booked}:A`), .38, "selected unbooked home dims booked bodies and issue overlays");
  runtime.props = { ...props, selection: { kind: "none" } }; runtime.reconcile(); compareRoutes();
  assert.equal(states.get(`${SOURCE.issues}:A`), .64, "clear restores completion opacity");
  assert.deepEqual(filters.get("review-homes-icon"), ["in", ["get", "routeId"], ["literal", []]]);
  assert.equal(paints.get("review-suggested-icon:icon-opacity"),1, "clearing even an unmapped demand resets contextual opacity");
  assert.equal(paints.get("review-suggested-halo:circle-opacity"),.16);
});

test("mouse capture cancellation is owned, leaves touch and other buttons alone, and never cancels normal release", () => {
  const runtime = Object.create(MapLibreReviewRuntime.prototype);
  const captured: number[] = [], cancelled: boolean[] = [];
  let active = false, touchActive = false;
  Object.assign(runtime, { capturedMousePointer: null, map: {
    getCanvasContainer: () => ({ setPointerCapture: (id: number) => captured.push(id) }),
    dragPan: { isEnabled: () => true, isActive: () => active || touchActive, _mousePan: { isActive: () => active } },
    handlers: { stop: (allowEndAnimation: boolean) => { cancelled.push(allowEndAnimation); active = false; } },
  } });
  for (const event of [
    { pointerType: "touch", button: 0, pointerId: 2 },
    { pointerType: "pen", button: 0, pointerId: 3 },
    { pointerType: "mouse", button: 2, pointerId: 1 },
    { pointerType: "mouse", button: 0, pointerId: 1, ctrlKey: true },
    { pointerType: "mouse", button: 0, pointerId: 1, shiftKey: true },
  ]) runtime.captureMouseDrag(event);
  assert.deepEqual(captured, []);
  runtime.captureMouseDrag({ pointerType: "mouse", button: 0, pointerId: 1 });
  active = true;
  runtime.cancelCapturedMouseDrag({ pointerId: 2 });
  assert.deepEqual(cancelled, [], "unowned touch cancellation cannot stop mouse gesture");
  runtime.cancelCapturedMouseDrag({ pointerId: 1 });
  assert.deepEqual(cancelled, [true], "owned interrupted gesture uses native blur cancellation");
  runtime.cancelCapturedMouseDrag({ pointerId: 1 });
  assert.deepEqual(cancelled, [true], "repeat cancellation is inert");
  runtime.captureMouseDrag({ pointerType: "mouse", button: 0, pointerId: 1 });
  active = false; // native mouseup already completed the next gesture
  runtime.cancelCapturedMouseDrag({ pointerId: 1 });
  assert.deepEqual(captured, [1,1]);
  assert.deepEqual(cancelled, [true], "normal release keeps native completion and inertia");
  runtime.captureMouseDrag({ pointerType: "mouse", button: 0, pointerId: 1 });
  touchActive = true;
  runtime.cancelCapturedMouseDrag({ pointerId: 1 });
  assert.deepEqual(cancelled, [true], "loss of inactive mouse capture cannot cancel a separately active touch gesture");
});
