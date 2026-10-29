import type { LayerSpecification, SourceSpecification, StyleSpecification } from "maplibre-gl";
import { openFreeMapStyle } from "./route-map-basemap";
import { SOURCE, reviewLayers } from "./maplibre-review-layers";
type StyleEvent = {
  style?: object;
};
type Listener = (event: StyleEvent) => void;
/** The native map and deterministic lifecycle fake share this narrow interface. */
interface StyleMap {
  style?: object;
  getStyle(): StyleSpecification | undefined;
  getSource(id: string): {
    serialize(): SourceSpecification;
  } | undefined;
  getLayer(id: string): {
    serialize(): LayerSpecification;
  } | undefined;
  getLayersOrder(): string[];
  getGlyphs(): string | null;
  getSprite(): {
    id: string;
    url: string;
  }[];
  setStyle(style: string | StyleSpecification, options: {
    diff: boolean;
  }): unknown;
  on(type: "style.load" | "idle", listener: Listener): unknown;
  off(type: "style.load" | "idle", listener: Listener): unknown;
}
interface Callbacks {
  isReady(): boolean;
  loading(): void;
  restore(retained: boolean): void;
  settled(): void;
  unavailable(): void;
}
type Deadline = (callback: () => void, milliseconds: number) => () => void;
type Owned = {
  sources: NonNullable<ReturnType<StyleMap["getSource"]>>[];
  layers: NonNullable<ReturnType<StyleMap["getLayer"]>>[];
};
type Retention = Owned & {
  style: object;
  definitions: LayerSpecification[];
  sourcesAtEntry: {
    data: unknown;
    options: string;
  }[];
  order: string[];
};
type Transaction = {
  url: string;
  style?: object;
  fullUrl: boolean;
  restoring?: boolean;
  retention?: Retention;
};
const sourceIds = Object.values(SOURCE);
const expectedLayers = reviewLayers();
const layerIds = expectedLayers.map(layer => layer.id);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sprites = (sprite: StyleSpecification["sprite"]) => typeof sprite === "string"
  ? [{ id: "default", url: sprite }] : sprite ?? [];
