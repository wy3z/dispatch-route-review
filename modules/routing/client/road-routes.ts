import { groupBy } from "../../../shared/collections";
import type { EngineerRoute, RoadRoute } from "../contracts";

type RoutableRoute = Pick<EngineerRoute, "id" | "coordinates">;

type RoadRouteCacheEntry = {
  expiresAt: number;
  result: RoadRoute;
};

const BATCH_SIZE = 4;
const ROAD_ROUTE_CACHE_TTL_MS = 30 * 60 * 1000;
const ROAD_ROUTE_FAILURE_CACHE_TTL_MS = 30 * 1000;
const ROAD_ROUTE_FAILURE_CACHE_MAX_TTL_MS = 5 * 60 * 1000;
const ROAD_ROUTE_CACHE_MAX_ENTRIES = 64;
const ROAD_ROUTE_REQUEST_TIMEOUT_MS = 25 * 1000;
const ROAD_ROUTE_REQUEST_COOLDOWN_MS = 30 * 1000;
const roadRouteCache = new Map<string, RoadRouteCacheEntry>();
const roadRouteRequestStartedAt = new Map<string, number>();

function cacheKey(route: RoutableRoute) {
  return route.coordinates
    .map(([latitude, longitude]) =>
      `${latitude.toFixed(5)},${longitude.toFixed(5)}`,
    )
    .join(";");
}

function pruneRoadRouteCache(now: number) {
  for (const [key, cached] of roadRouteCache) {
    if (cached.expiresAt <= now) roadRouteCache.delete(key);
  }
  for (const [key, startedAt] of roadRouteRequestStartedAt) {
    if (now - startedAt >= ROAD_ROUTE_REQUEST_COOLDOWN_MS) {
      roadRouteRequestStartedAt.delete(key);
    }
  }
  while (roadRouteRequestStartedAt.size > ROAD_ROUTE_CACHE_MAX_ENTRIES) {
    const oldest = roadRouteRequestStartedAt.keys().next().value;
    if (oldest === undefined) break;
    roadRouteRequestStartedAt.delete(oldest);
  }
}

function claimAvailableRoadRouteRequests(
  routes: RoutableRoute[],
  now = Date.now(),
) {
  pruneRoadRouteCache(now);
  const routesByKey = groupBy(routes, cacheKey);

  const claimed: RoutableRoute[] = [];
  const cooling: RoutableRoute[] = [];
  routesByKey.forEach((group, key) => {
    if (roadRouteRequestStartedAt.has(key)) {
      cooling.push(...group);
      return;
    }
    roadRouteRequestStartedAt.set(key, now);
    claimed.push(...group);
  });
  return { claimed, cooling };
}

function cachedResult(route: RoutableRoute) {
  const key = cacheKey(route);
  const cached = roadRouteCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    roadRouteCache.delete(key);
    return null;
  }

  // Refresh insertion order so the Map's oldest entry is the least recently used.
  roadRouteCache.delete(key);
  roadRouteCache.set(key, cached);
  return { ...cached.result, id: route.id };
}

function cacheResult(
  route: RoutableRoute,
  result: RoadRoute,
  failureTtlMs = ROAD_ROUTE_FAILURE_CACHE_TTL_MS,
) {
  const now = Date.now();
  const key = cacheKey(route);
  pruneRoadRouteCache(now);
  // Once a result is retained, its success/failure TTL becomes the gate. The
  // separate request claim is only needed for requests aborted before a result.
  roadRouteRequestStartedAt.delete(key);
  roadRouteCache.delete(key);
  while (roadRouteCache.size >= ROAD_ROUTE_CACHE_MAX_ENTRIES) {
    const oldest = roadRouteCache.keys().next().value;
    if (oldest === undefined) break;
    roadRouteCache.delete(oldest);
  }
  roadRouteCache.set(key, {
    expiresAt:
      now +
      (isCompleteRoadRoute(result)
        ? ROAD_ROUTE_CACHE_TTL_MS
        : Math.min(
            ROAD_ROUTE_FAILURE_CACHE_MAX_TTL_MS,
            Math.max(ROAD_ROUTE_FAILURE_CACHE_TTL_MS, failureTtlMs),
          )),
    result,
  });
}

function orderedResults(
  routes: RoutableRoute[],
  results: Map<string, RoadRoute>,
) {
  return routes.flatMap((route) => {
    const result = results.get(route.id);
    return result ? [result] : [];
  });
}

function isCompleteRoadRoute(result: RoadRoute) {
  return !result.error && !result.legErrors?.some(Boolean);
}

function retainResult(
  source: RoutableRoute,
  result: RoadRoute,
  results: Map<string, RoadRoute>,
  failureTtlMs?: number,
) {
  const identifiedResult = { ...result, id: source.id };
  results.set(source.id, identifiedResult);
  // Retain provider failures briefly so semantically identical renders or
  // remounts cannot hammer the API while its downstream service is down.
  cacheResult(source, identifiedResult, failureTtlMs);
}

function retainRequestFailure(
  routes: RoutableRoute[],
  error: unknown,
  results: Map<string, RoadRoute>,
  failureTtlMs?: number,
) {
  const message = error instanceof Error ? error.message : String(error);
  routes.forEach((route) => {
    retainResult(
      route,
      {
        id: route.id,
        error: message || "Road-routing service unavailable.",
      },
      results,
      failureTtlMs,
    );
  });
}

function retryAfterMilliseconds(response: Response) {
  const value = response.headers.get("Retry-After");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : undefined;
}

function requestSignal(signal: AbortSignal) {
  return AbortSignal.any([
    signal,
    AbortSignal.timeout(ROAD_ROUTE_REQUEST_TIMEOUT_MS),
  ]);
}

function requestFailure(error: unknown) {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new Error("Road routing took too long. Try again shortly.");
  }
  return error;
}

export async function loadRoadRoutes(
  routes: RoutableRoute[],
  signal: AbortSignal,
) {
  const missing: RoutableRoute[] = [];
  const results = new Map<string, RoadRoute>();
  routes.forEach((route) => {
    const cached = cachedResult(route);
    if (cached) {
      results.set(route.id, cached);
    } else {
      missing.push(route);
    }
  });
  if (!missing.length) {
    return orderedResults(routes, results);
  }

  const { claimed, cooling } = claimAvailableRoadRouteRequests(missing);
  if (cooling.length) {
    retainRequestFailure(
      cooling,
      new Error("Road routing is cooling down after a recent request."),
      results,
    );
  }

  for (let index = 0; index < claimed.length; index += BATCH_SIZE) {
    const batch = claimed.slice(index, index + BATCH_SIZE);
    let response: Response;
    try {
      response = await fetch("/api/route-geometry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routes: batch }),
        signal: requestSignal(signal),
        redirect: "error",
      });
    } catch (error) {
      if (signal.aborted) throw error;
      retainRequestFailure(
        claimed.slice(index),
        requestFailure(error),
        results,
      );
      break;
    }

    const payload = (await response.json().catch(() => null)) as {
      routes?: RoadRoute[];
      message?: string;
    } | null;
    if (!response.ok) {
      retainRequestFailure(
        claimed.slice(index),
        new Error(payload?.message || `Routing failed (${response.status}).`),
        results,
        retryAfterMilliseconds(response),
      );
      break;
    }

    const payloadById = new Map(
      (payload?.routes ?? []).map((result) => [result.id, result]),
    );
    batch.forEach((source) => {
      retainResult(
        source,
        payloadById.get(source.id) ?? {
          id: source.id,
          error: "The road-routing service did not return this route.",
        },
        results,
      );
    });
  }

  return orderedResults(routes, results);
}
