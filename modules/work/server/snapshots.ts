import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withTransaction } from "../../../platform/database";
import { scheduledVisitStatusCounts } from "../schedule/counts";
import { isIsoCalendarDate, londonCalendarDate } from "../../../shared/calendar";

export type CacheKind = "schedule" | "planning_demand";

export type CacheSnapshotMetadata = {
  sourceRefreshedAt: string;
  refreshedAt: string;
  expiresAt: string;
  stale: boolean;
  lastError: string | null;
  consecutiveFailures: number;
};

export type CacheSnapshot<T> = CacheSnapshotMetadata & {
  payload: T;
};

export type CacheRefreshJob = {
  cacheKey: string;
  kind: CacheKind;
  scopeDate: string;
  attempts: number;
  leaseOwner: string;
  claimGeneration: string;
  requestGeneration: string;
};

export type CacheRefreshCompletion =
  | { stored: false; reason: "lease_lost" }
  | { stored: true; refreshPending: boolean };

export type CacheRefreshFailure =
  | { recorded: false; reason: "lease_lost" | "superseded" }
  | { recorded: true; backoffSeconds: number };

export type CacheRefreshRelease =
  | { released: false; reason: "lease_lost" }
  | { released: true; refreshPending: boolean };

function parseCacheKind(value: string): CacheKind {
  if (value === "schedule" || value === "planning_demand") {
    return value;
  }
  throw new Error(`Unsupported cache refresh kind: ${value}.`);
}

export const CACHE_REFRESH_INTERVAL_SECONDS = {
  today: 300,
  planningDemand: 300,
  future: 3_600,
  historical: 86_400,
} as const;

export const CACHE_WARM_WINDOW_DAYS = {
  past: 30,
  future: 30,
} as const;

function assertScopeDate(scopeDate: string) {
  if (!isIsoCalendarDate(scopeDate)) {
    throw new Error("scopeDate must be a real ISO calendar date (YYYY-MM-DD).");
  }
}

export function cacheRefreshLeaseSeconds() {
  const configured = Number(process.env.CACHE_REFRESH_LEASE_SECONDS ?? 1_800);
  return Number.isFinite(configured) ? Math.max(60, configured) : 1_800;
}

export function cacheRefreshIntervalSeconds(
  kind: CacheKind,
  scopeDate: string,
  now = new Date(),
) {
  assertScopeDate(scopeDate);
  if (kind === "planning_demand") {
    return CACHE_REFRESH_INTERVAL_SECONDS.planningDemand;
  }
  const today = londonCalendarDate(now);
  if (scopeDate < today) return CACHE_REFRESH_INTERVAL_SECONDS.historical;
  if (scopeDate > today) return CACHE_REFRESH_INTERVAL_SECONDS.future;
  return CACHE_REFRESH_INTERVAL_SECONDS.today;
}

export function cacheKey(kind: CacheKind, scopeDate: string) {
  assertScopeDate(scopeDate);
  return `${kind}:${scopeDate}`;
}

export async function getCacheSnapshotMetadata(
  kind: CacheKind,
  scopeDate: string,
): Promise<CacheSnapshotMetadata | null> {
  const result = await query<{
    source_refreshed_at: Date;
    refreshed_at: Date;
    expires_at: Date;
    stale: boolean;
    last_error: string | null;
    consecutive_failures: number;
  }>(
    `SELECT source_refreshed_at, refreshed_at, expires_at,
            expires_at <= now() AS stale, last_error, consecutive_failures
       FROM cache_snapshots
      WHERE cache_key = $1`,
    [cacheKey(kind, scopeDate)],
  );
  const row = result.rows[0];
  return row
    ? {
        sourceRefreshedAt: row.source_refreshed_at.toISOString(),
        refreshedAt: row.refreshed_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        stale: row.stale,
        lastError: row.last_error,
        consecutiveFailures: row.consecutive_failures,
      }
    : null;
}

