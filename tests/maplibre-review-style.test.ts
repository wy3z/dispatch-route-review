import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import type { LayerSpecification, SourceSpecification, StyleSpecification } from "maplibre-gl";
import { MapLibreReviewStyles } from "../modules/map/runtime/maplibre-review-style";
import { SOURCE, reviewLayers } from "../modules/map/runtime/maplibre-review-layers";
import { openFreeMapStyle } from "../modules/map/runtime/route-map-basemap";

const bright = openFreeMapStyle("light");
const dark = openFreeMapStyle("dark");
type Listener = (event: { style?: object }) => void;

function raw(name: string): StyleSpecification {
  return {
    version: 8, name,
    sources: { openmaptiles: { type: "vector", url: "https://example.test/tiles" } },
    sprite: "https://example.test/sprite", glyphs: "https://example.test/fonts/{fontstack}/{range}.pbf",
    layers: [{ id: `${name}-background`, type: "background", paint: { "background-color": "#fff" } }],
  };
}

function basemap(input: StyleSpecification): StyleSpecification {
  return { ...input, sources: Object.fromEntries(Object.entries(input.sources).filter(([id]) => !id.startsWith("review-"))),
    layers: input.layers.filter(layer => !layer.id.startsWith("review-")) };
}

/** Models only documented/pinned completion modes, not the helper's decisions. */
class NativeSource {
  constructor(public definition: SourceSpecification) {}
  serialize() { return { ...this.definition }; }
}
class NativeLayer {
  constructor(public definition: LayerSpecification) {}
  serialize() { return structuredClone(this.definition); }
}
class NativeMap {
  style: object = {};
  definition?: StyleSpecification;
  jsonMode: "synchronous" | "replacement" | "silent" | "throw" = "replacement";
  calls: { input: string | StyleSpecification; options: { diff: boolean }; style: object }[] = [];
  listeners = { "style.load": new Set<Listener>(), idle: new Set<Listener>() };

  sources = new Map<string, NativeSource>();
  layers = new Map<string, NativeLayer>();
  operations: string[] = [];
  beforeComplete?: () => void;
  getStyle() { return this.definition; }
  getSource(id: string) { return this.sources.get(id); }
  getLayer(id: string) { return this.layers.get(id); }
  getLayersOrder() { return this.definition?.layers.map(layer => layer.id) ?? []; }
  getGlyphs() { return this.definition?.glyphs ?? null; }
  getSprite() {
    const sprite = this.definition?.sprite;
    return typeof sprite === "string" ? [{ id: "default", url: sprite }] : sprite ?? [];
  }
  addSource(id: string, definition: SourceSpecification) {
    assert.ok(!this.sources.has(id), `duplicate source ${id}`);
    this.sources.set(id, new NativeSource(definition));
    this.definition!.sources[id] = definition;
    this.operations.push(`addSource:${id}`);
  }
  addLayer(definition: LayerSpecification) {
    assert.ok(!this.layers.has(definition.id), `duplicate layer ${definition.id}`);
    this.layers.set(definition.id, new NativeLayer(definition));
    this.definition!.layers.push(definition);
    this.operations.push(`addLayer:${definition.id}`);
  }
  removeLayer(id: string) {
    this.layers.delete(id);
    this.definition!.layers = this.definition!.layers.filter(layer => layer.id !== id);
    this.operations.push(`removeLayer:${id}`);
  }
  removeSource(id: string) {
    assert.ok(!this.definition!.layers.some(layer => "source" in layer && layer.source === id));
    this.sources.delete(id);
    delete this.definition!.sources[id];
    this.operations.push(`removeSource:${id}`);
  }
  on(type: "style.load" | "idle", listener: Listener) { this.listeners[type].add(listener); }
  off(type: "style.load" | "idle", listener: Listener) { this.listeners[type].delete(listener); }
  emit(type: "style.load" | "idle", style = this.style) {
    for (const listener of [...this.listeners[type]]) listener({ style });
  }
  setStyle(input: string | StyleSpecification, options: { diff: boolean }) {
    if (typeof input === "string" || this.jsonMode === "replacement") {
      this.style = {};
      this.definition = undefined;
      this.sources.clear(); this.layers.clear();
    }
    this.calls.push({ input, options, style: this.style });
    if (typeof input === "string") return;
    if (this.jsonMode === "throw") throw new Error("native setter failure");
    if (this.jsonMode === "synchronous") this.complete(input);
  }
  complete(definition: StyleSpecification, style = this.style) {
    if (style === this.style) {
      this.definition = definition;
      for (const [id, source] of Object.entries(definition.sources)) {
        if (!this.sources.has(id)) this.sources.set(id, new NativeSource(source));
      }
      for (const layer of definition.layers) {
        if (!this.layers.has(layer.id)) this.layers.set(layer.id, new NativeLayer(layer));
      }
      for (const id of this.layers.keys()) if (!definition.layers.some(layer => layer.id === id)) this.layers.delete(id);
      this.beforeComplete?.();
    }
    this.emit("style.load", style);
  }
  last() { return this.calls[this.calls.length - 1]; }
  completeJSON() {
    const call = this.last();
    assert.notEqual(typeof call.input, "string");
    this.complete(call.input as StyleSpecification, call.style);
  }
}

