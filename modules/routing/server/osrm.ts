import type { RoadRoute } from "../contracts";

export type RouteRequest = {
  id: string;
  coordinates: Array<[number, number]>;
};

type OsrmRoute = {
  distance: number;
  duration: number;
  geometry: {
    type: "LineString";
    coordinates: Array<[number, number]>;
  };
  legs: Array<{
    distance: number;
    duration: number;
    steps: Array<{
      geometry: {
        type: "LineString";
        coordinates: Array<[number, number]>;
      };
    }>;
  }>;
};

type OsrmReply = {
  result?: OsrmRoute;
  code?: string;
  error?: string;
};

export type OsrmRequestContext = {
  deadlineAt: number;
  callsUsed: number;
};

type TimeoutSignalFactory = (milliseconds: number) => AbortSignal;

type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

type OsrmLimits = {
  maxCallsPerRequest: number;
  requestDeadlineMs: number;
  requestTimeoutMs: number;
  maxConcurrency: number;
  maxFallbackLegs: number;
  rateLimitRequests: number;
  rateLimitWindowMs: number;
  circuitFailureThreshold: number;
  circuitOpenMs: number;
};

export const OSRM_MAX_CALLS_PER_REQUEST = 48;
export const OSRM_REQUEST_DEADLINE_MS = 20 * 1000;
export const OSRM_REQUEST_TIMEOUT_MS = 15 * 1000;
export const OSRM_MAX_CONCURRENCY = 4;
export const OSRM_MAX_FALLBACK_LEGS = 8;
export const ROUTE_GEOMETRY_RATE_LIMIT_REQUESTS = 30;
export const ROUTE_GEOMETRY_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const OSRM_CIRCUIT_FAILURE_THRESHOLD = 5;
export const OSRM_CIRCUIT_OPEN_MS = 30 * 1000;

export const OSRM_BUDGET_ERROR =
  "Road-routing provider call budget exhausted for this request.";
export const OSRM_DEADLINE_ERROR =
  "Road-routing request deadline exceeded.";
export const OSRM_CIRCUIT_OPEN_ERROR =
  "Road-routing provider is temporarily unavailable after repeated failures.";
export const OSRM_FALLBACK_LIMIT_ERROR =
  "Road-routing per-leg fallback limit reached.";

const DEFAULT_LIMITS: OsrmLimits = {
  maxCallsPerRequest: OSRM_MAX_CALLS_PER_REQUEST,
  requestDeadlineMs: OSRM_REQUEST_DEADLINE_MS,
  requestTimeoutMs: OSRM_REQUEST_TIMEOUT_MS,
  maxConcurrency: OSRM_MAX_CONCURRENCY,
  maxFallbackLegs: OSRM_MAX_FALLBACK_LEGS,
  rateLimitRequests: ROUTE_GEOMETRY_RATE_LIMIT_REQUESTS,
  rateLimitWindowMs: ROUTE_GEOMETRY_RATE_LIMIT_WINDOW_MS,
  circuitFailureThreshold: OSRM_CIRCUIT_FAILURE_THRESHOLD,
  circuitOpenMs: OSRM_CIRCUIT_OPEN_MS,
};

const DEVELOPMENT_OSRM_BASE_URL = "https://router.project-osrm.org";

function osrmBaseUrl() {
  const configured = process.env.OSRM_BASE_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "https:") {
      throw new Error("OSRM_BASE_URL must use HTTPS.");
    }
    return url.toString().replace(/\/+$/, "");
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("OSRM_BASE_URL is required in production.");
  }
  return DEVELOPMENT_OSRM_BASE_URL;
}

