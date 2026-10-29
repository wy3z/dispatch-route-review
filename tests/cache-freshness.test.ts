import assert from "node:assert/strict";
import test from "node:test";
import {
  CACHE_MAX_AGE_SECONDS,
  CACHE_MONITORING_THRESHOLDS,
  cacheFreshnessAt,
  cacheFreshnessWarning,
  cacheHardExpiryMilliseconds,
  cacheMaximumAgeSeconds,
  describeCacheFreshness,
  evaluateCacheSystemHealth,
  IDLE_CACHE_REFRESH,
} from "../modules/work/freshness";
import type { CacheRefreshMetadata } from "../modules/work/freshness";
import { cacheSnapshotResponse } from "../modules/work/server/cache-http";
import type { CacheSnapshotMetadata } from "../modules/work/server/snapshots";

const now = new Date("2026-08-20T12:00:00.000Z");
const scopeDate = "2026-08-20";

function snapshot(args: {
  refreshedAt: string;
  expiresAt: string;
  lastError?: string | null;
  consecutiveFailures?: number;
}): CacheSnapshotMetadata {
  return {
    sourceRefreshedAt: args.refreshedAt,
    refreshedAt: args.refreshedAt,
    expiresAt: args.expiresAt,
    stale: Date.parse(args.expiresAt) <= now.getTime(),
    lastError: args.lastError ?? null,
    consecutiveFailures: args.consecutiveFailures ?? 0,
  };
}

