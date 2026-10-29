import type { Map as LibreMap, Popup, GeoJSONSource, MapGeoJSONFeature, MapMouseEvent, FilterSpecification, IControl, } from "maplibre-gl";
import { recordMapComparisonEvent } from "./map-comparison-events";
import type { FeatureCollection } from "geojson";
import type { ReviewMapProps, ReviewMapScene } from "../contracts";
import { advisoryMapLines, bookedMapPoints, collection, demandMapPoints, homeMapPoints, issueMapPoints, roadMapLines, routeMapBounds, selectedMapPoint, visibleMapBounds, } from "../scene";
import type { ReviewPoint } from "../scene";
import { routeTimingForStop } from "@/modules/routing/domain";
import { formatTime } from "../../../shared/formatting";
import { openFreeMapStyle, retainCachedBasemapParents, tuneOpenFreeMapStyle, } from "./route-map-basemap";
import { readyToBookPopupContent, stopPopupContent } from "./route-map-popups";
import { baseTimingTooltip, routeLegTooltip, routeOrderFallbackTooltip, } from "./route-map-tooltips";
import { HIT_LAYERS, SOURCE, idsFilter, installPointImages, pointContainsPointer, pointImageKey, reviewLayers, } from "./maplibre-review-layers";
import { MapLibreReviewStyles } from "./maplibre-review-style";
import { ReviewPointOpacity } from "./maplibre-review-point-opacity";
type Status = (message: string) => void;
type Publication = {
  data: FeatureCollection;
  revision: number;
};
type Metrics = {
  publications: Record<string, number>;
  features: Record<string, number>;
  featureStates: number;
  layerUpdates: number;
  styleRestores: number;
  cameraIntents: number;
  keyboardCommands: number;
  mapsCreated: number;
  mapsRemoved: number;
};
/** Direct renderer: owns one camera, style reconciliation, isolated publication and interaction. */
export class MapLibreReviewRuntime {
  readonly map: LibreMap;
  private props: ReviewMapProps;
  private previousScene?: ReviewMapScene;
  private publications = new Map<string, Publication>();
  private published = new Map<string, number>();
  private points = new Map<string, ReviewPoint>();
  private issuePoints = new Map<string, ReviewPoint>();
  private scopeDirty = true;
  private routeIds: string[] = [];
  private visibleRoutes = new Set<string>();
  private visitIds: string[] = [];
  private focusedDemand: string | null = null;
  private routeBounds = new Map<string, [
    number,
    number
  ][]>();
  private visibleBounds: [
    number,
    number
  ][] = [];
  private popup: Popup;
  private tooltip: Popup;
  private popupKey = "";
  private homePopupRouteId: string | null = null;
  private popupRevision = "";
  private dismissingPopup = false;
  private returnFocus: HTMLElement | null = null;
  private hoverKey = "";
  private hoverFeature: MapGeoJSONFeature | null = null;
  private filterKeys = new Map<string, string>();
  private interactionKey = "";
  private pointOpacity = new ReviewPointOpacity();
  private focusKey = "";
  private cameraKey = "";
  private fitRequest = -1;
  private initialFit = false;
  private ready = false;
  private disposed = false;
  private capturedMousePointer: number | null = null;
  private degraded = false;
  private styles: MapLibreReviewStyles;
  private resizeObserver: ResizeObserver;
  private themeObserver: MutationObserver;
  private reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private metrics: Metrics = { publications: {}, features: {}, featureStates: 0, layerUpdates: 0, styleRestores: 0, cameraIntents: 0, keyboardCommands: 0, mapsCreated: 1, mapsRemoved: 0 };
  private removeDiagnostics: () => void;
  constructor(private element: HTMLDivElement, props: ReviewMapProps, private status: Status, private announce: Status, engine: typeof import("maplibre-gl"), controls: {
    navigation: HTMLElement;
    attribution: HTMLElement;
  }) {
    const { Map: LibreMap, Popup, NavigationControl, AttributionControl } = engine;
    this.popup = new Popup({ anchor: "bottom", closeButton: true, closeOnClick: false, focusAfterOpen: false, maxWidth: "380px", offset: 28, className: "review-libre-popup" });
    this.tooltip = new Popup({ closeButton: false, closeOnClick: false, focusAfterOpen: false, maxWidth: "360px", offset: 22, className: "review-libre-tooltip" });
    this.captureMouseDrag = this.captureMouseDrag.bind(this);
    this.cancelCapturedMouseDrag = this.cancelCapturedMouseDrag.bind(this);
    this.props = props;
    const initialStyle = openFreeMapStyle(document.documentElement.dataset.theme);
    this.map = new LibreMap({ container: element, style: initialStyle, center: [-1.8, 53.2], zoom: 6,
      minZoom: 3, maxZoom: 19, renderWorldCopies: false,
      // Keep overview parents across successive street-level visits. The native
      // five-viewport budget evicts them before a longer flight or zoom-out.
      // This bounds retained decoded tiles; it does not preload extra tiles.
      maxTileCacheZoomLevels: 8, maxTileCacheSize: 256,
      keyboard: false, doubleClickZoom: false, dragRotate: false, pitchWithRotate: false,
      canvasContextAttributes: { failIfMajorPerformanceCaveat: false }, fadeDuration: this.reducedMotion.matches ? 0 : 150,
      attributionControl: false,
    });
    // renderWorldCopies:false applies MapLibre's native almost-180° bounds.
    // Exact ±180° maxBounds wrap to the same x coordinate in MapLibre 5.24.
    recordMapComparisonEvent(element, "constructed");
    this.map.on("movestart", () => recordMapComparisonEvent(element, "camera-start"));
    this.map.on("moveend", () => recordMapComparisonEvent(element, "camera-end"));
    const firstSourceCompletions = new Set<string>();
    const firstSourceContent = new Set<string>();
    this.map.on("sourcedata", (event) => {
      if (event.sourceDataType === "content" && event.sourceId && !firstSourceContent.has(event.sourceId)) {
        firstSourceContent.add(event.sourceId);
        recordMapComparisonEvent(element, `first-source-content:${event.sourceId}`);
      }
      if (event.isSourceLoaded && event.sourceId && !firstSourceCompletions.has(event.sourceId)) {
        firstSourceCompletions.add(event.sourceId);
        recordMapComparisonEvent(element, `first-source-ready:${event.sourceId}`);
      }
    });
    this.map.touchZoomRotate.disableRotation();
    this.addChromeControl(new NavigationControl({ showCompass: false }), controls.navigation);
    this.addChromeControl(new AttributionControl({ compact: false,
      customAttribution: '<a href="https://maplibre.org/" target="_blank" rel="noopener noreferrer">MapLibre</a>',
    }), controls.attribution);
    this.map.getCanvas().setAttribute("aria-label", "Map canvas; use the route rail or Timeline for individual jobs");
    this.map.getCanvas().tabIndex = -1;
    this.map.getCanvasContainer().addEventListener("pointerdown", this.captureMouseDrag);
    this.map.getCanvasContainer().addEventListener("lostpointercapture", this.cancelCapturedMouseDrag);
    this.map.getCanvasContainer().addEventListener("pointercancel", this.cancelCapturedMouseDrag);
    this.styles = new MapLibreReviewStyles(this.map, initialStyle, {
      isReady: () => this.ready && !this.disposed && !this.degraded,
      loading: () => {
        this.ready = false;
        this.element.dataset.mapStyleReady = "false";
        this.closeTooltip();
      },
      restore: this.restoreStyle,
      settled: () => { this.element.dataset.mapStyleReady = "true"; },
      unavailable: () => this.fail("Map style unavailable. Review routes and jobs in the rail or Timeline."),
    });
    this.map.on("webglcontextlost", this.contextLost);
    this.map.on("error", this.mapError);
    this.map.on("mousemove", this.pointerMove);
    this.map.on("mouseout", this.pointerLeave);
    this.map.on("click", this.click);
    this.map.on("dblclick", this.doubleClick);
    this.map.on("movestart", this.pointerLeave);
    this.popup.on("close", this.popupClosed);
    window.addEventListener("review-map-camera", this.keyboardCamera);
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.degraded)
        this.map.resize();
    });
    this.resizeObserver.observe(element);
    this.themeObserver = new MutationObserver(() => {
      if (!this.degraded)
        this.styles.change(openFreeMapStyle(document.documentElement.dataset.theme));
    });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    this.reducedMotion.addEventListener("change", this.motionChanged);
    this.update(props);
    this.removeDiagnostics = this.installDiagnostics();
  }
  private installDiagnostics() {
    if (new URLSearchParams(location.search).get("mapDiagnostics") !== "1")
      return () => { };
    const element = this.element;
    const diagnostics = { reviewMapDiagnostics: (id?: string) => this.inspect(id),
      reviewMapProject: (lng: number, lat: number) => {
        const p = this.map.project([lng, lat]), r = element.getBoundingClientRect();
        return { x: p.x + r.left, y: p.y + r.top };
      },
      reviewMapHitDiagnostics: (x: number, y: number) => {
        const rect = element.getBoundingClientRect();
        const point = { x: x - rect.left, y: y - rect.top };
        const winner = this.hit({ point } as MapMouseEvent);
        return { winner: winner && { id: winner.id, layer: winner.layer.id }, candidates: this.ready
            ? this.map.queryRenderedFeatures([[point.x - 4, point.y - 4], [point.x + 4, point.y + 4]], { layers: HIT_LAYERS }).map(f => ({ id: f.id, layer: f.layer.id })) : [] };
      },
      reviewMapPaintDiagnostics: () => this.ready ? Object.fromEntries([
        "review-booked-icon", "review-issues-icon", "review-homes-icon", "review-demand-icon", "review-suggested-icon", "review-suggested-halo",
      ].map(id => [id, this.map.getLayer(id)?.serialize().paint])) : {},
      reviewMapPointLayers: () => this.ready ? this.map.queryRenderedFeatures({ layers: HIT_LAYERS }).filter(f => f.geometry.type === "Point")
        .map(f => ({ id: f.properties.entityId, kind: f.properties.kind, layer: f.layer.id })) : [],
      reviewMapRoadProbes: () => this.ready ? this.map.queryRenderedFeatures({ layers: ["review-roads-hit"] }).flatMap(feature => {
        if (feature.geometry.type !== "LineString")
          return [];
        return feature.geometry.coordinates.slice(1).flatMap((coordinate, index) => {
          const previous = feature.geometry.type === "LineString" ? feature.geometry.coordinates[index] : coordinate;
          const a = this.map.project(previous as [
            number,
            number
          ]);
          const b = this.map.project(coordinate as [
            number,
            number
          ]);
          const rect = element.getBoundingClientRect();
          return [.25, .5, .75].map(fraction => {
            const point = a.add(b.sub(a).mult(fraction));
            const hit = this.hit({ point } as MapMouseEvent);
            return { id: feature.id, hitId: hit?.id, hitSource: hit?.source, x: point.x + rect.left, y: point.y + rect.top };
          });
        });
      }) : [],
      reviewMapCameraDiagnostics: () => ({ zoom: this.map.getZoom(), center: this.map.getCenter(), moving: this.map.isMoving(), easing: this.map.isEasing(), dragActive: this.map.dragPan.isActive() }),
      reviewMapImageDiagnostics: () => this.ready ? this.map.listImages().filter(id => id.startsWith("[")).sort().map(id => {
        const image = this.map.getImage(id);
        let hash = 2166136261;
        for (const value of image.data.data)
          hash = Math.imul(hash ^ value, 16777619);
        return { id, width: image.data.width, height: image.data.height, pixelRatio: image.pixelRatio, hash: hash >>> 0 };
      }) : [],
      reviewMapSourceDiagnostics: () => this.ready ? [...this.publications].map(([source, publication]) => ({
        source, ids: publication.data.features.map(f => String(f.id)),
        promotedIds: publication.data.features.map(f => f.properties?.reviewId),
        advisoryEndpoints: source === SOURCE.advisory ? publication.data.features.map(f => ({ id: f.id,
          demandId: f.properties?.entityId, routeId: f.properties?.routeId,
          anchorId: this.props.scene.annotations.suggestions[f.properties?.entityId]?.stopId,
          coordinates: f.geometry.type === "LineString" ? f.geometry.coordinates : [],
        })) : [],
        queriedIds: [...new Set(this.map.querySourceFeatures(source).map(f => String(f.id)))],
        renderedIds: [...new Set(this.map.queryRenderedFeatures().filter(f => f.source === source).map(f => String(f.id)))],
        states: publication.data.features.map(f => ({ id: String(f.id), ...this.map.getFeatureState({ source, id: String(f.id) }) })),
      })) : [],
    };
    Object.assign(element, diagnostics);
    return () => {
      for (const name of Object.keys(diagnostics))
        Reflect.deleteProperty(element, name);
    };
  }
  private captureMouseDrag(event: PointerEvent) {
    // MapLibre 5.24 ends mouse drags on canvas mouseup, but its document-level
    // mouseupWindow is not wired to dragEnd. Keep the real release on the canvas
    // when a drag crosses a sibling popup/toolbar or leaves the map. Native
    // mouse handlers still own movement, inertia, click suppression and blur.
    if (event.pointerType === "mouse" && event.button === 0 && !event.ctrlKey && !event.shiftKey && this.map.dragPan.isEnabled()) {
      this.map.getCanvasContainer().setPointerCapture(event.pointerId);
      this.capturedMousePointer = event.pointerId;
    }
  }
  private cancelCapturedMouseDrag(event: PointerEvent) {
    if (event.pointerId !== this.capturedMousePointer)
      return;
    this.capturedMousePointer = null;
    // Normal release already ended the drag in MapLibre's mouseup handler.
    // Only an interrupted owned gesture needs its native cancellation path,
    // identical to MapLibre 5.24 HandlerManager's window-blur handling. There is
    // no public cancel-gesture API; keep this version-pinned internal seam here.
    // dragPan.isActive() also includes touch: an inactive captured mouse must
    // never cancel a separately active touch gesture.
    if (this.map.dragPan._mousePan.isActive())
      this.map.handlers.stop(true);
  }
  private motionChanged = () => { this.map.stop(); };
  private contextLost = () => this.fail("Map unavailable: the graphics context was lost. Review routes and jobs in the rail or Timeline.");
  private mapError = (event: {
    error: Error;
  }) => {
    if (new URLSearchParams(location.search).get("mapDiagnostics") === "1")
      this.element.dataset.mapStyleError = String(event.error);
    // A failed tile is not a page failure. A failed style has a bounded timeout.
    if (!this.ready)
      this.status("Loading map style. Routes and Timeline remain available.");
  };
  private fail(message: string) {
    if (this.disposed || this.degraded)
      return;
    this.degraded = true;
    this.ready = false;
    this.styles.dispose();
    this.closeTooltip();
    this.closePopup();
    this.element.dataset.basemap = "unavailable";
    this.status(message);
    if (this.element.contains(document.activeElement))
      this.element.focus({ preventScroll: true });
    // Remove the failed instance once; no automatic remount or retry loop.
    queueMicrotask(() => this.disposeMap());
  }
  private restoreStyle = (retained: boolean) => {
    if (this.disposed || this.degraded)
      return;
    recordMapComparisonEvent(this.element, "style-loaded");
    retainCachedBasemapParents(this.map);
    tuneOpenFreeMapStyle(this.map);
    this.metrics.styleRestores++;
    if (!retained) {
      // Native JSON diff fallback can load the augmented, older scene into a
      // NEW Style with the same IDs. Discard it before publishing latest data;
      // ID existence never makes that snapshot current or restores its images.
      for (const layer of reviewLayers().reverse()) {
        if (this.map.getLayer(layer.id))
          this.map.removeLayer(layer.id);
      }
      for (const id of Object.values(SOURCE)) {
        if (this.map.getSource(id))
          this.map.removeSource(id);
      }
      this.pointOpacity.reset();
      this.published.clear();
      this.filterKeys.clear();
      this.interactionKey = "";
      this.focusKey = "";
      this.scopeDirty = true;
      this.focusedDemand = null;
      for (const [id, publication] of this.publications) {
        this.installImages(publication.data);
        recordMapComparisonEvent(this.element, `source-start:${id}`);
        this.map.addSource(id, { type: "geojson", data: publication.data, promoteId: "reviewId", cluster: false });
        this.published.set(id, publication.revision);
        this.countPublication(id, publication.data);
      }
      recordMapComparisonEvent(this.element, "layers-start");
      for (const layer of reviewLayers())
        this.map.addLayer(layer);
      recordMapComparisonEvent(this.element, "layers-end");
    }
    this.ready = true;
    this.element.dataset.basemap = "maplibre";
    this.status("");
    this.reconcile();
  };
  private installImages(data: FeatureCollection) {
    const measurements: Record<string, number> = {};
    const measuring = new URLSearchParams(location.search).get("mapDiagnostics") === "1";
    recordMapComparisonEvent(this.element, "images-start");
    for (const feature of data.features) {
      if (feature.geometry.type === "Point")
        installPointImages(this.map, feature.properties as ReviewPoint["properties"], measuring ? (name, value) => { measurements[name] = (measurements[name] ?? 0) + value; } : undefined);
    }
    recordMapComparisonEvent(this.element, "images-end", measurements);
  }
  private stage(id: string, data: FeatureCollection) {
    // Vector tiles encode numeric feature IDs. Promote our canonical string key
    // from properties so rendered hits and feature state retain semantic identity.
    data = { ...data, features: data.features.map(feature => ({ ...feature,
        properties: { ...feature.properties, reviewId: feature.id },
      })) };
    if (data.features[0]?.geometry.type === "Point") {
      data = { ...data, features: data.features.map((feature) => ({ ...feature, properties: {
            ...feature.properties, image: pointImageKey(feature.properties as ReviewPoint["properties"]),
          } })) };
    }
    if (id === SOURCE.booked || id === SOURCE.issues || id === SOURCE.homes)
      this.pointOpacity.stage(id, data);
    this.publications.set(id, { data, revision: (this.publications.get(id)?.revision ?? 0) + 1 });
  }
  private countPublication(id: string, data: FeatureCollection) {
    recordMapComparisonEvent(this.element, `publication:${id}`);
    this.metrics.publications[id] = (this.metrics.publications[id] ?? 0) + 1;
    this.metrics.features[id] = data.features.length;
  }
  private publish() {
    for (const [id, publication] of this.publications) {
      if (this.published.get(id) === publication.revision)
        continue;
      this.installImages(publication.data);
      (this.map.getSource(id) as GeoJSONSource).setData(publication.data);
      this.published.set(id, publication.revision);
      this.countPublication(id, publication.data);
    }
  }
  update(props: ReviewMapProps) {
    this.props = props;
    if (this.disposed || this.degraded)
      return;
    recordMapComparisonEvent(this.element, "preparation-start");
    const scene = props.scene, previous = this.previousScene;
    const bookedChanged = previous?.booked !== scene.booked;
    const demandChanged = previous?.demand !== scene.demand;
    const homesChanged = previous?.homes !== scene.homes;
    const issueChanged = bookedChanged || previous?.annotations.issueSeverityByVisit !== scene.annotations.issueSeverityByVisit;
    if (bookedChanged) {
      this.stage(SOURCE.booked, bookedMapPoints(scene.booked));
      this.routeBounds = new Map(scene.booked.routes.map((route) => [route.id, routeMapBounds(route)]));
    }
    if (bookedChanged || previous?.roads !== scene.roads)
      this.stage(SOURCE.roads, roadMapLines(scene.booked, scene.roads));
    if (demandChanged)
      this.stage(SOURCE.demand, demandMapPoints(scene.demand));
    if (homesChanged)
      this.stage(SOURCE.homes, homeMapPoints(scene.homes));
    if (bookedChanged || demandChanged || homesChanged) {
      this.points = new Map([SOURCE.booked, SOURCE.demand, SOURCE.homes].flatMap((id) => (this.publications.get(id)?.data.features ?? []).map((feature) => [String(feature.id), feature as ReviewPoint] as const)));
    }
    if (issueChanged) {
      this.scopeDirty = true;
      const issues = issueMapPoints(scene, this.points);
      this.issuePoints = new Map(issues.features.map((feature) => [String(feature.id), feature]));
      this.stage(SOURCE.issues, issues);
    }
    if (bookedChanged || demandChanged || homesChanged || previous?.annotations.suggestions !== scene.annotations.suggestions ||
      previous?.annotations.suggestedDemandIds !== scene.annotations.suggestedDemandIds || previous?.scope.demandIds !== scene.scope.demandIds) {
      this.stage(SOURCE.advisory, advisoryMapLines(scene));
    }
    if (!this.publications.has(SOURCE.focus))
      this.stage(SOURCE.focus, collection([]));
    if (previous?.scope.routes !== scene.scope.routes) {
      this.routeIds = scene.scope.routes.map((route) => route.id);
      this.visibleRoutes = new Set(this.routeIds);
      this.visitIds = scene.scope.routes.flatMap((route) => route.stops.map((visit) => visit.id));
      this.scopeDirty = true;
      this.interactionKey = "";
    }
    if (previous?.scope.demandIds !== scene.scope.demandIds || previous?.annotations.suggestedDemandIds !== scene.annotations.suggestedDemandIds)
      this.scopeDirty = true;
    if (bookedChanged || demandChanged || previous?.scope !== scene.scope)
      this.visibleBounds = visibleMapBounds(scene);
    if (bookedChanged || demandChanged || issueChanged)
      this.focusKey = "";
    this.previousScene = scene;
    recordMapComparisonEvent(this.element, "preparation-end");
    if (this.ready)
      this.reconcile();
  }
  private setFilter(id: string, filter: FilterSpecification) {
    const key = JSON.stringify(filter);
    if (this.filterKeys.get(id) === key)
      return;
    this.filterKeys.set(id, key);
    this.metrics.layerUpdates++;
    this.map.setFilter(id, filter);
  }
  private state(source: string, id: string, focused: boolean) {
    this.map.setFeatureState({ source, id }, { focused });
    this.metrics.featureStates++;
  }
  private reconcile() {
    this.publish();
    const { scene, selection, previewRouteId } = this.props;
    if (this.scopeDirty) {
      this.scopeDirty = false;
      const routeFilter = idsFilter("routeId", this.routeIds);
      const bookedFilter: FilterSpecification = ["any", ["all", ["==", ["get", "kind"], "home"], routeFilter],
        ["all", ["==", ["get", "kind"], "visit"], idsFilter("entityId", this.visitIds),
          ["!", idsFilter("entityId", Object.keys(scene.annotations.issueSeverityByVisit))]]];
      this.setFilter("review-booked-icon", bookedFilter);
      this.setFilter("review-issues-icon", idsFilter("entityId", this.visitIds));
      const suggested = scene.annotations.suggestedDemandIds;
      // Overlay sprites contain the whole body. Draw it once so dimming does not
      // alpha-composite two .38/.4 copies into a brighter contextual marker.
      this.setFilter("review-demand-icon", ["all", idsFilter("entityId", scene.scope.demandIds), ["!", idsFilter("entityId", suggested)]]);
      const suggestedFilter: FilterSpecification = ["all", idsFilter("entityId", scene.scope.demandIds), idsFilter("entityId", suggested)];
      this.setFilter("review-suggested-halo", suggestedFilter);
      this.setFilter("review-suggested-icon", suggestedFilter);
      this.setFilter("review-roads-hit", routeFilter);
      for (const prefix of ["roads", "fallback"]) {
        const filter: FilterSpecification = ["all", routeFilter, ["==", ["get", "kind"], prefix === "roads" ? "road" : "fallback"]];
        this.setFilter(`review-${prefix}-casing`, filter);
        this.setFilter(`review-${prefix}-line`, filter);
      }
    }
    const selectedRoute = selection.kind === "none" ? null : selection.routeId;
    this.setFilter("review-homes-icon", idsFilter("routeId", selectedRoute ? [selectedRoute] : []));
    // A selected unbooked home is valid context too; it lives outside booked scope.
    const emphasised = [...new Set([selectedRoute, previewRouteId].filter((id): id is string => Boolean(id && (this.visibleRoutes.has(id) || scene.homes.has(id)))))];
    const interactionKey = JSON.stringify(emphasised);
    if (interactionKey !== this.interactionKey) {
      this.interactionKey = interactionKey;
      const match = idsFilter("routeId", emphasised);
      for (const suffix of ["line", "casing"])
        this.setFilter(`review-emphasis-${suffix}`, ["all", match, ["==", ["get", "kind"], "road"]]);
      for (const prefix of ["roads", "fallback"]) {
        this.map.setPaintProperty(`review-${prefix}-line`, "line-opacity", emphasised.length
          ? ["case", match, ["case", ["get", "complete"], .78, .95], .25]
          : ["case", ["get", "complete"], .55, .84]);
        this.map.setPaintProperty(`review-${prefix}-casing`, "line-opacity", emphasised.length ? ["case", match, 1, .16] : .82);
        this.metrics.layerUpdates += 2;
      }
    }
    // State writes do not replace paint expressions (which reload point sources).
    // Reconcile even with equal emphasis: new publications/style managers need state.
    this.pointOpacity.reconcile(emphasised, (source, id, opacity) => {
      if (opacity === null)
        this.map.removeFeatureState({ source, id }, "reviewOpacity");
      else
        this.map.setFeatureState({ source, id }, { reviewOpacity: opacity });
      this.metrics.featureStates++;
    });
    const focused = selectedMapPoint(selection, this.points);
    const focusKey = `${focused?.id ?? ""}:${selection.kind === "demand" ? selection.demandId : ""}:${scene.annotations.issueSeverityByVisit[selection.kind === "visit" ? selection.visitId : ""] ?? ""}`;
    if (focusKey !== this.focusKey) {
      if (this.focusedDemand)
        this.state(SOURCE.advisory, `advisory:${this.focusedDemand}`, false);
      this.focusedDemand = selection.kind === "demand" ? selection.demandId : null;
      if (selection.kind === "demand")
        this.state(SOURCE.advisory, `advisory:${selection.demandId}`, true);
      this.focusKey = focusKey;
      const issue = selection.kind === "visit" ? this.issuePoints.get(`issue:${selection.visitId}`) : null;
      this.stage(SOURCE.focus, collection(focused ? [focused, ...(issue ? [issue as ReviewPoint] : [])] : []));
      this.publish();
      const match = selection.kind === "demand" ? ["==", ["get", "entityId"], selection.demandId] : null;
      for (const layer of ["review-demand-icon", "review-suggested-icon"]) {
        this.map.setPaintProperty(layer, "icon-opacity", match ? ["case", match, 1, .4] : 1);
        this.metrics.layerUpdates++;
      }
      this.map.setPaintProperty("review-suggested-halo", "circle-opacity", match ? ["case", match, .16, .064] : .16);
      this.map.setPaintProperty("review-suggested-halo", "circle-stroke-opacity", match ? ["case", match, .65, .26] : .65);
      this.metrics.layerUpdates += 2;
    }
    this.syncPopup();
    this.navigate();
    this.report();
  }
  private padding() {
    const rect = this.element.getBoundingClientRect();
    const height = rect.height;
    const visibleRect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      const bounds = element?.getBoundingClientRect();
      return element && bounds && bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).visibility !== "hidden" ? bounds : null;
    };
    const rail = visibleRect(".dispatch-map-route-rail");
    const panel = visibleRect(".dispatch-map-tools-panel");
    const toolbar = visibleRect(".dispatch-map-tools-tabs");
    return {
      left: rail ? Math.max(32, rail.right - rect.left + 12) : 32,
      right: panel ? Math.max(32, rect.right - panel.left + 12) : 32,
      top: toolbar ? Math.max(80, toolbar.bottom - rect.top + 12) : 140,
      bottom: Math.min(90, height / 5),
    };
  }
  private fit(points: [
    number,
    number
  ][], maximumZoom = 13, pointFocus = false, initialPlacement = false) {
    if (!points.length || this.element.clientWidth < 100 || this.element.clientHeight < 100)
      return false;
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (const [lng, lat] of points) {
      west = Math.min(west, lng);
      east = Math.max(east, lng);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    const padding = this.padding();
    if (pointFocus && this.popup.isOpen()) {
      const popupWidth = Math.max(160, Math.min(380, this.element.clientWidth - padding.left - padding.right - 16));
      this.popup.setMaxWidth(`${popupWidth}px`);
      this.popup.getElement()?.classList.toggle("review-libre-popup-narrow", popupWidth < 280);
      const content = this.popup.getElement()?.querySelector<HTMLElement>(".maplibregl-popup-content");
      if (content)
        content.style.maxHeight = `${Math.max(120, this.element.clientHeight - padding.top - padding.bottom - 64)}px`;
      const popupHeight = this.popup.getElement()?.getBoundingClientRect().height ?? 360;
      // fitBounds centres a point in the padded rectangle. Reserve the entire
      // popup above that point, including its offset, below the actual top HUD.
      padding.top = Math.min(this.element.clientHeight - padding.bottom - 1, padding.top + popupHeight + 56);
    }
    this.map.fitBounds([[west, south], [east, north]], { padding, maxZoom: maximumZoom, duration: this.reducedMotion.matches || initialPlacement ? 0 : 450 });
    this.metrics.cameraIntents++;
    return true;
  }
  private navigate() {
    const { selection, navigation } = this.props;
    const key = `${JSON.stringify(selection)}:${navigation.focusRequest}:${navigation.clearRequest}`;
    if (this.fitRequest !== navigation.fitVisibleRequest && navigation.initialFitReady) {
      const explicit = this.fitRequest >= 0;
      this.fitRequest = navigation.fitVisibleRequest;
      if (explicit || selection.kind === "none") {
        if (this.fit(this.visibleBounds, 13, false, !explicit && !this.initialFit))
          this.initialFit = true;
        this.cameraKey = key;
        return;
      }
    }
    if (!this.initialFit && navigation.initialFitReady && selection.kind === "none") {
      if (this.fit(this.visibleBounds, 13, false, true))
        this.initialFit = true;
      this.cameraKey = key;
      return;
    }
    if (key === this.cameraKey)
      return;
    const selected = selectedMapPoint(selection, this.points);
    if (selected) {
      if (!this.fit([selected.geometry.coordinates as [
          number,
          number
        ]], Math.max(12, this.map.getZoom()), true))
        return;
    }
    else if (selection.kind === "route") {
      const home = this.props.scene.homes.get(selection.routeId)?.base;
      if (!this.fit(this.routeBounds.get(selection.routeId) ?? (home ? [[home.longitude, home.latitude]] : [])))
        return;
    }
    this.cameraKey = key;
  }
  private closeTooltip = () => { this.tooltip.remove(); this.hoverKey = ""; };
  private closePopup() {
    this.dismissingPopup = true;
    const restore = this.popup.getElement()?.contains(document.activeElement);
    this.popup.remove();
    this.popupKey = "";
    this.popupRevision = "";
    this.dismissingPopup = false;
    if (restore)
      (this.returnFocus?.isConnected ? this.returnFocus : this.element).focus({ preventScroll: true });
  }
  private popupClosed = () => {
    this.props.onAction({ type: "popup-visibility", open: false });
    if (!this.dismissingPopup) {
      this.popupKey = "";
      this.popupRevision = "";
      this.props.onAction({ type: "clear-selection" });
      (this.returnFocus?.isConnected ? this.returnFocus : this.element).focus({ preventScroll: true });
    }
  };
  private pointContent(point: ReviewPoint) {
    const { scene } = this.props, { kind, entityId, routeId } = point.properties;
    if (kind === "demand") {
      const item = scene.demand.get(entityId);
      return item ? readyToBookPopupContent(item, scene.annotations.suggestions[entityId]) : null;
    }
    const route = scene.booked.routeById.get(routeId) ?? scene.homes.get(routeId);
    if (!route)
      return null;
    if (kind === "home")
      return baseTimingTooltip(route, scene.roads.get(routeId));
    const stop = scene.booked.visitById.get(entityId)?.visit;
    // Construct links from immutable IDs, never trust arbitrary cached URL text.
    return stop ? stopPopupContent(stop, routeTimingForStop(route, scene.roads.get(routeId), stop), scene.annotations.issueSeverityByVisit[entityId]) : null;
  }
  private syncPopup() {
    const { scene, selection } = this.props;
    const point = selectedMapPoint(selection, this.points) ?? (selection.kind === "route" && this.homePopupRouteId === selection.routeId
      ? this.points.get(`home:${selection.routeId}`) : undefined);
    if (!point) {
      if (this.popup.isOpen())
        this.closePopup();
      return;
    }
    const key = String(point.id);
    const revision = `${key}:${this.publications.get(SOURCE.roads)?.revision}:${this.publications.get(SOURCE.booked)?.revision}:${this.publications.get(SOURCE.demand)?.revision}:${this.publications.get(SOURCE.advisory)?.revision}:${this.publications.get(SOURCE.issues)?.revision}:${this.publications.get(SOURCE.homes)?.revision}`;
    if (this.popupRevision === revision)
      return;
    const content = this.pointContent(point);
    if (!content)
      return;
    const changingTarget = this.popupKey !== key;
    const hadPopupFocus = this.popup.getElement()?.contains(document.activeElement);
    if (changingTarget) {
      this.closePopup();
      this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : this.element;
    }
    const details = document.createElement("button");
    details.type = "button";
    details.className = "review-libre-details";
    details.textContent = "Open details";
    details.onclick = () => this.openPoint(point);
    if (point.properties.kind !== "home")
      content.append(details);
    this.closeTooltip();
    this.popup.setLngLat(point.geometry.coordinates as [
      number,
      number
    ]).setDOMContent(content);
    const padding = this.padding();
    this.popup.setMaxWidth(`${Math.max(160, Math.min(380, this.element.clientWidth - padding.left - padding.right - 16))}px`);
    if (!this.popup.isOpen())
      this.popup.addTo(this.map);
    this.popupKey = key;
    this.popupRevision = revision;
    if (hadPopupFocus)
      (point.properties.kind === "home" ? this.element : details).focus({ preventScroll: true });
    this.props.onAction({ type: "popup-visibility", open: true });
    const visit = selection.kind === "visit" ? scene.booked.visitById.get(selection.visitId)?.visit : null;
    this.announce(visit ? `${visit.isComplete ? "Completed" : "Open"} visit ${visit.sequence}, ${visit.companyName}, ${formatTime(visit.startDateTime)}. Popup available.`
      : selection.kind === "demand" ? `Unassigned work: ${scene.demand.get(selection.demandId)?.companyLabel}. Popup available.`
        : `Home base. ${(scene.booked.routeById.get(point.properties.routeId) ?? scene.homes.get(point.properties.routeId))?.resourceName}.`);
  }
  private hit(event: MapMouseEvent) {
    if (!this.ready)
      return undefined;
    const box: [
      [
        number,
        number
      ],
      [
        number,
        number
      ]
    ] = [[event.point.x - 4, event.point.y - 4], [event.point.x + 4, event.point.y + 4]];
    const features = this.map.queryRenderedFeatures(box, { layers: HIT_LAYERS }).filter(feature => {
      if (feature.geometry.type !== "Point")
        return true;
      const center = this.map.project(feature.geometry.coordinates as [
        number,
        number
      ]);
      return pointContainsPointer(feature.properties as ReviewPoint["properties"], this.map.getZoom(), event.point.x - center.x, event.point.y - center.y);
    });
    return features.sort((a, b) => HIT_LAYERS.indexOf(a.layer.id) - HIT_LAYERS.indexOf(b.layer.id) ||
      (b.properties?.priority ?? 0) - (a.properties?.priority ?? 0) || String(a.id).localeCompare(String(b.id)))[0];
  }
  private pointerMove = (event: MapMouseEvent) => {
    if (!this.ready || this.map.isMoving())
      return;
    const feature = this.hit(event);
    this.element.style.cursor = feature ? "pointer" : "";
    const key = feature ? `${feature.source}:${feature.id}` : "";
    if (this.hoverFeature?.id !== feature?.id) {
      this.hoverFeature = feature ?? null;
      this.props.onAction({ type: "preview-route", routeId: feature?.properties.routeId || null });
    }
    if (!feature || this.popup.isOpen()) {
      this.closeTooltip();
      return;
    }
    if (key === this.hoverKey) {
      this.tooltip.setLngLat(event.lngLat);
      return;
    }
    let content: HTMLElement | null = null;
    const { scene } = this.props;
    const route = scene.booked.routeById.get(feature.properties.routeId);
    if (feature.geometry.type === "Point") {
      const point = this.points.get(feature.properties.kind === "issue" ? `visit:${feature.properties.entityId}` : String(feature.id));
      if (point)
        content = this.pointContent(point);
    }
    else if (route) {
      const road = scene.roads.get(route.id);
      content = road && feature.properties.kind === "road" && feature.properties.legIndex >= 0
        ? routeLegTooltip(route, road, feature.properties.legIndex) : routeOrderFallbackTooltip(route);
      if (road && feature.properties.kind === "road" && feature.properties.legIndex < 0) {
        content = document.createElement("span");
        content.textContent = `${route.resourceName} · Static road geometry · per-leg timing unavailable`;
      }
    }
    if (!content)
      return;
    this.tooltip.setLngLat(event.lngLat).setDOMContent(content).addTo(this.map);
    this.hoverKey = key;
  };
  private pointerLeave = () => {
    const hadHover = this.hoverFeature !== null;
    this.closeTooltip();
    this.hoverFeature = null;
    this.element.style.cursor = "";
    if (hadHover)
      this.props.onAction({ type: "preview-route", routeId: null });
  };
  private click = (event: MapMouseEvent) => {
    if (event.originalEvent.target instanceof Element && event.originalEvent.target.closest(".maplibregl-popup, .maplibregl-ctrl"))
      return;
    const feature = this.hit(event);
    if (!feature) {
      this.props.onAction({ type: "clear-selection" });
      return;
    }
    const { kind, entityId, routeId } = feature.properties;
    this.homePopupRouteId = kind === "home" ? routeId : null;
    if (kind === "visit" || kind === "issue")
      this.props.onAction({ type: "select-visit", visitId: entityId, routeId });
    else if (kind === "demand")
      this.props.onAction({ type: "select-demand", demandId: entityId });
    else
      this.props.onAction({ type: "select-route", routeId });
  };
  private openPoint(point: ReviewPoint) {
    const { kind, entityId } = point.properties;
    if (kind === "demand")
      this.props.onAction({ type: "open-demand", demandId: entityId });
    else if (kind === "visit")
      this.props.onAction({ type: "open-visit", visitId: entityId });
  }
  private doubleClick = (event: MapMouseEvent) => {
    if (event.originalEvent.target instanceof Element && event.originalEvent.target.closest(".maplibregl-popup, .maplibregl-ctrl"))
      return;
    const feature = this.hit(event);
    const point = feature && this.points.get(feature.properties.kind === "issue" ? `visit:${feature.properties.entityId}` : String(feature.id));
    if (point) {
      event.preventDefault();
      this.openPoint(point);
    }
  };
  private keyboardCamera = (event: Event) => {
    if (!this.ready || this.degraded)
      return;
    this.metrics.keyboardCommands++;
    this.report();
    const intent = (event as CustomEvent<{
      type: string;
      direction: string;
    }>).detail;
    const duration = this.reducedMotion.matches ? 0 : 160;
    if (intent.type === "pan-map") {
      const offsets: Record<string, [
        number,
        number
      ]> = { left: [-80, 0], right: [80, 0], up: [0, -80], down: [0, 80] };
      this.map.panBy(offsets[intent.direction], { duration });
    }
    else
      this.map.zoomTo(this.map.getZoom() + (intent.direction === "in" ? .5 : -.5), { duration });
  };
  private report() {
    // Small counters only, no customer facts. Opt-in capture reads the same DOM surface.
    this.element.dataset.mapMetrics = JSON.stringify(this.metrics);
  }
  private inspect(id?: string) {
    const first = id ? this.points.get(id) : [...this.points.values()].find((point) => point.properties.kind === "visit" && !point.properties.complete && this.visitIds.includes(point.properties.entityId));
    const position = first && !this.degraded ? this.map.project(first.geometry.coordinates as [
      number,
      number
    ]) : null;
    const rect = this.element.getBoundingClientRect();
    if (id)
      return { firstVisit: position ? { left: position.x + rect.left, top: position.y + rect.top,
          transform: `${position.x},${position.y},${this.map.getZoom()}` } : null };
    return { metrics: this.metrics, ready: this.ready, moving: !this.degraded && this.map.isMoving(), hoverKey: this.hoverKey,
      hitsAtPoint: position && this.ready ? this.map.queryRenderedFeatures(position, { layers: HIT_LAYERS }).map(f => ({ id: f.id, layer: f.layer.id })) : [], firstVisit: position ? {
        left: position.x + rect.left, top: position.y + rect.top, transform: `${position.x},${position.y},${this.map.getZoom()}`,
      } : null, camera: this.degraded ? null : { center: this.map.getCenter(), zoom: this.map.getZoom() },
      sourceIds: this.ready ? Object.keys(this.map.getStyle().sources).filter((id) => id.startsWith("review-")) : [],
      renderedPointIds: this.ready ? [...new Set(this.map.queryRenderedFeatures({ layers: HIT_LAYERS }).filter((feature) => feature.geometry.type === "Point").map((feature) => String(feature.id)))] : [],
    };
  }
  /** Use native control content/lifecycle in the React-owned chrome outlets. */
  private addChromeControl(control: IControl, target: HTMLElement) {
    this.map.addControl({
      onAdd: (map) => {
        target.append(control.onAdd(map));
        const placeholder = document.createElement("div");
        placeholder.hidden = true;
        return placeholder;
      },
      onRemove: (map) => control.onRemove(map),
    });
  }
  private disposeMap() {
    if (this.metrics.mapsRemoved)
      return;
    this.metrics.mapsRemoved++;
    const canvasContainer = this.map.getCanvasContainer();
    canvasContainer.removeEventListener("pointerdown", this.captureMouseDrag);
    canvasContainer.removeEventListener("lostpointercapture", this.cancelCapturedMouseDrag);
    canvasContainer.removeEventListener("pointercancel", this.cancelCapturedMouseDrag);
    if (this.capturedMousePointer !== null && canvasContainer.hasPointerCapture(this.capturedMousePointer)) {
      canvasContainer.releasePointerCapture(this.capturedMousePointer);
    }
    this.capturedMousePointer = null;
    this.map.off("webglcontextlost", this.contextLost);
    this.map.off("error", this.mapError);
    this.map.remove();
    this.report();
  }
  dispose() {
    if (this.disposed)
      return;
    this.disposed = true;
    this.styles.dispose();
    this.resizeObserver.disconnect();
    this.themeObserver.disconnect();
    this.reducedMotion.removeEventListener("change", this.motionChanged);
    window.removeEventListener("review-map-camera", this.keyboardCamera);
    this.closeTooltip();
    this.closePopup();
    this.popup.off("close", this.popupClosed);
    this.disposeMap();
    this.removeDiagnostics();
  }
}