class Clock {
  jobs: { callback: () => void; cancelled: boolean; milliseconds: number }[] = [];
  schedule = (callback: () => void, milliseconds: number) => {
    const job = { callback, cancelled: false, milliseconds };
    this.jobs.push(job);
    return () => { job.cancelled = true; };
  };
  pending() { return this.jobs.filter(job => !job.cancelled); }
  expire() { for (const job of this.pending()) job.callback(); }
}

function fixture() {
  const map = new NativeMap(), clock = new Clock();
  const state = { ready: false, loading: 0, settled: 0, failures: 0, restores: [] as string[],
    retained: [] as boolean[], selection: "initial", throwRestore: false,
    data: { type: "FeatureCollection" as const, features: [] }, reconciles: 0 };
  const styles = new MapLibreReviewStyles(map, bright, {
    isReady: () => state.ready,
    loading: () => { state.loading++; state.ready = false; },
    restore: (retained) => {
      assert.equal(clock.pending().length, 1, "deadline is staged before even synchronous restoration");
      if (state.throwRestore) throw new Error("overlay restore failure");
      assert.ok(map.definition);
      state.restores.push(`${map.definition.name}:${state.selection}`);
      state.retained.push(retained);
      // Model the runtime callback contract with duplicate-ID rejection and
      // latest staged data. Native rendering/images remain a later browser gate.
      if (!retained) {
        for (const layer of reviewLayers().reverse()) if (map.getLayer(layer.id)) map.removeLayer(layer.id);
        for (const id of Object.values(SOURCE)) if (map.getSource(id)) map.removeSource(id);
        for (const id of Object.values(SOURCE)) map.addSource(id, {
          type: "geojson", promoteId: "reviewId", cluster: false, data: state.data,
        });
        for (const layer of reviewLayers()) map.addLayer(layer);
      }
      map.definition.layers[0].minzoom = 3;
      state.reconciles++;
      state.ready = true;
    },
    settled: () => { state.settled++; },
    unavailable: () => { state.failures++; state.ready = false; },
  }, clock.schedule);
  function warmBoth() {
    map.complete(raw("bright"));
    styles.change(dark);
    assert.equal(map.last().input, dark);
    assert.deepEqual(map.last().options, { diff: false });
    map.complete(raw("dark"));
  }
  return { map, clock, state, styles, warmBoth };
}

test("full loads bind actual Style identity; interrupted definitions cannot seed the requested theme", () => {
  const { map, clock, state, styles } = fixture();
  const initial = map.style;
  styles.change(dark);
  map.complete(raw("obsolete-bright"), initial);
  assert.deepEqual(state.restores, []);
  assert.equal(clock.pending().length, 1);
  map.emit("style.load", {});
  assert.deepEqual(state.restores, []);
  map.complete(raw("dark"));
  styles.change(bright);
  assert.equal(map.last().input, bright, "interrupted initial bright was not cached under either key");
  map.complete(raw("bright"));
  styles.change(dark);
  const input = map.last().input;
  assert.notEqual(typeof input, "string");
  assert.equal((input as StyleSpecification).name, "dark");
  styles.dispose();
});

