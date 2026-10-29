import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import type { ReviewMapScene, ReviewMapSelection } from "./contracts";
import type { EngineerRoute } from "@/modules/routing/contracts";
import { demandWorkstreamColour } from "@/modules/work/presentation";
export type ReviewPointProperties = {
  kind: "visit" | "home" | "demand" | "issue";
  entityId: string;
  routeId: string;
  colour: string;
  label: string;
  complete: boolean;
  thirdParty: boolean;
  attention: boolean;
  excluded: boolean;
  priority: number;
  severity?: "critical" | "warning" | "data";
};
export type ReviewPoint = Feature<Point, ReviewPointProperties>;
export type ReviewLine = Feature<LineString, {
  routeId: string;
  entityId: string;
  legIndex: number;
  colour: string;
  complete: boolean;
  kind: "road" | "fallback" | "advisory";
}>;
export function collection<T extends Point | LineString, P>(features: Feature<T, P>[]): FeatureCollection<T, P> {
  return { type: "FeatureCollection", features };
}
export function mapCoordinate(value: {
  latitude: number | null;
  longitude: number | null;
}): [
  number,
  number
] | null {
  const { latitude: lat, longitude: lng } = value;
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lng, lat] : null;
}
function point(id: string, coordinates: [
  number,
  number
], properties: ReviewPointProperties): ReviewPoint {
  return { type: "Feature", id, geometry: { type: "Point", coordinates }, properties };
}
const basic = { complete: false, thirdParty: false, attention: false, excluded: false };
/** GPU point facts are independent of roads, issues, scope and interaction. */
export function bookedMapPoints(booked: ReviewMapScene["booked"]) {
  const features: ReviewPoint[] = [];
  for (const route of booked.routes) {
    const home = route.base && mapCoordinate(route.base);
    if (home)
      features.push(point(`home:${route.id}`, home, {
        ...basic, kind: "home", entityId: route.id, routeId: route.id, colour: route.colour, label: "⌂", priority: 1500,
      }));
    for (const visit of route.stops) {
      const location = mapCoordinate(visit);
      if (!location)
        continue;
      features.push(point(`visit:${visit.id}`, location, {
        ...basic, kind: "visit", entityId: visit.id, routeId: route.id, colour: route.colour,
        label: String(visit.sequence), complete: visit.isComplete, thirdParty: visit.ownerType === "third-party",
        priority: visit.ownerType === "third-party" ? 3000 : visit.isComplete ? 1000 : 2000,
      }));
    }
  }
  return collection(features);
}
export function demandMapPoints(demand: ReviewMapScene["demand"]) {
  return collection([...demand.values()].flatMap((item): ReviewPoint[] => {
    const location = mapCoordinate(item);
    return location ? [point(`demand:${item.id}`, location, {
        ...basic, kind: "demand", entityId: item.id, routeId: "", colour: demandWorkstreamColour(item.workstream),
        label: item.workstream === "install" ? "I" : item.workstream === "support" ? "S" : "M",
        attention: item.ageBand === "aged" || item.overdue || item.readiness === "blocked" || Boolean(item.exclusionReason),
        excluded: Boolean(item.exclusionReason), severity: item.overdue ? "critical" : "warning", priority: 5000,
      })] : [];
  }));
}
export function homeMapPoints(homes: ReviewMapScene["homes"]) {
  return collection([...homes.values()].flatMap((route): ReviewPoint[] => {
    const home = route.base && mapCoordinate(route.base);
    return home ? [point(`home:${route.id}`, home, {
        ...basic, kind: "home", entityId: route.id, routeId: route.id, colour: route.colour, label: "⌂", priority: 1500,
      })] : [];
  }));
}
/** Consume canonical geometry verbatim: never join the visible stop projection. */
export function roadMapLines(booked: ReviewMapScene["booked"], roads: ReviewMapScene["roads"]) {
  const features: ReviewLine[] = [];
  for (const route of booked.routes) {
    const road = roads.get(route.id);
    const destinations = new Map(route.stops.map((stop) => [stop.inboundLegIndex, stop]));
    const add = (coordinates: [
      number,
      number
    ][], legIndex: number, kind: "road" | "fallback") => {
      if (coordinates.length < 2)
        return;
      features.push({ type: "Feature", id: `${route.id}:${kind}:${legIndex}`,
        geometry: { type: "LineString", coordinates: coordinates.map(([lat, lng]) => [lng, lat]) },
        properties: { routeId: route.id, entityId: route.id, legIndex, colour: route.colour, kind,
          complete: legIndex === route.returnLegIndex ? route.stops.length > 0 && route.stops.every((stop) => stop.isComplete)
            : Boolean(destinations.get(legIndex)?.isComplete) },
      });
    };
    if (road?.legGeometries?.some((leg) => leg.length >= 2)) {
      road.legGeometries.forEach((leg, index) => add(leg, index, "road"));
    }
    else if (road?.geometry && road.geometry.length >= 2) {
      add(road.geometry, -1, "road");
    }
    else if (route.stops[0]?.ownerType === "internal") {
      add(route.coordinates, -1, "fallback");
    }
  }
  return collection(features);
}
export function issueMapPoints(scene: ReviewMapScene, points: ReadonlyMap<string, ReviewPoint>) {
  return collection(Object.entries(scene.annotations.issueSeverityByVisit).flatMap(([id, severity]): ReviewPoint[] => {
    const visit = points.get(`visit:${id}`);
    return visit ? [{ ...visit, id: `issue:${id}`, properties: { ...visit.properties, kind: "issue", severity, priority: 4000 } }] : [];
  }));
}
export function advisoryMapLines(scene: ReviewMapScene) {
  const visible = new Set(scene.scope.demandIds);
  return collection(scene.annotations.suggestedDemandIds.flatMap((id): ReviewLine[] => {
    const suggestion = scene.annotations.suggestions[id];
    const demand = scene.demand.get(id);
    const route = suggestion && (scene.booked.routeById.get(suggestion.routeId) ?? scene.homes.get(suggestion.routeId));
    const anchor = suggestion && (scene.booked.visitById.get(suggestion.stopId)?.visit ??
      (suggestion.method === "nearest-home-base" ? route?.base : null));
    const from = demand && mapCoordinate(demand);
    const to = anchor && mapCoordinate(anchor);
    return visible.has(id) && suggestion && from && to ? [{
        type: "Feature", id: `advisory:${id}`, geometry: { type: "LineString", coordinates: [from, to] },
        properties: { kind: "advisory", routeId: suggestion.routeId, entityId: id, legIndex: -1, colour: "#e8a317", complete: false },
      }] : [];
  }));
}
export function selectedMapPoint(selection: ReviewMapSelection, points: ReadonlyMap<string, ReviewPoint>) {
  return selection.kind === "visit" ? points.get(`visit:${selection.visitId}`)
    : selection.kind === "demand" ? points.get(`demand:${selection.demandId}`) : undefined;
}
/** Cached bounds exclude domain-marked outliers, without changing route facts. */
export function routeMapBounds(route: EngineerRoute) {
  const points: [
    number,
    number
  ][] = route.base ? [mapCoordinate(route.base)!] : [];
  for (const stop of route.stops) {
    const location = mapCoordinate(stop);
    if (location && !stop.isOutOfRange)
      points.push(location);
  }
  return points.filter(Boolean);
}
export function visibleMapBounds(scene: ReviewMapScene) {
  const points: [
    number,
    number
  ][] = [];
  for (const route of scene.scope.routes) {
    const home = route.base && mapCoordinate(route.base);
    if (home)
      points.push(home);
    for (const stop of route.stops) {
      const location = mapCoordinate(stop);
      if (location && (scene.scope.includeOutOfCoverageInFit || (!stop.isOutOfRange && stop.ownerType !== "third-party")))
        points.push(location);
    }
  }
  for (const id of scene.scope.demandIds) {
    const item = scene.demand.get(id);
    const location = item && mapCoordinate(item);
    if (item && location && (scene.scope.includeOutOfCoverageInFit || item.exclusionReason !== "no_covered_base"))
      points.push(location);
  }
  return points;
}