export async function getCacheSnapshot<T>(
  kind: CacheKind,
  scopeDate: string,
): Promise<CacheSnapshot<T> | null> {
  const result = await query<{
    payload: T;
    source_refreshed_at: Date;
    refreshed_at: Date;
    expires_at: Date;
    stale: boolean;
    last_error: string | null;
    consecutive_failures: number;
  }>(
    `SELECT payload, source_refreshed_at, refreshed_at, expires_at,
            expires_at <= now() AS stale, last_error, consecutive_failures
       FROM cache_snapshots
      WHERE cache_key = $1`,
    [cacheKey(kind, scopeDate)],
  );
  const row = result.rows[0];
  return row
    ? {
        payload: row.payload,
        sourceRefreshedAt: row.source_refreshed_at.toISOString(),
        refreshedAt: row.refreshed_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        stale: row.stale,
        lastError: row.last_error,
        consecutiveFailures: row.consecutive_failures,
      }
    : null;
}

export async function requestCacheRefresh(
  kind: CacheKind,
  scopeDate: string,
  requestedBy: string | null = null,
  priority = 0,
) {
  const leaseSeconds = cacheRefreshLeaseSeconds();
  await query(
    `INSERT INTO cache_refresh_queue
       (cache_key, kind, scope_date, requested_by, priority)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (cache_key) DO UPDATE SET
       -- Normal refresh requests must not rejuvenate queue age or supersede an
       -- in-flight claim. Explicit priority refreshes still fence completion.
       request_generation = CASE
         WHEN EXCLUDED.priority > 0 THEN cache_refresh_queue.request_generation + 1
         ELSE cache_refresh_queue.request_generation
       END,
       available_at = CASE
         WHEN EXCLUDED.priority > cache_refresh_queue.priority THEN now()
         ELSE cache_refresh_queue.available_at
       END,
       requested_by = COALESCE(EXCLUDED.requested_by, cache_refresh_queue.requested_by),
       priority = GREATEST(cache_refresh_queue.priority, EXCLUDED.priority),
       leased_at = CASE
         WHEN cache_refresh_queue.leased_at < now() - make_interval(secs => $6::integer) THEN NULL
         ELSE cache_refresh_queue.leased_at
       END,
       lease_owner = CASE
         WHEN cache_refresh_queue.leased_at < now() - make_interval(secs => $6::integer) THEN NULL
         ELSE cache_refresh_queue.lease_owner
       END`,
    [cacheKey(kind, scopeDate), kind, scopeDate, requestedBy, priority, leaseSeconds],
  );
}

export async function requestCacheWarmup(
  kind: CacheKind,
  scopeDate: string,
) {
  await query(
    `INSERT INTO cache_refresh_queue (cache_key, kind, scope_date, priority)
     SELECT $1, $2, $3, 0
      WHERE NOT EXISTS (
        SELECT 1 FROM cache_snapshots WHERE cache_key = $1
      )
     ON CONFLICT (cache_key) DO NOTHING`,
    [cacheKey(kind, scopeDate), kind, scopeDate],
  );
}

export async function getCachedScheduleMonth(month: string) {
  const result = await query<{
    scope_date: string;
    payload: {
      visits?: Array<{ serviceCallId: number; isComplete: boolean }>;
    };
    source_refreshed_at: Date;
    refreshed_at: Date;
    expires_at: Date;
    last_error: string | null;
    consecutive_failures: number;
  }>(
    `SELECT scope_date::text, payload, source_refreshed_at, refreshed_at,
            expires_at, last_error, consecutive_failures
       FROM cache_snapshots
      WHERE kind = 'schedule'
        AND scope_date >= $1::date
        AND scope_date < $1::date + interval '1 month'
      ORDER BY scope_date`,
    [`${month}-01`],
  );
  return result.rows.map((row) => {
    const statusCounts = scheduledVisitStatusCounts(row.payload.visits ?? []);
    return {
      date: row.scope_date,
      calls: statusCounts.all,
      complete: statusCounts.complete,
      scheduled: statusCounts.open,
      sourceRefreshedAt: row.source_refreshed_at.toISOString(),
      refreshedAt: row.refreshed_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      lastError: row.last_error,
      consecutiveFailures: row.consecutive_failures,
    };
  });
}