test("owned raw definitions exclude tuning and overlays and are isolated from native consumers", () => {
  const { map, state, styles } = fixture();
  const borrowed = raw("bright");
  map.complete(borrowed);
  borrowed.name = "mutated-after-load";
  styles.change(dark);
  map.complete(raw("dark"));
  styles.change(bright);
  const first = map.last().input as StyleSpecification;
  assert.deepEqual(basemap(first), raw("bright"));
  assert.equal(Object.keys(first.sources).length, 8);
  assert.equal(first.layers.length, 17);
  first.name = "mutated-by-native";
  map.completeJSON();
  styles.change(dark);
  map.completeJSON();
  styles.change(bright);
  assert.deepEqual(basemap(map.last().input as StyleSpecification), raw("bright"));
  assert.notEqual(map.last().input, first);
  assert.equal(state.failures, 0);
  styles.dispose();
});

test("known JSON can restore inline without leaving a newly armed timeout behind", () => {
  const { map, clock, state, styles, warmBoth } = fixture();
  warmBoth();
  map.jsonMode = "synchronous";
  const before = map.style;
  state.selection = "latest-demand";
  styles.change(bright);
  assert.equal(map.style, before);
  assert.equal(state.ready, true);
  assert.equal(state.restores.at(-1), "bright:latest-demand");
  assert.equal(clock.pending().length, 0);
  assert.ok(clock.jobs.every(job => job.milliseconds === 20_000));
  // A cancelled callback queued by the host cannot fail a completed transaction.
  for (const job of clock.jobs) job.callback();
  assert.equal(state.failures, 0);
  map.emit("idle");
  assert.equal(state.settled, 1);
  styles.dispose();
});

test("JSON full replacement or native fallback binds its new Style and restores once", () => {
  const { map, clock, state, styles, warmBoth } = fixture();
  warmBoth();
  const old = map.style;
  styles.change(bright);
  assert.notEqual(map.style, old);
  assert.equal(state.ready, false);
  map.emit("style.load", old);
  assert.equal(state.restores.length, 2);
  state.selection = "latest-route";
  map.completeJSON();
  map.emit("style.load");
  assert.deepEqual(state.restores, ["bright:initial", "dark:initial", "bright:latest-route"]);
  assert.equal(clock.pending().length, 0);
  styles.change(dark);
  assert.equal((map.last().input as StyleSpecification).name, "dark", "fallback did not overwrite another cache entry");
  styles.dispose();
});

test("a new intent during cached replacement immediately uses URLfalse and rejects late completion", () => {
  const { map, clock, state, styles, warmBoth } = fixture();
  warmBoth();
  styles.change(bright);
  const obsolete = map.last();
  styles.change(dark);
  assert.equal(map.last().input, dark);
  assert.deepEqual(map.last().options, { diff: false });
  const newest = map.style;
  map.complete(obsolete.input as StyleSpecification, obsolete.style);
  assert.equal(state.restores.length, 2);
  assert.equal(state.ready, false);
  map.complete(raw("dark"), newest);
  assert.equal(state.restores.at(-1), "dark:initial");
  assert.equal(clock.pending().length, 0);
  styles.dispose();
});

test("rapid full URL changes never wait for obsolete loads and keep actual theme attribution", () => {
  const { map, clock, state, styles } = fixture();
  styles.change(dark);
  const first = map.style;
  styles.change(bright);
  const second = map.style;
  styles.change(dark);
  assert.deepEqual(map.calls.map(call => [call.input, call.options.diff]), [[dark, false], [bright, false], [dark, false]]);
  map.complete(raw("bright"), second);
  map.complete(raw("dark"), first);
  assert.equal(state.restores.length, 0);
  assert.equal(clock.pending().length, 1);
  map.complete(raw("actual-dark"));
  assert.deepEqual(state.restores, ["actual-dark:initial"]);
  styles.change(bright);
  assert.equal(map.last().input, bright);
  styles.dispose();
});