class DeadlineSemaphore {
  private active = 0;
  private readonly waiting: Array<{
    resolve: (release: (() => void) | null) => void;
    deadlineAt: number;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(
    private readonly limit: number,
    private readonly now: () => number,
  ) {}

  async acquire(deadlineAt: number) {
    if (this.now() >= deadlineAt) return null;
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaseHandle();
    }

    return new Promise<(() => void) | null>((resolve) => {
      const remainingMs = Math.max(0, deadlineAt - this.now());
      const waiter = {
        resolve,
        deadlineAt,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          resolve(null);
        }, remainingMs),
      };
      this.waiting.push(waiter);
    });
  }

  private releaseHandle() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.dispatch();
    };
  }

  private dispatch() {
    while (this.active < this.limit && this.waiting.length) {
      const waiter = this.waiting.shift();
      if (!waiter) break;
      clearTimeout(waiter.timer);
      if (this.now() >= waiter.deadlineAt) {
        waiter.resolve(null);
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseHandle());
    }
  }
}

class CircuitBreaker {
  private consecutiveFailures = 0;
  private openUntil = 0;
  private halfOpenProbe = false;

  constructor(
    private readonly failureThreshold: number,
    private readonly openMs: number,
    private readonly now: () => number,
  ) {}

  isOpen() {
    if (!this.openUntil) return false;
    if (this.now() < this.openUntil) return true;
    return this.halfOpenProbe;
  }

  allowCall() {
    const now = this.now();
    if (!this.openUntil) return true;
    if (now < this.openUntil || this.halfOpenProbe) return false;
    this.halfOpenProbe = true;
    return true;
  }

  recordHealthy() {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.halfOpenProbe = false;
  }

  recordFailure() {
    this.consecutiveFailures += 1;
    if (
      this.halfOpenProbe ||
      this.consecutiveFailures >= this.failureThreshold
    ) {
      this.openUntil = this.now() + this.openMs;
      this.halfOpenProbe = false;
    }
  }
}

class FixedWindowRateLimiter {
  private readonly entries = new Map<
    string,
    { startedAt: number; requests: number }
  >();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  take(key: string): RateLimitResult {
    const now = this.now();
    const current = this.entries.get(key);
    if (!current || current.startedAt + this.windowMs <= now) {
      this.entries.set(key, { startedAt: now, requests: 1 });
      this.prune(now);
      return { allowed: true };
    }
    if (current.requests >= this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((current.startedAt + this.windowMs - now) / 1000),
        ),
      };
    }
    current.requests += 1;
    return { allowed: true };
  }

  private prune(now: number) {
    for (const [key, entry] of this.entries) {
      if (entry.startedAt + this.windowMs <= now) this.entries.delete(key);
    }
  }
}

function geometry(result: OsrmRoute) {
  return result.geometry.coordinates.map(
    ([longitude, latitude]) => [latitude, longitude] as [number, number],
  );
}

function legGeometry(leg: OsrmRoute["legs"][number]) {
  return leg.steps.flatMap((step, stepIndex) =>
    step.geometry.coordinates
      .slice(stepIndex ? 1 : 0)
      .map(
        ([longitude, latitude]) =>
          [latitude, longitude] as [number, number],
      ),
  );
}

function providerFailure(response: Response) {
  return response.status === 429 || response.status >= 500;
}

function guardReply(code: string, error: string): OsrmReply {
  return { code, error };
}

export function isOsrmRequestGuardError(value: string | null | undefined) {
  return (
    value === OSRM_BUDGET_ERROR ||
    value === OSRM_DEADLINE_ERROR ||
    value === OSRM_CIRCUIT_OPEN_ERROR
  );
}