export async function invalidateCacheSnapshots(
  client: PoolClient,
  kinds: readonly CacheKind[],
  requestedBy: string | null,
) {
  if (kinds.length === 0) return;
  await client.query(
    `UPDATE cache_snapshots
        SET expires_at = LEAST(expires_at, now())
      WHERE kind = ANY($1::text[])`,
    [kinds],
  );
  await client.query(
    `INSERT INTO cache_refresh_queue
       (cache_key, kind, scope_date, requested_by, priority)
     SELECT cache_key, kind, scope_date, $2, 10
       FROM (
         SELECT cache_key, kind, scope_date
           FROM cache_snapshots
          WHERE kind = ANY($1::text[])
         UNION
         SELECT cache_key, kind, scope_date
           FROM cache_refresh_queue
          WHERE kind = ANY($1::text[])
       ) AS invalidated
     ON CONFLICT (cache_key) DO UPDATE SET
       requested_by = COALESCE(EXCLUDED.requested_by, cache_refresh_queue.requested_by),
       priority = GREATEST(cache_refresh_queue.priority, EXCLUDED.priority),
       requested_at = now(),
       request_generation = cache_refresh_queue.request_generation + 1,
       available_at = now(),
       last_error = NULL`,
    [kinds, requestedBy],
  );
}