test("same-theme pending/ready notifications are no-ops and unready maps bypass known JSON", () => {
  const { map, clock, state, styles, warmBoth } = fixture();
  styles.change(bright);
  assert.equal(map.calls.length, 0);
  assert.equal(clock.jobs.length, 1);
  warmBoth();
  const count = map.calls.length, deadlines = clock.jobs.length;
  styles.change(dark);
  assert.equal(map.calls.length, count);
  assert.equal(clock.jobs.length, deadlines);
  assert.equal(state.ready, true);
  state.ready = false;
  styles.change(bright);
  assert.equal(map.last().input, bright);
  styles.change(bright);
  assert.equal(map.calls.length, count + 1);
  assert.equal(clock.pending().length, 1);
  styles.dispose();
});

test("foreign current Style cannot use the cache even when renderer still reports ready", () => {
  const { map, styles, warmBoth } = fixture();
  warmBoth();
  map.style = {};
  styles.change(bright);
  assert.equal(map.last().input, bright);
  styles.dispose();
});

test("missing style.load (native no-op or validation error) fails once at the existing deadline", () => {
  const { map, clock, state, styles, warmBoth } = fixture();
  warmBoth();
  map.jsonMode = "silent";
  styles.change(bright);
  assert.notEqual(typeof map.last().input, "string", "silent case must exercise the JSON setter");
  assert.equal(state.ready, false);
  map.emit("idle");
  assert.equal(state.settled, 0, "idle alone cannot declare style restoration");
  clock.expire();
  clock.expire();
  map.complete(raw("too-late"));
  styles.change(dark);
  assert.equal(state.failures, 1);
  assert.equal(state.restores.length, 2);
  assert.equal(clock.pending().length, 0);
});

test("restoration errors cannot escape into native diff fallback or create a second restore", () => {
  const { map, clock, state, styles, warmBoth } = fixture();
  warmBoth();
  state.throwRestore = true;
  map.jsonMode = "synchronous";
  assert.doesNotThrow(() => styles.change(bright));
  map.emit("style.load");
  assert.equal(state.failures, 1);
  assert.equal(state.restores.length, 2);
  assert.equal(clock.pending().length, 0);
});

test("synchronous setter exceptions have bounded failure with no retry queue", () => {
  const { map, clock, state, styles, warmBoth } = fixture();
  warmBoth();
  map.jsonMode = "throw";
  styles.change(bright);
  styles.change(dark);
  assert.equal(state.failures, 1);
  assert.equal(map.calls.length, 2);
  assert.equal(clock.pending().length, 0);
});

test("stale idle callbacks cannot mark a newer transaction ready; native listeners remain intact", () => {
  const { map, state, styles } = fixture();
  let nativeLoads = 0, nativeIdles = 0;
  const nativeLoad = () => { nativeLoads++; }, nativeIdle = () => { nativeIdles++; };
  const nativeSetter = map.setStyle;
  map.on("style.load", nativeLoad);
  map.on("idle", nativeIdle);
  map.complete(raw("bright"));
  const obsoleteIdle = [...map.listeners.idle].find(listener => listener !== nativeIdle)!;
  styles.change(dark);
  obsoleteIdle({});
  assert.equal(state.settled, 0);
  map.complete(raw("dark"));
  map.emit("idle");
  assert.equal(state.settled, 1);
  styles.dispose();
  map.emit("idle");
  map.emit("style.load");
  assert.equal(nativeLoads, 3);
  assert.equal(nativeIdles, 2);
  assert.deepEqual([...map.listeners["style.load"]], [nativeLoad]);
  assert.deepEqual([...map.listeners.idle], [nativeIdle]);
  assert.equal(map.setStyle, nativeSetter);
});