export class OsrmRoutingService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: () => string;
  private readonly timeoutSignal: TimeoutSignalFactory;
  private readonly limits: OsrmLimits;
  private readonly semaphore: DeadlineSemaphore;
  private readonly circuit: CircuitBreaker;
  private readonly rateLimiter: FixedWindowRateLimiter;

  constructor(options?: {
    fetchImpl?: typeof fetch;
    now?: () => number;
    baseUrl?: () => string;
    timeoutSignal?: TimeoutSignalFactory;
    limits?: Partial<OsrmLimits>;
  }) {
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.now = options?.now ?? Date.now;
    this.baseUrl = options?.baseUrl ?? osrmBaseUrl;
    this.timeoutSignal = options?.timeoutSignal ?? AbortSignal.timeout;
    this.limits = { ...DEFAULT_LIMITS, ...options?.limits };
    this.semaphore = new DeadlineSemaphore(
      this.limits.maxConcurrency,
      this.now,
    );
    this.circuit = new CircuitBreaker(
      this.limits.circuitFailureThreshold,
      this.limits.circuitOpenMs,
      this.now,
    );
    this.rateLimiter = new FixedWindowRateLimiter(
      this.limits.rateLimitRequests,
      this.limits.rateLimitWindowMs,
      this.now,
    );
  }

  beginRequest(): OsrmRequestContext {
    return {
      deadlineAt: this.now() + this.limits.requestDeadlineMs,
      callsUsed: 0,
    };
  }

  takeCallerRequest(callerKey: string) {
    return this.rateLimiter.take(callerKey);
  }

  async routeOnRoads(
    route: RouteRequest,
    context: OsrmRequestContext,
  ): Promise<RoadRouteResult> {
    const complete = await this.requestOsrmRoute(route.coordinates, context);
    if (complete.result) {
      const result = complete.result;
      return {
        id: route.id,
        geometry: geometry(result),
        legGeometries: result.legs.map(legGeometry),
        legDurationsMinutes: result.legs.map((leg) =>
          Math.max(0, Math.round(leg.duration / 60)),
        ),
        legDistancesKm: result.legs.map(
          (leg) => Math.round(leg.distance / 100) / 10,
        ),
        legErrors: result.legs.map(() => null),
        totalDurationMinutes: Math.max(0, Math.round(result.duration / 60)),
        totalDistanceKm: Math.round(result.distance / 100) / 10,
      };
    }
    if (complete.code !== "NoRoute") {
      return {
        id: route.id,
        error: complete.error || "Road-routing service unavailable.",
      };
    }

    const legCount = route.coordinates.length - 1;
    const legs: Array<OsrmReply | null> = Array.from(
      { length: legCount },
      () => null,
    );
    for (let index = 0; index < legCount; index += 1) {
      if (index >= this.limits.maxFallbackLegs) {
        legs[index] = guardReply("FallbackLimit", OSRM_FALLBACK_LIMIT_ERROR);
        continue;
      }
      const leg = await this.requestOsrmRoute(
        [route.coordinates[index], route.coordinates[index + 1]],
        context,
      );
      legs[index] = leg;
      if (isOsrmRequestGuardError(leg.error)) {
        for (let remaining = index + 1; remaining < legCount; remaining += 1) {
          legs[remaining] = guardReply(
            leg.code || "RequestGuard",
            leg.error || OSRM_DEADLINE_ERROR,
          );
        }
        break;
      }
    }

    const completeLegs = legs.map(
      (leg) => leg ?? guardReply("FallbackLimit", OSRM_FALLBACK_LIMIT_ERROR),
    );
    const successfulLegs = completeLegs.filter((leg) => leg.result);
    if (!successfulLegs.length) {
      return {
        id: route.id,
        error: complete.error || "No road route was found.",
        legErrors: completeLegs.map(
          (leg) => leg.error || "No road route was found.",
        ),
      };
    }

    const legGeometries = completeLegs.map((leg) =>
      leg.result ? geometry(leg.result) : [],
    );
    const legDurationsMinutes = completeLegs.map((leg) =>
      leg.result ? Math.max(0, Math.round(leg.result.duration / 60)) : null,
    );
    const legDistancesKm = completeLegs.map((leg) =>
      leg.result ? Math.round(leg.result.distance / 100) / 10 : null,
    );
    const legErrors = completeLegs.map((leg) => leg.error ?? null);
    return {
      id: route.id,
      legGeometries,
      legDurationsMinutes,
      legDistancesKm,
      legErrors,
      totalDurationMinutes: legDurationsMinutes.reduce<number>(
        (total, duration) => total + (duration ?? 0),
        0,
      ),
      totalDistanceKm:
        Math.round(
          legDistancesKm.reduce<number>(
            (total, distance) => total + (distance ?? 0),
            0,
          ) * 10,
        ) / 10,
    };
  }

  private async requestOsrmRoute(
    routeCoordinates: Array<[number, number]>,
    context: OsrmRequestContext,
  ): Promise<OsrmReply> {
    if (this.now() >= context.deadlineAt) {
      return guardReply("DeadlineExceeded", OSRM_DEADLINE_ERROR);
    }
    if (this.circuit.isOpen()) {
      return guardReply("CircuitOpen", OSRM_CIRCUIT_OPEN_ERROR);
    }

    const release = await this.semaphore.acquire(context.deadlineAt);
    if (!release) {
      return guardReply("DeadlineExceeded", OSRM_DEADLINE_ERROR);
    }
    try {
      if (this.now() >= context.deadlineAt) {
        return guardReply("DeadlineExceeded", OSRM_DEADLINE_ERROR);
      }
      if (!this.circuit.allowCall()) {
        return guardReply("CircuitOpen", OSRM_CIRCUIT_OPEN_ERROR);
      }
      if (context.callsUsed >= this.limits.maxCallsPerRequest) {
        return guardReply("BudgetExceeded", OSRM_BUDGET_ERROR);
      }
      context.callsUsed += 1;

      const coordinates = routeCoordinates
        .map(([latitude, longitude]) => `${longitude},${latitude}`)
        .join(";");
      const remainingMs = Math.max(1, context.deadlineAt - this.now());
      const deadlineConstrained =
        remainingMs <= this.limits.requestTimeoutMs;
      const timeoutMs = Math.max(
        1,
        deadlineConstrained ? remainingMs : this.limits.requestTimeoutMs,
      );
      const signal = this.timeoutSignal(timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(
          `${this.baseUrl()}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=true&annotations=false`,
          {
            headers: { "User-Agent": "DispatchRouteReview/1.0" },
            signal,
          },
        );
      } catch (error) {
        this.circuit.recordFailure();
        if (signal.aborted && deadlineConstrained) {
          return guardReply("DeadlineExceeded", OSRM_DEADLINE_ERROR);
        }
        return {
          code: signal.aborted ? "Timeout" : "NetworkError",
          error:
            error instanceof Error
              ? `Road-routing request failed: ${error.message}`
              : "Road-routing request failed.",
        };
      }

      let payload: {
        code?: string;
        message?: string;
        routes?: OsrmRoute[];
      };
      try {
        payload = (await response.json()) as typeof payload;
      } catch (error) {
        this.circuit.recordFailure();
        if (signal.aborted && deadlineConstrained) {
          return guardReply("DeadlineExceeded", OSRM_DEADLINE_ERROR);
        }
        return {
          code: signal.aborted ? "Timeout" : `HTTP ${response.status}`,
          error:
            error instanceof Error
              ? `Road-routing response could not be read: ${error.message}`
              : "Road-routing response could not be read.",
        };
      }

      if (providerFailure(response)) this.circuit.recordFailure();
      else this.circuit.recordHealthy();

      const result = payload.routes?.[0];
      if (!response.ok || payload.code !== "Ok" || !result) {
        return {
          code: payload.code || `HTTP ${response.status}`,
          error:
            payload.message ||
            payload.code ||
            `Road-routing service returned ${response.status}.`,
        };
      }
      return { result };
    } finally {
      release();
    }
  }
}

export async function waitForOsrmDeadline<T>(
  pending: Promise<T>,
  deadlineAt: number,
): Promise<{ completed: true; value: T } | { completed: false }> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return { completed: false };

  const timedOut = Symbol("osrm-deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), remainingMs);
  });
  try {
    const value = await Promise.race([pending, timeout]);
    return value === timedOut
      ? { completed: false }
      : { completed: true, value: value as T };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export const osrmRouting = new OsrmRoutingService();

export type RoadRouteResult = RoadRoute;
