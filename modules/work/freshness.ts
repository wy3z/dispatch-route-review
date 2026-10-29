import type { CacheKind, CacheSnapshotMetadata } from "./server/snapshots";
import { londonCalendarDate } from "../../shared/calendar";

export const CACHE_MAX_AGE_SECONDS = {
  scheduleToday: 30 * 60,
  planningDemand: 30 * 60,
  scheduleFuture: 6 * 60 * 60,
  scheduleHistorical: 7 * 24 * 60 * 60,
} as const;

export const CACHE_MONITORING_THRESHOLDS = {
  workerProgress: 15 * 60,
  oldestReadyQueue: 15 * 60,
  consecutiveFailures: 3,
  warmupQueue: 15 * 60,
} as const;

export type CacheDateClass =
  | "today"
  | "planning_demand"
  | "future"
  | "historical";

export type CacheFreshnessStatus =
  | "missing"
  | "fresh"
  | "stale"
  | "over_age";

export type CacheRefreshState = "idle" | "queued" | "retry_wait" | "leased";

export type CacheRefreshMetadata = {
  state: CacheRefreshState;
  requestedAt: string | null;
  availableAt: string | null;
  leasedAt: string | null;
  attempts: number;
  leaseExpired: boolean;
  lastError: string | null;
};

export type CacheFreshness = {
  kind: CacheKind;
  scopeDate: string;
  dateClass: CacheDateClass;
  status: CacheFreshnessStatus;
  stale: boolean;
  usable: boolean;
  degraded: boolean;
  sourceRefreshedAt: string | null;
  refreshedAt: string | null;
  expiresAt: string | null;
  sourceAgeSeconds: number | null;
  ageSeconds: number | null;
  maxAgeSeconds: number;
  consecutiveFailures: number;
  lastError: string | null;
  refresh: CacheRefreshMetadata;
};

export type CacheQueueHealth = {
  readyCount: number;
  oldestReadyAgeSeconds: number | null;
  expiredLeaseCount: number;
};

export type CacheHealthIssueCode =
  | "cache_missing"
  | "cache_over_age"
  | "cache_stale"
  | "refresh_failed"
  | "worker_no_progress"
  | "expired_refresh_lease"
  | "refresh_queue_delayed";

export type CacheHealthIssue = {
  code: CacheHealthIssueCode;
  cacheKey: string | null;
};

export type CacheSystemHealth = {
  status: "ready" | "warming" | "degraded" | "not_ready";
  ready: boolean;
  worker: {
    status: "healthy" | "warming" | "stalled";
    healthy: boolean;
  };
  caches: CacheFreshness[];
  queue: CacheQueueHealth;
  issues: CacheHealthIssue[];
};

export const IDLE_CACHE_REFRESH: CacheRefreshMetadata = {
  state: "idle",
  requestedAt: null,
  availableAt: null,
  leasedAt: null,
  attempts: 0,
  leaseExpired: false,
  lastError: null,
};

function secondsSince(value: string | null, now: Date) {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return Math.max(0, Math.floor((now.getTime() - milliseconds) / 1_000));
}