test("only two allowed raw basemaps are cached; contaminated full loads are excluded", () => {
  const { map, styles, warmBoth } = fixture();
  warmBoth();
  const third = "https://example.test/third-style";
  styles.change(third);
  map.complete(raw("third"));
  styles.change(bright);
  assert.equal(map.last().input, bright, "unknown current basemap bypasses augmentation");
  map.complete(raw("bright"));
  styles.change(third);
  assert.equal(map.last().input, third, "other URLs do not add unbounded cached definitions");
  styles.dispose();

  for (const contamination of ["source", "layer"]) {
    const fresh = fixture(), definition = raw("bright");
    if (contamination === "source") definition.sources["review-booked"] = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
    else definition.layers.push({ id: "review-booked", type: "background" });
    fresh.map.complete(definition);
    fresh.styles.change(dark);
    fresh.map.complete(raw("dark"));
    fresh.styles.change(bright);
    assert.equal(fresh.map.last().input, bright);
    fresh.styles.dispose();
  }
});

test("disposal during a pending load removes owned callbacks and makes all late work inert", () => {
  const { map, clock, state, styles } = fixture();
  const pendingLoad = [...map.listeners["style.load"]][0];
  styles.dispose();
  styles.dispose();
  pendingLoad({ style: map.style });
  for (const job of clock.jobs) job.callback();
  styles.change(dark);
  assert.equal(state.failures, 0);
  assert.equal(state.restores.length, 0);
  assert.equal(map.calls.length, 0);
  assert.equal(clock.pending().length, 0);
  assert.equal(map.listeners["style.load"].size, 0);
  assert.equal(map.listeners.idle.size, 0);
});

test("successive ready cached A/B/A swaps complete synchronously with latest selection and no stale idle", () => {
  const { map, clock, state, styles, warmBoth } = fixture();
  warmBoth();
  map.jsonMode = "synchronous";
  const retainedStyle = map.style;
  for (const [url, name, selection] of [
    [bright, "bright", "visit-A"],
    [dark, "dark", "route-B"],
    [bright, "bright", "demand-C"],
  ]) {
    const previousIdle = [...map.listeners.idle][0];
    state.selection = selection;
    styles.change(url);
    assert.equal(map.style, retainedStyle);
    assert.notEqual(typeof map.last().input, "string");
    assert.equal((map.last().input as StyleSpecification).name, name);
    assert.equal(state.restores.at(-1), `${name}:${selection}`);
    assert.equal(state.ready, true);
    assert.equal(clock.pending().length, 0);
    previousIdle({ style: map.style });
    assert.equal(state.settled, 0, "same native Style does not make an earlier transaction's idle current");
    assert.equal(map.listeners.idle.size, 1);
  }
  assert.equal(state.restores.length, 5);
  map.emit("idle");
  assert.equal(state.settled, 1);
  assert.equal(state.failures, 0);
  styles.dispose();
});

test("an unknown full load interrupted by a cached target immediately uses full URL while unready", () => {
  const { map, clock, state, styles } = fixture();
  map.complete(raw("bright"));
  styles.change(dark);
  const unknownStyle = map.style;
  assert.equal(map.last().input, dark);
  assert.equal(state.ready, false);
  state.selection = "newest-demand";
  styles.change(bright);
  assert.equal(map.last().input, bright, "warmed bright must bypass JSON while unknown dark is loading");
  assert.deepEqual(map.last().options, { diff: false });
  assert.notEqual(map.style, unknownStyle);
  assert.equal(clock.pending().length, 1);
  map.complete(raw("obsolete-dark"), unknownStyle);
  assert.deepEqual(state.restores, ["bright:initial"]);
  assert.equal(state.ready, false);
  map.complete(raw("actual-bright"));
  assert.equal(state.restores.at(-1), "actual-bright:newest-demand");
  assert.equal(clock.pending().length, 0);
  styles.change(dark);
  assert.equal(map.last().input, dark, "the obsolete dark completion never seeded its cache entry");
  styles.dispose();
});

