import {
  OSRM_DEADLINE_ERROR,
  isOsrmRequestGuardError,
  osrmRouting,
  waitForOsrmDeadline,
} from "./osrm";
import type { OsrmRequestContext, RoadRouteResult, RouteRequest } from "./osrm";

const ROUTE_CACHE_MS = 6 * 60 * 60 * 1000;

const ROUTE_ERROR_CACHE_MS = 60 * 1000;

const ROUTE_CACHE_MAX_ENTRIES = 500;

export const ROUTE_BATCH_MAX_WAYPOINTS = 400;

export function isRoute(value: unknown): value is RouteRequest {
  if (!value || typeof value !== "object") return false;
  const route = value as Partial<RouteRequest>;
  return (
    typeof route.id === "string" &&
    route.id.length > 0 &&
    route.id.length <= 120 &&
    Array.isArray(route.coordinates) &&
    route.coordinates.length >= 2 &&
    route.coordinates.length <= 40 &&
    route.coordinates.every(
      (coordinate) =>
        Array.isArray(coordinate) &&
        coordinate.length === 2 &&
        Number.isFinite(coordinate[0]) &&
        Number.isFinite(coordinate[1]) &&
        coordinate[0] >= -90 &&
        coordinate[0] <= 90 &&
        coordinate[1] >= -180 &&
        coordinate[1] <= 180,
    )
  );
}

const routeCache = new Map<
  string,
  { expiresAt: number; result: RoadRouteResult; }
>();

const routeInflight = new Map<string, Promise<RoadRouteResult>>();

function pruneRouteCache() {
  const now = Date.now();
  for (const [key, value] of routeCache) {
    if (value.expiresAt <= now) routeCache.delete(key);
  }
  while (routeCache.size >= ROUTE_CACHE_MAX_ENTRIES) {
    const oldest = routeCache.keys().next().value;
    if (oldest === undefined) break;
    routeCache.delete(oldest);
  }
}

function routeCacheKey(coordinates: Array<[number, number]>) {
  return coordinates
    .map(([latitude, longitude]) =>
      `${latitude.toFixed(5)},${longitude.toFixed(5)}`,
    )
    .join(";");
}

function routeCacheDuration(result: RoadRouteResult) {
  const errors = [result.error, ...(result.legErrors ?? [])].filter(
    (value): value is string => Boolean(value),
  );
  if (errors.some(isOsrmRequestGuardError)) return null;
  return errors.length ? ROUTE_ERROR_CACHE_MS : ROUTE_CACHE_MS;
}

export async function cachedRouteOnRoads(
  route: RouteRequest,
  context: OsrmRequestContext,
) {
  const key = routeCacheKey(route.coordinates);
  const cached = routeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, id: route.id };
  }
  if (cached) routeCache.delete(key);

  const existing = routeInflight.get(key);
  if (existing) {
    const joined = await waitForOsrmDeadline(existing, context.deadlineAt);
    return joined.completed
      ? { ...joined.value, id: route.id }
      : { id: route.id, error: OSRM_DEADLINE_ERROR };
  }

  const pending = osrmRouting.routeOnRoads(route, context);
  routeInflight.set(key, pending);
  try {
    const result = await pending;
    const cacheDuration = routeCacheDuration(result);
    if (cacheDuration !== null) {
      pruneRouteCache();
      routeCache.set(key, {
        result,
        expiresAt: Date.now() + cacheDuration,
      });
    }
    return result;
  } finally {
    routeInflight.delete(key);
  }
}

export async function resolveRouteGeometry(
  routes: RouteRequest[],
  routingContext: OsrmRequestContext,
) {
  const results: RoadRouteResult[] = [];
  for (let index = 0; index < routes.length; index += 4) {
    if (Date.now() >= routingContext.deadlineAt) {
      results.push(
        ...routes.slice(index).map((route) => ({
          id: route.id,
          error: OSRM_DEADLINE_ERROR,
        })),
      );
      break;
    }
    results.push(
      ...(await Promise.all(
        routes
          .slice(index, index + 4)
          .map((route) => cachedRouteOnRoads(route, routingContext)),
      )),
    );
  }
  return results;
}