function normaliseError(value: string | null) {
  const message = value?.replace(/\s+/g, " ").trim();
  if (!message) return null;
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

export function cacheDateClass(
  kind: CacheKind,
  scopeDate: string,
  now = new Date(),
): CacheDateClass {
  if (kind === "planning_demand") return "planning_demand";
  const today = londonCalendarDate(now);
  if (scopeDate < today) return "historical";
  if (scopeDate > today) return "future";
  return "today";
}

export function cacheMaximumAgeSeconds(
  kind: CacheKind,
  scopeDate: string,
  now = new Date(),
) {
  switch (cacheDateClass(kind, scopeDate, now)) {
    case "planning_demand":
      return CACHE_MAX_AGE_SECONDS.planningDemand;
    case "future":
      return CACHE_MAX_AGE_SECONDS.scheduleFuture;
    case "historical":
      return CACHE_MAX_AGE_SECONDS.scheduleHistorical;
    case "today":
      return CACHE_MAX_AGE_SECONDS.scheduleToday;
  }
}

function cacheAgeStatus(
  value: Pick<CacheFreshness, "refreshedAt" | "sourceRefreshedAt" | "expiresAt" | "consecutiveFailures" | "lastError">,
  maxAgeSeconds: number,
  now: Date,
) {
  const ageSeconds = secondsSince(value.refreshedAt, now);
  const sourceAgeSeconds = secondsSince(value.sourceRefreshedAt, now);
  const expiredAt = value.expiresAt ? Date.parse(value.expiresAt) : NaN;
  const stale = !Number.isFinite(expiredAt) || expiredAt <= now.getTime();
  const overAge = ageSeconds === null || ageSeconds >= maxAgeSeconds;
  const status: CacheFreshnessStatus = overAge
    ? "over_age"
    : stale
      ? "stale"
      : "fresh";

  return {
    status,
    stale: status !== "fresh",
    usable: status === "fresh" || status === "stale",
    degraded: status !== "fresh" || value.consecutiveFailures > 0 || value.lastError !== null,
    sourceAgeSeconds,
    ageSeconds,
  };
}

export function describeCacheFreshness(
  kind: CacheKind,
  scopeDate: string,
  snapshot: CacheSnapshotMetadata | null,
  refresh: CacheRefreshMetadata = IDLE_CACHE_REFRESH,
  now = new Date(),
): CacheFreshness {
  const dateClass = cacheDateClass(kind, scopeDate, now);
  const maxAgeSeconds = cacheMaximumAgeSeconds(kind, scopeDate, now);
  const lastError = normaliseError(snapshot?.lastError ?? refresh.lastError);
  const consecutiveFailures = Math.max(
    0,
    snapshot?.consecutiveFailures ?? 0,
    refresh.lastError ? refresh.attempts : 0,
  );

  if (!snapshot) {
    return {
      kind,
      scopeDate,
      dateClass,
      status: "missing",
      stale: true,
      usable: false,
      degraded: true,
      sourceRefreshedAt: null,
      refreshedAt: null,
      expiresAt: null,
      sourceAgeSeconds: null,
      ageSeconds: null,
      maxAgeSeconds,
      consecutiveFailures,
      lastError,
      refresh,
    };
  }

  return {
    kind,
    scopeDate,
    dateClass,
    ...cacheAgeStatus({ ...snapshot, consecutiveFailures, lastError }, maxAgeSeconds, now),
    sourceRefreshedAt: snapshot.sourceRefreshedAt,
    refreshedAt: snapshot.refreshedAt,
    expiresAt: snapshot.expiresAt,
    maxAgeSeconds,
    consecutiveFailures,
    lastError,
    refresh,
  };
}

/** Re-evaluate server freshness metadata against browser time without an API response. */
export function cacheFreshnessAt(
  freshness: CacheFreshness,
  now = new Date(),
): CacheFreshness {
  if (freshness.status === "missing" || !freshness.refreshedAt) {
    return freshness;
  }

  const dateClass = cacheDateClass(freshness.kind, freshness.scopeDate, now);
  const maxAgeSeconds = cacheMaximumAgeSeconds(
    freshness.kind,
    freshness.scopeDate,
    now,
  );
  return {
    ...freshness,
    dateClass,
    maxAgeSeconds,
    ...cacheAgeStatus(freshness, maxAgeSeconds, now),
  };
}

/** Millisecond deadline at which a usable snapshot must be removed locally. */
export function cacheHardExpiryMilliseconds(
  freshness: CacheFreshness,
  now = new Date(),
) {
  if (!freshness.refreshedAt) return null;
  const refreshedAt = Date.parse(freshness.refreshedAt);
  if (!Number.isFinite(refreshedAt)) return null;
  return (
    refreshedAt +
    cacheMaximumAgeSeconds(freshness.kind, freshness.scopeDate, now) * 1_000
  );
}

function fingerprint(value: string | null) {
  if (!value) return "0";
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function timestampPart(value: string | null) {
  if (!value) return "0";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp.toString(36) : "invalid";
}

export function cacheFreshnessValidator(freshness: CacheFreshness) {
  return [
    freshness.status,
    freshness.consecutiveFailures,
    fingerprint(freshness.lastError),
    freshness.refresh.state,
    timestampPart(freshness.refresh.requestedAt),
    timestampPart(freshness.refresh.availableAt),
    timestampPart(freshness.refresh.leasedAt),
    freshness.refresh.leaseExpired ? "expired" : "active",
  ].join("-");
}

function formatAge(seconds: number | null) {
  if (seconds === null) return "an unknown amount of time";
  if (seconds < 60) return "less than a minute";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function cacheFreshnessWarning(
  label: string,
  freshness: CacheFreshness,
  now = new Date(),
) {
  if (!freshness.degraded) return "";

  const currentSourceAge = secondsSince(freshness.sourceRefreshedAt, now);
  const parts: string[] = [];
  if (freshness.status === "missing") {
    parts.push(`${label} data has not loaded yet.`);
  } else if (freshness.status === "over_age") {
    parts.push(
      `${label} data is too old to use; its source refresh is ${formatAge(currentSourceAge)} old.`,
    );
  } else if (freshness.status === "stale") {
    parts.push(
      `${label} data is stale; its source refresh is ${formatAge(currentSourceAge)} old.`,
    );
  } else {
    parts.push(
      `${label} is showing the last successful snapshot from ${formatAge(currentSourceAge)} ago.`,
    );
  }

  if (freshness.lastError) {
    parts.push(`Last refresh failed: ${freshness.lastError}`);
  }

  if (freshness.refresh.leaseExpired) {
    parts.push("The refresh lease has expired.");
  } else if (freshness.refresh.state === "leased") {
    parts.push("A background refresh is running.");
  } else if (freshness.refresh.state === "retry_wait") {
    parts.push("A background refresh is waiting to retry.");
  } else if (freshness.refresh.state === "queued") {
    parts.push("A background refresh is queued.");
  }

  return parts.join(" ");
}

function refreshIsRecent(refresh: CacheRefreshMetadata, now: Date) {
  if (refresh.state === "idle" || refresh.leaseExpired) return false;
  const requestedAge = secondsSince(refresh.requestedAt, now);
  return (
    requestedAge !== null &&
    requestedAge < CACHE_MONITORING_THRESHOLDS.warmupQueue
  );
}

export function evaluateCacheSystemHealth(args: {
  caches: CacheFreshness[];
  queue: CacheQueueHealth;
  now?: Date;
}): CacheSystemHealth {
  const now = args.now ?? new Date();
  const issues: CacheHealthIssue[] = [];
  let serviceBlocked = false;
  let warming = false;
  let workerStalled = false;
  let degraded = false;

  for (const cache of args.caches) {
    const cacheKey = `${cache.kind}:${cache.scopeDate}`;
    if (cache.status === "missing") {
      if (
        cache.consecutiveFailures >=
        CACHE_MONITORING_THRESHOLDS.consecutiveFailures
      ) {
        serviceBlocked = true;
        workerStalled = true;
        issues.push({ code: "refresh_failed", cacheKey });
      } else if (refreshIsRecent(cache.refresh, now)) {
        warming = true;
      } else {
        serviceBlocked = true;
        workerStalled = true;
        issues.push({ code: "cache_missing", cacheKey });
      }
      continue;
    }

    if (cache.status === "over_age") {
      serviceBlocked = true;
      workerStalled = true;
      issues.push({ code: "cache_over_age", cacheKey });
    } else if (cache.status === "stale") {
      degraded = true;
      issues.push({ code: "cache_stale", cacheKey });
    }

    if (
      cache.ageSeconds !== null &&
      cache.ageSeconds >= CACHE_MONITORING_THRESHOLDS.workerProgress
    ) {
      workerStalled = true;
      issues.push({ code: "worker_no_progress", cacheKey });
    }

    if (
      cache.consecutiveFailures >=
      CACHE_MONITORING_THRESHOLDS.consecutiveFailures
    ) {
      workerStalled = true;
      issues.push({ code: "refresh_failed", cacheKey });
    } else if (cache.lastError) {
      degraded = true;
      issues.push({ code: "refresh_failed", cacheKey });
    }
  }

  if (args.queue.expiredLeaseCount > 0) {
    workerStalled = true;
    issues.push({ code: "expired_refresh_lease", cacheKey: null });
  }
  if (
    args.queue.oldestReadyAgeSeconds !== null &&
    args.queue.oldestReadyAgeSeconds >=
      CACHE_MONITORING_THRESHOLDS.oldestReadyQueue
  ) {
    workerStalled = true;
    issues.push({ code: "refresh_queue_delayed", cacheKey: null });
  }

  // Missing operational data is only a healthy warmup while its worker path
  // is also healthy. A delayed queue or stalled lease must fail readiness.
  if (warming && workerStalled) serviceBlocked = true;

  const status: CacheSystemHealth["status"] = serviceBlocked
    ? "not_ready"
    : warming
      ? "warming"
      : workerStalled || degraded
        ? "degraded"
        : "ready";
  const workerStatus: CacheSystemHealth["worker"]["status"] = workerStalled
    ? "stalled"
    : warming
      ? "warming"
      : "healthy";

  return {
    status,
    ready: status !== "not_ready",
    worker: {
      status: workerStatus,
      healthy: workerStatus !== "stalled",
    },
    caches: args.caches,
    queue: args.queue,
    issues,
  };
}