test("retained diff keeps all seven live source objects, exact sixteen-layer suffix and data references", () => {
  const { map, state, styles, warmBoth } = fixture();
  warmBoth();
  const sources = Object.values(SOURCE).map(id => map.getSource(id));
  const layers = reviewLayers().map(layer => map.getLayer(layer.id));
  const road = map.getLayer("review-roads-line")!;
  road.definition = { ...road.definition, filter: ["==", ["get", "routeId"], "selected-route"] } as LayerSpecification;
  const liveDefinitions = layers.map(layer => layer!.serialize());
  const start = map.operations.length;
  map.jsonMode = "synchronous";
  styles.change(bright);
  const input = map.last().input as StyleSpecification;
  assert.equal(state.retained.at(-1), true);
  assert.deepEqual(map.operations.slice(start), [], "unchanged overlays require no reinstall");
  assert.deepEqual(input.layers.slice(-16), liveDefinitions);
  Object.values(SOURCE).forEach((id, index) => {
    assert.equal(map.getSource(id), sources[index]);
    const source = input.sources[id];
    assert.equal(source.type, "geojson");
    if (source.type === "geojson") assert.equal(source.data, state.data, "app does not clone customer geometry");
  });
  assert.equal(state.reconciles, 3, "retention still reconciles latest props");
  styles.dispose();
});

test("full native JSON fallback discards same-ID stale snapshot and installs latest staged data", () => {
  const { map, state, styles, warmBoth } = fixture();
  warmBoth();
  const oldData = state.data;
  styles.change(bright);
  const input = map.last().input as StyleSpecification;
  const source = input.sources[SOURCE.roads];
  assert.equal(source.type, "geojson");
  if (source.type === "geojson") assert.equal(source.data, oldData);
  state.data = { type: "FeatureCollection", features: [] };
  state.selection = "newest-demand";
  const start = map.operations.length;
  map.completeJSON();
  assert.equal(state.retained.at(-1), false);
  assert.equal(state.restores.at(-1), "bright:newest-demand");
  const operations = map.operations.slice(start);
  assert.deepEqual(operations.slice(0, 16), reviewLayers().reverse().map(layer => `removeLayer:${layer.id}`));
  assert.deepEqual(operations.slice(16, 23), Object.values(SOURCE).map(id => `removeSource:${id}`));
  for (const id of Object.values(SOURCE)) {
    const definition = map.getSource(id)!.serialize();
    if (definition.type === "geojson") assert.equal(definition.data, state.data);
  }
  styles.dispose();
});

test("same Style cannot claim retention after source/layer replacement, data/options mutation or changed layer/order", () => {
  const mutations: ((map: NativeMap) => void)[] = [
    map => map.sources.set(SOURCE.roads, new NativeSource(map.getSource(SOURCE.roads)!.serialize())),
    map => map.layers.set("review-roads-hit", new NativeLayer(map.getLayer("review-roads-hit")!.serialize())),
    map => { map.getSource(SOURCE.focus)!.definition = { type: "geojson", promoteId: "reviewId", cluster: false, data: { type: "FeatureCollection", features: [] } }; },
    map => { const source = map.getSource(SOURCE.roads)!; source.definition = { ...source.definition, cluster: true } as SourceSpecification; },
    map => { map.getLayer("review-roads-hit")!.definition.minzoom = 17; },
    map => { const layers = map.definition!.layers; [layers[1], layers[2]] = [layers[2], layers[1]]; },
  ];
  for (const mutate of mutations) {
    const { map, state, styles, warmBoth } = fixture();
    warmBoth(); map.jsonMode = "synchronous"; map.beforeComplete = () => mutate(map);
    styles.change(bright);
    assert.equal(state.retained.at(-1), false);
    assert.equal(state.failures, 0);
    styles.dispose();
  }
});

test("incomplete/foreign owned objects, suffix/order/options and changed dependencies use URLfalse", () => {
  const mutations: ((map: NativeMap) => void)[] = [
    map => map.sources.delete(SOURCE.homes),
    map => map.sources.set(SOURCE.roads, new NativeSource(map.getSource(SOURCE.roads)!.serialize())),
    map => map.layers.delete("review-focus-icon"),
    map => map.addLayer({ id: "foreign", type: "background" }),
    map => { const layers = map.definition!.layers; [layers[1], layers[2]] = [layers[2], layers[1]]; },
    map => { map.getSource(SOURCE.roads)!.definition = { type: "geojson", data: "foreign.json" }; },
    map => { map.definition!.sprite = "https://example.test/changed-sprite"; },
    map => { map.definition!.glyphs = "https://example.test/changed-glyphs"; },
  ];
  for (const mutate of mutations) {
    const { map, styles, warmBoth } = fixture();
    warmBoth(); mutate(map); styles.change(bright);
    assert.equal(map.last().input, bright);
    assert.deepEqual(map.last().options, { diff: false });
    styles.dispose();
  }
});