const deadline: Deadline = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
};
/** Own two raw basemaps and reconcile native synchronous/full style completion. */
export class MapLibreReviewStyles {
  private readonly cache = new Map<string, StyleSpecification>();
  private readonly allowed = new Set([openFreeMapStyle("light"), openFreeMapStyle("dark")]);
  private pending?: Transaction;
  private current?: {
    url: string;
    style: object;
    owned?: Owned;
  };
  private cancelDeadline?: () => void;
  private idle?: Listener;
  private disposed = false;
  constructor(private map: StyleMap, initialUrl: string, private callbacks: Callbacks, private schedule: Deadline = deadline) {
    // MapLibre 5.24 creates the initial Style synchronously; loadURL completes
    // asynchronously. Bind that actual object, never the latest requested theme.
    this.map.on("style.load", this.loaded);
    this.begin({ url: initialUrl, style: map.style, fullUrl: true });
  }
  change(url: string) {
    if (this.disposed || this.pending?.url === url)
      return;
    const ready = !this.pending && this.current?.style === this.map.style && this.callbacks.isReady();
    if (ready && this.current?.url === url)
      return;
    // Preparation only clones the basemap and layer definitions. Source wrappers
    // reference submitted immutable data; native setState still clones internally.
    const prepared = ready ? this.prepare(url) : undefined;
    const transaction: Transaction = { url, fullUrl: !prepared, style: prepared ? this.map.style : undefined,
      retention: prepared?.retention };
    this.begin(transaction);
    this.callbacks.loading();
    if (this.disposed || this.pending !== transaction)
      return;
    try {
      if (prepared) {
        this.map.setStyle(prepared.input, { diff: true });
      }
      else {
        // Unknown/unready intent immediately cancels the old native full load.
        // URL diff has different asynchronous cancellation semantics in 5.24.
        this.map.setStyle(url, { diff: false });
      }
      // JSON diff can have restored synchronously already. Full replacement
      // (including native diff fallback) creates its Style now, but loadJSON
      // fires on a later frame. Bind the setter's resulting object in that case.
      if (this.pending === transaction)
        transaction.style = this.map.style;
    }
    catch {
      this.fail();
    }
  }
  private owned(): Owned | undefined {
    const sources = sourceIds.map(id => this.map.getSource(id));
    const layers = layerIds.map(id => this.map.getLayer(id));
    if (sources.some(source => !source) || layers.some(layer => !layer))
      return;
    return { sources: sources as Owned["sources"], layers: layers as Owned["layers"] };
  }
  private sameObjects(owned: Owned) {
    return sourceIds.every((id, index) => this.map.getSource(id) === owned.sources[index]) &&
      layerIds.every((id, index) => this.map.getLayer(id) === owned.layers[index]);
  }
  private prepare(url: string): {
    input: StyleSpecification;
    retention: Retention;
  } | undefined {
    try {
      const current = this.current, target = this.cache.get(url);
      const base = current && this.cache.get(current.url);
      if (!current?.owned || !base || !target || !this.sameObjects(current.owned))
        return;
      const baseIds = base.layers.map(layer => layer.id), targetIds = target.layers.map(layer => layer.id);
      // Equal ID sets can produce no native operations/style.load. Use the
      // accepted full path rather than manufacture completion for that case.
      if (equal([...baseIds].sort(), [...targetIds].sort()) ||
        !equal(base.sprite, target.sprite) || base.glyphs !== target.glyphs ||
        !equal(this.map.getSprite(), sprites(base.sprite)) || this.map.getGlyphs() !== (base.glyphs ?? null))
        return;
      const order = this.map.getLayersOrder();
      if (!equal(order, [...baseIds, ...layerIds]))
        return;
      const definitions = current.owned.layers.map(layer => structuredClone(layer.serialize()));
      if (definitions.some((layer, index) => {
        const expected = expectedLayers[index];
        return layer.id !== expected.id || layer.type !== expected.type ||
          !("source" in layer) || !("source" in expected) || layer.source !== expected.source;
      }))
        return;
      const sources = current.owned.sources.map(source => ({ ...source.serialize() }));
      if (sources.some(source => source.type !== "geojson" || source.promoteId !== "reviewId" ||
        source.cluster !== false || typeof source.data !== "object" || source.data.type !== "FeatureCollection"))
        return;
      const sourcesAtEntry = sources.map(source => {
        if (source.type !== "geojson")
          throw new Error("Unexpected review source");
        const { data, ...options } = source;
        return { data, options: JSON.stringify(options) };
      });
      const input = structuredClone(target);
      sourceIds.forEach((id, index) => { input.sources[id] = sources[index]; });
      // Keep the proof separate from setter-owned definitions, without touching
      // customer geometry. Native consumers may mutate their input.
      input.layers.push(...structuredClone(definitions));
      return { input, retention: { ...current.owned, style: current.style, definitions, sourcesAtEntry,
          order: [...targetIds, ...layerIds] } };
    }
    catch {
      // An unavailable public snapshot is an applicability miss, not a retry.
      return;
    }
  }
  private retained(proof: Retention | undefined): boolean {
    return !!proof && this.map.style === proof.style && this.sameObjects(proof) &&
      equal(this.map.getLayersOrder(), proof.order) &&
      proof.layers.every((layer, index) => equal(layer.serialize(), proof.definitions[index])) &&
      proof.sources.every((source, index) => {
        const before = proof.sourcesAtEntry[index], after = source.serialize();
        if (after.type !== "geojson")
          return false;
        const { data, ...options } = after;
        return before.data === data && before.options === JSON.stringify(options);
      });
  }
  private begin(transaction: Transaction) {
    this.cancelDeadline?.();
    this.clearIdle();
    this.current = undefined;
    if (this.pending)
      this.pending.retention = undefined;
    this.pending = transaction;
    // Must precede setStyle: native JSON setState can emit style.load inline.
    this.cancelDeadline = this.schedule(() => {
      if (this.pending === transaction)
        this.fail();
    }, 20000);
  }
  private loaded = (event: StyleEvent) => {
    const transaction = this.pending;
    if (this.disposed || !transaction || transaction.restoring || !event.style ||
      event.style !== this.map.style || event.style !== transaction.style)
      return;
    transaction.restoring = true;
    try {
      if (transaction.fullUrl && this.allowed.has(transaction.url) && !this.cache.has(transaction.url)) {
        // Capture before tuning, sprites or customer overlay publication. Only
        // identity-bound full URL loads may seed one of the two cache entries.
        const raw = this.map.getStyle();
        if (raw && !Object.keys(raw.sources).some(id => id.startsWith("review-")) &&
          !raw.layers.some(layer => layer.id.startsWith("review-"))) {
          this.cache.set(transaction.url, structuredClone(raw));
        }
      }
      const retained = this.retained(transaction.retention);
      transaction.retention = undefined;
      this.callbacks.restore(retained);
      if (this.disposed || this.pending !== transaction || this.map.style !== event.style)
        return;
      this.cancelDeadline?.();
      this.cancelDeadline = undefined;
      this.pending = undefined;
      const current = this.current = { url: transaction.url, style: event.style, owned: this.owned() };
      this.idle = () => {
        if (this.disposed || this.current !== current || this.map.style !== current.style)
          return;
        this.clearIdle();
        this.callbacks.settled();
      };
      this.map.on("idle", this.idle);
    }
    catch {
      // Do not throw restoration failures into native _updateDiff: it would
      // rebuild after a partial overlay restore and invoke us a second time.
      this.fail();
    }
  };
  private clearIdle() {
    if (this.idle)
      this.map.off("idle", this.idle);
    this.idle = undefined;
  }
  private fail() {
    if (this.disposed)
      return;
    this.dispose();
    this.callbacks.unavailable();
  }
  dispose() {
    if (this.disposed)
      return;
    this.disposed = true;
    this.cancelDeadline?.();
    this.cancelDeadline = undefined;
    this.clearIdle();
    this.map.off("style.load", this.loaded);
    this.cache.clear();
    if (this.pending)
      this.pending.retention = undefined;
    this.pending = undefined;
    this.current = undefined;
  }
}
