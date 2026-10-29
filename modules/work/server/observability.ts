import { cacheKey, cacheRefreshLeaseSeconds, getCacheSnapshotMetadata } from "./snapshots";
import type { CacheKind } from "./snapshots";
import { query } from "../../../platform/database";
import {
  describeCacheFreshness,
  evaluateCacheSystemHealth,
  IDLE_CACHE_REFRESH,
} from "../freshness";
import type { CacheFreshness, CacheQueueHealth, CacheRefreshMetadata } from "../freshness";
import { londonCalendarDate } from "../../../shared/calendar";

export async function readCacheRefreshMetadata(
  kind: CacheKind,
  scopeDate: string,
): Promise<CacheRefreshMetadata> {
  const leaseSeconds = cacheRefreshLeaseSeconds();
  const result = await query<{
    requested_at: Date;
    available_at: Date;
    leased_at: Date | null;
    attempts: number;
    lease_expired: boolean;
    last_error: string | null;
  }>(
    `SELECT requested_at,
            available_at,
            leased_at,
            attempts,
            leased_at IS NOT NULL AND
              leased_at < now() - make_interval(secs => $2::integer)
              AS lease_expired,
            last_error
       FROM cache_refresh_queue
      WHERE cache_key = $1`,
    [cacheKey(kind, scopeDate), leaseSeconds],
  );
  const row = result.rows[0];
  if (!row) return IDLE_CACHE_REFRESH;

  const state: CacheRefreshMetadata["state"] = row.leased_at
    ? "leased"
    : row.available_at.getTime() > Date.now()
      ? "retry_wait"
      : "queued";
  return {
    state,
    requestedAt: row.requested_at.toISOString(),
    availableAt: row.available_at.toISOString(),
    leasedAt: row.leased_at?.toISOString() ?? null,
    attempts: row.attempts,
    leaseExpired: row.lease_expired,
    lastError: row.last_error,
  };
}

export async function readCacheFreshness(
  kind: CacheKind,
  scopeDate: string,
  now = new Date(),
): Promise<CacheFreshness> {
  const [snapshot, refresh] = await Promise.all([
    getCacheSnapshotMetadata(kind, scopeDate),
    readCacheRefreshMetadata(kind, scopeDate),
  ]);
  return describeCacheFreshness(kind, scopeDate, snapshot, refresh, now);
}

export async function readCacheQueueHealth(): Promise<CacheQueueHealth> {
  const leaseSeconds = cacheRefreshLeaseSeconds();
  const result = await query<{
    ready_count: number;
    oldest_ready_age_seconds: number | null;
    expired_lease_count: number;
  }>(
    `WITH queue_state AS (
       SELECT available_at,
              leased_at,
              leased_at IS NOT NULL AND
                leased_at < now() - make_interval(secs => $1::integer)
                AS lease_expired
         FROM cache_refresh_queue
     ), readiness AS (
       SELECT available_at,
              lease_expired,
              available_at <= now() AND
                (leased_at IS NULL OR lease_expired) AS ready
         FROM queue_state
     )
     SELECT COUNT(*) FILTER (WHERE ready)::integer AS ready_count,
            EXTRACT(
              EPOCH FROM (now() - MIN(available_at) FILTER (WHERE ready))
            )::double precision AS oldest_ready_age_seconds,
            COUNT(*) FILTER (WHERE lease_expired)::integer AS expired_lease_count
       FROM readiness`,
    [leaseSeconds],
  );
  const row = result.rows[0];
  return {
    readyCount: row?.ready_count ?? 0,
    oldestReadyAgeSeconds: row?.oldest_ready_age_seconds ?? null,
    expiredLeaseCount: row?.expired_lease_count ?? 0,
  };
}

export async function readCacheSystemHealth(now = new Date()) {
  const today = londonCalendarDate(now);
  const [schedule, planningDemand, queue] = await Promise.all([
    readCacheFreshness("schedule", today, now),
    readCacheFreshness("planning_demand", today, now),
    readCacheQueueHealth(),
  ]);
  return evaluateCacheSystemHealth({
    caches: [schedule, planningDemand],
    queue,
    now,
  });
}

export function publicCacheFreshness(freshness: CacheFreshness) {
  return {
    kind: freshness.kind,
    scopeDate: freshness.scopeDate,
    dateClass: freshness.dateClass,
    status: freshness.status,
    usable: freshness.usable,
    sourceRefreshedAt: freshness.sourceRefreshedAt,
    sourceAgeSeconds: freshness.sourceAgeSeconds,
    ageSeconds: freshness.ageSeconds,
    maxAgeSeconds: freshness.maxAgeSeconds,
    consecutiveFailures: freshness.consecutiveFailures,
    lastRefreshFailed: freshness.lastError !== null,
    refresh: {
      state: freshness.refresh.state,
      requestedAt: freshness.refresh.requestedAt,
      availableAt: freshness.refresh.availableAt,
      leasedAt: freshness.refresh.leasedAt,
      attempts: freshness.refresh.attempts,
      leaseExpired: freshness.refresh.leaseExpired,
      lastRefreshFailed: freshness.refresh.lastError !== null,
    },
  };
}