test("same basemap ID set or changed cached sprite/glyphs cannot enter potentially no-op JSON diff", () => {
  for (const changed of ["ids", "sprite", "glyphs"]) {
    const { map, styles } = fixture();
    map.complete(raw("bright")); styles.change(dark);
    const target = raw("dark");
    if (changed === "ids") target.layers[0].id = "bright-background";
    else if (changed === "sprite") target.sprite = "https://example.test/different-sprite";
    else target.glyphs = "https://example.test/different-glyphs";
    map.complete(target); styles.change(bright);
    assert.equal(map.last().input, bright);
    assert.deepEqual(map.last().options, { diff: false });
    styles.dispose();
  }
});

// Resolve MapLibre's pinned transitive planner, without adding a dependency or
// importing/copying native implementation into application code.
const require = createRequire(import.meta.url);
const nativeRequire = createRequire(require.resolve("maplibre-gl"));
const { diff } = nativeRequire("@maplibre/maplibre-gl-style-spec") as {
  diff(before: StyleSpecification, after: StyleSpecification): { command: string; args: unknown[] }[];
};

test("pinned native diff planner leaves the exact review suffix and seven sources untouched in both directions", () => {
  const { map, styles, warmBoth } = fixture();
  warmBoth(); map.jsonMode = "silent";
  for (const [url, name] of [[bright, "bright"], [dark, "dark"]]) {
    const before = map.getStyle()!;
    // Assert a live filter/paint change survives rather than factory defaults.
    const layer = map.getLayer("review-roads-hit")!;
    layer.definition = { ...layer.definition, minzoom: 4,
      filter: ["==", ["get", "routeId"], "selected-route"],
      paint: { "line-width": 21, "line-opacity": 0 } } as LayerSpecification;
    const emphasis = map.getLayer("review-emphasis-line")!;
    emphasis.definition = { ...emphasis.definition,
      filter: ["==", ["get", "routeId"], "selected-route"],
      paint: { "line-width": 7, "line-color": "#112233", "line-opacity": 0.91 } } as LayerSpecification;
    before.layers = before.layers.map(item => map.getLayer(item.id)!.serialize());
    styles.change(url);
    const augmented = map.last().input as StyleSpecification;
    const operations = diff(before, augmented);
    assert.ok(operations.length > 0, "different basemap IDs supply actual native operations");
    const reviewOperations = (ops: typeof operations) => ops.filter(op => {
      // addLayer's second argument is only an insertion anchor: basemap layers
      // legitimately insert before the preserved suffix without changing it.
      const target = op.args[0];
      return op.command === "addLayer"
        ? !!target && typeof target === "object" && "id" in target &&
          typeof target.id === "string" && target.id.startsWith("review-")
        : typeof target === "string" && target.startsWith("review-");
    });
    assert.deepEqual(reviewOperations(operations), []);
    const rawOperations = reviewOperations(diff(before, raw(name)));
    assert.equal(rawOperations.filter(op => op.command === "removeSource").length, 7);
    assert.equal(rawOperations.filter(op => op.command === "removeLayer").length, 16);
    map.completeJSON();
  }
  styles.dispose();
});

test("mutating setter input cannot rewrite the entry proof into accepting an intervening setData", () => {
  const { map, state, styles, warmBoth } = fixture();
  warmBoth(); map.jsonMode = "synchronous";
  map.beforeComplete = () => {
    const input = map.last().input as StyleSpecification;
    const source = input.sources[SOURCE.focus];
    assert.equal(source.type, "geojson");
    if (source.type !== "geojson") return;
    source.data = { type: "FeatureCollection", features: [] };
    map.getSource(SOURCE.focus)!.definition = source;
  };
  styles.change(bright);
  assert.equal(state.retained.at(-1), false);
  assert.equal(state.failures, 0);
  styles.dispose();
});