export async function enqueueDueSnapshots(
  scheduleFrom: string,
  scheduleTo: string,
) {
  assertScopeDate(scheduleFrom);
  assertScopeDate(scheduleTo);
  if (scheduleFrom > scheduleTo) {
    throw new Error("scheduleFrom must be on or before scheduleTo.");
  }
  const today = londonCalendarDate();
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE cache_snapshots AS snapshot
          SET expires_at = policy.expires_at
         FROM (
           SELECT cache_key,
                  refreshed_at + make_interval(
                    secs => CASE
                      WHEN kind = 'planning_demand' THEN $2::integer
                      WHEN scope_date < $1::date THEN $3::integer
                      WHEN scope_date > $1::date THEN $4::integer
                      ELSE $5::integer
                    END
                  ) AS expires_at
             FROM cache_snapshots
         ) AS policy
        WHERE snapshot.cache_key = policy.cache_key
          AND snapshot.expires_at IS DISTINCT FROM policy.expires_at`,
      [
        today,
        CACHE_REFRESH_INTERVAL_SECONDS.planningDemand,
        CACHE_REFRESH_INTERVAL_SECONDS.historical,
        CACHE_REFRESH_INTERVAL_SECONDS.future,
        CACHE_REFRESH_INTERVAL_SECONDS.today,
      ],
    );
    await client.query(
      `DELETE FROM cache_refresh_queue
        WHERE leased_at IS NULL
          AND (
            (kind = 'planning_demand' AND scope_date <> $1::date) OR
            (
              kind = 'schedule' AND
              (scope_date < $2::date OR scope_date > $3::date) AND
              requested_by IS NULL AND priority = 0
            )
          )`,
      [today, scheduleFrom, scheduleTo],
    );
    await client.query(
      `INSERT INTO cache_refresh_queue (cache_key, kind, scope_date, priority)
       SELECT cache_key, kind, scope_date, 0
         FROM cache_snapshots
        WHERE expires_at <= now()
          AND (
            (kind = 'schedule' AND scope_date BETWEEN $2::date AND $3::date) OR
            (kind = 'planning_demand' AND scope_date = $1::date)
          )
       ON CONFLICT (cache_key) DO NOTHING`,
      [today, scheduleFrom, scheduleTo],
    );
  });
}

export async function claimCacheRefreshJobs(limit = 4) {
  const leaseOwner = `${process.env.HOSTNAME ?? "worker"}:${randomUUID()}`;
  const leaseSeconds = cacheRefreshLeaseSeconds();
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 4;
  return withTransaction(async (client) => {
    const result = await client.query<{
      cache_key: string;
      kind: string;
      scope_date: string;
      attempts: number;
      lease_owner: string;
      claim_generation: string;
      request_generation: string;
    }>(
      `WITH candidates AS (
         SELECT cache_key
          FROM cache_refresh_queue
          WHERE available_at <= now()
            AND (
              leased_at IS NULL OR
              leased_at < now() - make_interval(secs => $2::integer)
            )
          ORDER BY priority DESC, requested_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE cache_refresh_queue AS queue
          SET leased_at = now(),
              lease_owner = $3,
              attempts = attempts + 1,
              claim_generation = claim_generation + 1
         FROM candidates
        WHERE queue.cache_key = candidates.cache_key
       RETURNING queue.cache_key, queue.kind, queue.scope_date::text,
                 queue.attempts, queue.lease_owner,
                 queue.claim_generation::text,
                 queue.request_generation::text`,
      [safeLimit, leaseSeconds, leaseOwner],
    );
    return result.rows.map(
      (row): CacheRefreshJob => ({
        cacheKey: row.cache_key,
        kind: parseCacheKind(row.kind),
        scopeDate: row.scope_date,
        attempts: row.attempts,
        leaseOwner: row.lease_owner,
        claimGeneration: row.claim_generation,
        requestGeneration: row.request_generation,
      }),
    );
  });
}

async function lockCacheSnapshot(client: PoolClient, cacheKey: string) {
  await client.query(
    `SELECT cache_key
       FROM cache_snapshots
      WHERE cache_key = $1
      FOR UPDATE`,
    [cacheKey],
  );
}

export async function renewCacheRefreshLease(job: CacheRefreshJob) {
  const leaseSeconds = cacheRefreshLeaseSeconds();
  const result = await query(
    `UPDATE cache_refresh_queue
        SET leased_at = now()
      WHERE cache_key = $1
        AND lease_owner = $2
        AND claim_generation = $3::bigint
        AND leased_at >= now() - make_interval(secs => $4::integer)
      RETURNING cache_key`,
    [job.cacheKey, job.leaseOwner, job.claimGeneration, leaseSeconds],
  );
  return result.rowCount === 1;
}

/** Return an intentionally cancelled active claim without failure backoff. */
export async function releaseCacheRefreshJob(
  job: CacheRefreshJob,
): Promise<CacheRefreshRelease> {
  const result = await query<{ request_generation: string }>(
    `UPDATE cache_refresh_queue
        SET leased_at = NULL,
            lease_owner = NULL,
            attempts = CASE
              WHEN request_generation <> $4::bigint THEN 0
              ELSE GREATEST(attempts - 1, 0)
            END,
            available_at = now(),
            last_error = CASE
              WHEN request_generation <> $4::bigint THEN NULL
              ELSE last_error
            END
      WHERE cache_key = $1
        AND lease_owner = $2
        AND claim_generation = $3::bigint
      RETURNING request_generation::text`,
    [
      job.cacheKey,
      job.leaseOwner,
      job.claimGeneration,
      job.requestGeneration,
    ],
  );
  const released = result.rows[0];
  if (!released) return { released: false, reason: "lease_lost" };
  return {
    released: true,
    refreshPending: released.request_generation !== job.requestGeneration,
  };
}

export async function storeCacheSnapshot(
  job: CacheRefreshJob,
  payload: unknown,
  sourceRefreshedAt: string,
): Promise<CacheRefreshCompletion> {
  const ttlSeconds = cacheRefreshIntervalSeconds(job.kind, job.scopeDate);
  const leaseSeconds = cacheRefreshLeaseSeconds();
  return withTransaction(async (client) => {
    await lockCacheSnapshot(client, job.cacheKey);
    const activeClaim = await client.query<{ request_generation: string }>(
      `SELECT request_generation::text
         FROM cache_refresh_queue
        WHERE cache_key = $1
          AND lease_owner = $2
          AND claim_generation = $3::bigint
          AND leased_at >= now() - make_interval(secs => $4::integer)
        FOR UPDATE`,
      [job.cacheKey, job.leaseOwner, job.claimGeneration, leaseSeconds],
    );
    const claimedRow = activeClaim.rows[0];
    if (!claimedRow) {
      return { stored: false, reason: "lease_lost" };
    }

    await client.query(
      `INSERT INTO cache_snapshots
         (cache_key, kind, scope_date, payload, source_refreshed_at, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, now() + ($6 * interval '1 second'))
       ON CONFLICT (cache_key) DO UPDATE SET
         payload = EXCLUDED.payload,
         source_refreshed_at = EXCLUDED.source_refreshed_at,
         refreshed_at = now(),
         expires_at = EXCLUDED.expires_at,
         last_error = NULL,
         consecutive_failures = 0`,
      [
        job.cacheKey,
        job.kind,
        job.scopeDate,
        JSON.stringify(payload),
        sourceRefreshedAt,
        ttlSeconds,
      ],
    );

    const refreshPending = claimedRow.request_generation !== job.requestGeneration;
    if (refreshPending) {
      await client.query(
        `UPDATE cache_refresh_queue
            SET leased_at = NULL,
                lease_owner = NULL,
                available_at = now(),
                attempts = 0,
                last_error = NULL
          WHERE cache_key = $1
            AND lease_owner = $2
            AND claim_generation = $3::bigint`,
        [job.cacheKey, job.leaseOwner, job.claimGeneration],
      );
    } else {
      await client.query(
        `DELETE FROM cache_refresh_queue
          WHERE cache_key = $1
            AND lease_owner = $2
            AND claim_generation = $3::bigint`,
        [job.cacheKey, job.leaseOwner, job.claimGeneration],
      );
    }
    return { stored: true, refreshPending };
  });
}

export async function failCacheRefresh(
  job: CacheRefreshJob,
  error: unknown,
): Promise<CacheRefreshFailure> {
  const message = error instanceof Error ? error.message : String(error);
  const backoffSeconds = Math.min(900, 15 * 2 ** Math.min(job.attempts, 6));
  const leaseSeconds = cacheRefreshLeaseSeconds();
  return withTransaction(async (client) => {
    await lockCacheSnapshot(client, job.cacheKey);
    const activeClaim = await client.query<{ request_generation: string }>(
      `SELECT request_generation::text
         FROM cache_refresh_queue
        WHERE cache_key = $1
          AND lease_owner = $2
          AND claim_generation = $3::bigint
          AND leased_at >= now() - make_interval(secs => $4::integer)
        FOR UPDATE`,
      [job.cacheKey, job.leaseOwner, job.claimGeneration, leaseSeconds],
    );
    const claimedRow = activeClaim.rows[0];
    if (!claimedRow) {
      return { recorded: false, reason: "lease_lost" };
    }
    if (claimedRow.request_generation !== job.requestGeneration) {
      await client.query(
        `UPDATE cache_refresh_queue
            SET leased_at = NULL,
                lease_owner = NULL,
                available_at = now(),
                attempts = 0,
                last_error = NULL
          WHERE cache_key = $1
            AND lease_owner = $2
            AND claim_generation = $3::bigint`,
        [job.cacheKey, job.leaseOwner, job.claimGeneration],
      );
      return { recorded: false, reason: "superseded" };
    }

    await client.query(
      `UPDATE cache_snapshots
          SET last_error = $2, consecutive_failures = consecutive_failures + 1
        WHERE cache_key = $1`,
      [job.cacheKey, message],
    );
    await client.query(
      `UPDATE cache_refresh_queue
          SET leased_at = NULL,
              lease_owner = NULL,
              last_error = $4,
              available_at = now() + ($5 * interval '1 second')
        WHERE cache_key = $1
          AND lease_owner = $2
          AND claim_generation = $3::bigint`,
      [
        job.cacheKey,
        job.leaseOwner,
        job.claimGeneration,
        message,
        backoffSeconds,
      ],
    );
    return { recorded: true, backoffSeconds };
  });
}