async function responseBody(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

test("maximum cache ages are explicit for every date class", () => {
  assert.deepEqual(CACHE_MAX_AGE_SECONDS, {
    scheduleToday: 1_800,
    planningDemand: 1_800,
    scheduleFuture: 21_600,
    scheduleHistorical: 604_800,
  });
  assert.equal(cacheMaximumAgeSeconds("schedule", scopeDate, now), 1_800);
  assert.equal(cacheMaximumAgeSeconds("planning_demand", scopeDate, now), 1_800);
  assert.equal(cacheMaximumAgeSeconds("schedule", "2026-08-21", now), 21_600);
  assert.equal(cacheMaximumAgeSeconds("schedule", "2026-08-19", now), 604_800);
});

test("fresh snapshots return 200 with typed freshness metadata", async () => {
  const freshness = describeCacheFreshness(
    "schedule",
    scopeDate,
    snapshot({
      refreshedAt: "2026-08-20T11:58:00.000Z",
      expiresAt: "2026-08-20T12:03:00.000Z",
    }),
    IDLE_CACHE_REFRESH,
    now,
  );
  const response = cacheSnapshotResponse({
    request: new Request("https://dispatch.test/api/autotask-schedule"),
    freshness,
    payload: { value: "fresh" },
    label: "schedule",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Dispatch-Cache-Status"), "fresh");
  assert.deepEqual(await responseBody(response), {
    value: "fresh",
    cache: freshness,
  });
});

test("stale but usable snapshots remain available and are marked degraded", async () => {
  const freshness = describeCacheFreshness(
    "schedule",
    scopeDate,
    snapshot({
      refreshedAt: "2026-08-20T11:50:00.000Z",
      expiresAt: "2026-08-20T11:55:00.000Z",
    }),
    {
      ...IDLE_CACHE_REFRESH,
      state: "queued",
      requestedAt: "2026-08-20T11:59:00.000Z",
      availableAt: "2026-08-20T11:59:00.000Z",
    },
    now,
  );
  const response = cacheSnapshotResponse({
    request: new Request("https://dispatch.test/api/autotask-schedule"),
    freshness,
    payload: { value: "stale" },
    label: "schedule",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Warning"), '110 - "Response is stale"');
  const body = await responseBody(response);
  assert.equal(body.value, "stale");
  assert.deepEqual(body.cache, freshness);
  assert.match(
    cacheFreshnessWarning("Schedule", freshness, now),
    /Schedule data is stale; its source refresh is 10 minutes old\./,
  );
});

test("over-age snapshots return 503 without exposing cached payloads", async () => {
  const freshness = describeCacheFreshness(
    "schedule",
    scopeDate,
    snapshot({
      refreshedAt: "2026-08-20T11:29:00.000Z",
      expiresAt: "2026-08-20T11:34:00.000Z",
    }),
    {
      ...IDLE_CACHE_REFRESH,
      state: "queued",
      requestedAt: "2026-08-20T11:59:00.000Z",
      availableAt: "2026-08-20T11:59:00.000Z",
    },
    now,
  );
  const response = cacheSnapshotResponse({
    request: new Request("https://dispatch.test/api/autotask-schedule"),
    freshness,
    payload: { value: "must-not-leak" },
    label: "schedule",
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "5");
  const body = await responseBody(response);
  assert.equal("value" in body, false);
  assert.deepEqual(body.cache, freshness);
  assert.match(String(body.message), /too old to use/);
});

test("wall-clock progression crosses stale and hard-expiry boundaries", () => {
  const freshness = describeCacheFreshness(
    "schedule",
    scopeDate,
    snapshot({
      refreshedAt: "2026-08-20T11:30:00.000Z",
      expiresAt: "2026-08-20T11:35:00.000Z",
    }),
    IDLE_CACHE_REFRESH,
    new Date("2026-08-20T11:34:00.000Z"),
  );
  assert.equal(freshness.status, "fresh");
  assert.equal(
    cacheHardExpiryMilliseconds(
      freshness,
      new Date("2026-08-20T11:34:00.000Z"),
    ),
    Date.parse("2026-08-20T12:00:00.000Z"),
  );

  const stale = cacheFreshnessAt(
    freshness,
    new Date("2026-08-20T11:40:00.000Z"),
  );
  assert.equal(stale.status, "stale");
  assert.equal(stale.usable, true);

  const overAge = cacheFreshnessAt(
    stale,
    new Date("2026-08-20T12:00:00.000Z"),
  );
  assert.equal(overAge.status, "over_age");
  assert.equal(overAge.usable, false);
  assert.match(
    cacheFreshnessWarning(
      "Schedule",
      overAge,
      new Date("2026-08-20T12:00:00.000Z"),
    ),
    /too old to use/,
  );
});

test("refresh failures remain usable but carry failure and retry state", async () => {
  const refresh: CacheRefreshMetadata = {
    state: "retry_wait",
    requestedAt: "2026-08-20T11:58:00.000Z",
    availableAt: "2026-08-20T12:03:00.000Z",
    leasedAt: null,
    attempts: 2,
    leaseExpired: false,
    lastError: "Autotask timed out",
  };
  const freshness = describeCacheFreshness(
    "planning_demand",
    scopeDate,
    snapshot({
      refreshedAt: "2026-08-20T11:50:00.000Z",
      expiresAt: "2026-08-20T11:55:00.000Z",
      lastError: "Autotask timed out",
      consecutiveFailures: 2,
    }),
    refresh,
    now,
  );
  const response = cacheSnapshotResponse({
    request: new Request("https://dispatch.test/api/planning-demand"),
    freshness,
    payload: { value: "last-good" },
    label: "planning-demand",
  });

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("X-Dispatch-Refresh-Error"),
    "previous-refresh-failed",
  );
  const body = await responseBody(response);
  assert.equal(body.value, "last-good");
  assert.deepEqual(body.cache, freshness);
  assert.match(
    cacheFreshnessWarning("Unassigned request", freshness, now),
    /Last refresh failed: Autotask timed out/,
  );
  assert.match(
    cacheFreshnessWarning("Unassigned request", freshness, now),
    /waiting to retry/,
  );
});

test("worker monitoring detects non-progress, expired leases, delayed work, and failures", () => {
  const delayedFreshness = describeCacheFreshness(
    "schedule",
    scopeDate,
    snapshot({
      refreshedAt: "2026-08-20T11:44:00.000Z",
      expiresAt: "2026-08-20T11:49:00.000Z",
      lastError: "Autotask timed out",
      consecutiveFailures: CACHE_MONITORING_THRESHOLDS.consecutiveFailures,
    }),
    {
      ...IDLE_CACHE_REFRESH,
      state: "leased",
      requestedAt: "2026-08-20T11:30:00.000Z",
      availableAt: "2026-08-20T11:30:00.000Z",
      leasedAt: "2026-08-20T11:30:00.000Z",
      attempts: 3,
      leaseExpired: true,
      lastError: "Autotask timed out",
    },
    now,
  );
  const healthyDemand = describeCacheFreshness(
    "planning_demand",
    scopeDate,
    snapshot({
      refreshedAt: "2026-08-20T11:58:00.000Z",
      expiresAt: "2026-08-20T12:03:00.000Z",
    }),
    IDLE_CACHE_REFRESH,
    now,
  );
  const health = evaluateCacheSystemHealth({
    caches: [delayedFreshness, healthyDemand],
    queue: {
      readyCount: 1,
      oldestReadyAgeSeconds: CACHE_MONITORING_THRESHOLDS.oldestReadyQueue,
      expiredLeaseCount: 1,
    },
    now,
  });

  assert.equal(health.status, "degraded");
  assert.equal(health.ready, true);
  assert.equal(health.worker.status, "stalled");
  assert.equal(health.worker.healthy, false);
  assert.deepEqual(
    new Set(health.issues.map((issue) => issue.code)),
    new Set([
      "cache_stale",
      "worker_no_progress",
      "refresh_failed",
      "expired_refresh_lease",
      "refresh_queue_delayed",
    ]),
  );
});

test("recent queued cache warmup is healthy while unavailable data is not", () => {
  const recentRefresh: CacheRefreshMetadata = {
    ...IDLE_CACHE_REFRESH,
    state: "queued",
    requestedAt: "2026-08-20T11:59:00.000Z",
    availableAt: "2026-08-20T11:59:00.000Z",
  };
  const warming = describeCacheFreshness(
    "schedule",
    scopeDate,
    null,
    recentRefresh,
    now,
  );
  const warmingHealth = evaluateCacheSystemHealth({
    caches: [warming],
    queue: {
      readyCount: 1,
      oldestReadyAgeSeconds: 60,
      expiredLeaseCount: 0,
    },
    now,
  });
  assert.equal(warmingHealth.status, "warming");
  assert.equal(warmingHealth.ready, true);
  assert.equal(warmingHealth.worker.status, "warming");

  const unavailable = describeCacheFreshness(
    "schedule",
    scopeDate,
    null,
    IDLE_CACHE_REFRESH,
    now,
  );
  const unavailableHealth = evaluateCacheSystemHealth({
    caches: [unavailable],
    queue: {
      readyCount: 0,
      oldestReadyAgeSeconds: null,
      expiredLeaseCount: 0,
    },
    now,
  });
  assert.equal(unavailableHealth.status, "not_ready");
  assert.equal(unavailableHealth.ready, false);

  const repeatedlyFailing = describeCacheFreshness(
    "schedule",
    scopeDate,
    null,
    {
      ...recentRefresh,
      state: "retry_wait",
      attempts: CACHE_MONITORING_THRESHOLDS.consecutiveFailures,
      lastError: "Autotask timed out",
    },
    now,
  );
  const failingHealth = evaluateCacheSystemHealth({
    caches: [repeatedlyFailing],
    queue: {
      readyCount: 0,
      oldestReadyAgeSeconds: null,
      expiredLeaseCount: 0,
    },
    now,
  });
  assert.equal(failingHealth.status, "not_ready");
  assert.equal(failingHealth.worker.status, "stalled");
  assert.deepEqual(failingHealth.issues, [
    { code: "refresh_failed", cacheKey: `schedule:${scopeDate}` },
  ]);
});

test("missing cache plus delayed queue is not ready", () => {
  const unavailable = describeCacheFreshness(
    "schedule",
    scopeDate,
    null,
    {
      ...IDLE_CACHE_REFRESH,
      state: "queued",
      requestedAt: "2026-08-20T11:59:30.000Z",
      availableAt: "2026-08-20T11:40:00.000Z",
    },
    now,
  );
  const health = evaluateCacheSystemHealth({
    caches: [unavailable],
    queue: {
      readyCount: 1,
      oldestReadyAgeSeconds: CACHE_MONITORING_THRESHOLDS.oldestReadyQueue,
      expiredLeaseCount: 0,
    },
    now,
  });

  assert.equal(health.status, "not_ready");
  assert.equal(health.ready, false);
  assert.equal(health.worker.status, "stalled");
  assert.deepEqual(health.issues, [
    { code: "refresh_queue_delayed", cacheKey: null },
  ]);
});


test("server and browser expiry classifications agree across timestamps and London date boundaries", () => {
  for (const instant of ["2026-03-29T00:59:59Z", "2026-03-29T01:00:01Z", "2026-10-25T00:59:59Z", "2026-10-25T01:00:01Z", "2026-08-20T23:30:00Z"]) {
    const start = new Date(instant);
    for (const kind of ["schedule", "planning_demand"] as const) {
      for (const date of ["2026-03-28", "2026-03-29", "2026-08-20", "2026-08-21", "2026-10-25", "2026-10-26"]) {
        for (const failure of [false, true]) {
          const entry = snapshot({ refreshedAt: new Date(start.getTime() - 120_000).toISOString(), expiresAt: new Date(start.getTime() + 60_000).toISOString(), lastError: failure ? "offline" : null, consecutiveFailures: failure ? 2 : 0 });
          const received = describeCacheFreshness(kind, date, entry, IDLE_CACHE_REFRESH, start);
          for (const offset of [0, 59_999, 60_000, 1_800_000, 21_600_000, 604_800_000]) {
            const later = new Date(start.getTime() + offset);
            assert.deepEqual(cacheFreshnessAt(received, later), describeCacheFreshness(kind, date, entry, IDLE_CACHE_REFRESH, later));
          }
        }
      }
    }
  }
});
