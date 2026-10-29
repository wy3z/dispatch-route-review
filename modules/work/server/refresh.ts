import type { PoolClient } from "pg";
import { cacheKey, cacheRefreshLeaseSeconds } from "./snapshots";
import type { CacheRefreshJob } from "./snapshots";
import { withTransaction } from "../../../platform/database";
import { isIsoCalendarDate } from "../../../shared/calendar";

export const SCHEDULE_REVIEW_REFRESH_POLICY = {
  maxOutstandingPerUser: 8,
  maxOutstandingAgeSeconds: 60 * 60,
  terminalAttempts: 6,
  deadLetterRetrySeconds: 60 * 60,
  deadLetterRetentionSeconds: 7 * 24 * 60 * 60,
} as const;

export type ScheduleReviewRefreshRequest =
  | { queued: true }
  | { queued: false; reason: "dead_lettered" | "limit" };

export type ScheduleReviewDeadLetterResult =
  | { handled: false }
  | {
      handled: true;
      deadLettered: boolean;
      reason: "dead_lettered" | "lease_lost" | "superseded";
    };

function assertReviewDate(scopeDate: string) {
  if (!isIsoCalendarDate(scopeDate)) {
    throw new Error("scopeDate must be a real ISO calendar date (YYYY-MM-DD).");
  }
}

async function lockReviewRequester(client: PoolClient, requestedBy: string) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [requestedBy],
  );
}

async function removeStaleReviewMarker(client: PoolClient, cacheKey: string) {
  await client.query(
    `DELETE FROM cache_review_refresh_requests AS review
      WHERE review.cache_key = $1
        AND NOT EXISTS (
          SELECT 1
            FROM cache_refresh_queue AS queue
           WHERE queue.cache_key = review.cache_key
             AND queue.request_generation = review.request_generation
        )`,
    [cacheKey],
  );
}

export async function requestScheduleReviewRefresh(
  scopeDate: string,
  requestedBy: string,
  force = false,
): Promise<ScheduleReviewRefreshRequest> {
  assertReviewDate(scopeDate);
  const key = cacheKey("schedule", scopeDate);
  const leaseSeconds = cacheRefreshLeaseSeconds();

  return withTransaction(async (client) => {
    await lockReviewRequester(client, requestedBy);
    await removeStaleReviewMarker(client, key);

    const existing = await client.query<{
      request_generation: string;
      review_requested_by: string | null;
    }>(
      `SELECT queue.request_generation::text,
              review.requested_by::text AS review_requested_by
         FROM cache_refresh_queue AS queue
         LEFT JOIN cache_review_refresh_requests AS review
           ON review.cache_key = queue.cache_key
          AND review.request_generation = queue.request_generation
        WHERE queue.cache_key = $1
        FOR UPDATE OF queue`,
      [key],
    );
    const existingRow = existing.rows[0];

    // Existing system/invalidation work already satisfies the selected-date
    // request. Never relabel or supersede it as non-critical review work.
    if (existingRow && !existingRow.review_requested_by) {
      await client.query(
        "DELETE FROM cache_refresh_dead_letters WHERE cache_key = $1",
        [key],
      );
      return { queued: true };
    }

    // Ordinary polling/selection must not rejuvenate an already queued review
    // generation. Any queued generation also supersedes an older dead letter.
    if (existingRow && !force) {
      await client.query(
        "DELETE FROM cache_refresh_dead_letters WHERE cache_key = $1",
        [key],
      );
      return { queued: true };
    }

    if (!force) {
      const deadLetter = await client.query<{ retryable: boolean }>(
        `SELECT failed_at <= now() - make_interval(secs => $2::integer) AS retryable
           FROM cache_refresh_dead_letters
          WHERE cache_key = $1
          FOR UPDATE`,
        [key, SCHEDULE_REVIEW_REFRESH_POLICY.deadLetterRetrySeconds],
      );
      if (deadLetter.rows[0] && !deadLetter.rows[0].retryable) {
        return { queued: false, reason: "dead_lettered" };
      }
    }

    const active = await client.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
         FROM cache_refresh_queue AS queue
         JOIN cache_review_refresh_requests AS review
           ON review.cache_key = queue.cache_key
          AND review.request_generation = queue.request_generation
        WHERE queue.kind = 'schedule'
          AND review.requested_by = $1::uuid
          AND queue.cache_key <> $2`,
      [requestedBy, key],
    );
    if (
      (active.rows[0]?.count ?? 0) >=
      SCHEDULE_REVIEW_REFRESH_POLICY.maxOutstandingPerUser
    ) {
      const evicted = await client.query<{ cache_key: string }>(
        `DELETE FROM cache_refresh_queue
          WHERE cache_key = (
            SELECT queue.cache_key
              FROM cache_refresh_queue AS queue
              JOIN cache_review_refresh_requests AS review
                ON review.cache_key = queue.cache_key
               AND review.request_generation = queue.request_generation
             WHERE queue.kind = 'schedule'
               AND review.requested_by = $1::uuid
               AND queue.cache_key <> $2
               AND queue.leased_at IS NULL
             ORDER BY queue.requested_at, queue.cache_key
             LIMIT 1
          )
        RETURNING cache_key`,
        [requestedBy, key],
      );
      const evictedKey = evicted.rows[0]?.cache_key;
      if (!evictedKey) {
        return { queued: false, reason: "limit" };
      }
      await client.query(
        "DELETE FROM cache_review_refresh_requests WHERE cache_key = $1",
        [evictedKey],
      );
    }

    const priority = force ? 10 : 0;
    const queued = await client.query<{ request_generation: string }>(
      `INSERT INTO cache_refresh_queue
         (cache_key, kind, scope_date, requested_by, priority)
       VALUES ($1, 'schedule', $2, $3, $4)
       ON CONFLICT (cache_key) DO UPDATE SET
         request_generation = CASE
           WHEN $5::boolean THEN cache_refresh_queue.request_generation + 1
           ELSE cache_refresh_queue.request_generation
         END,
         requested_at = CASE
           WHEN $5::boolean THEN now()
           ELSE cache_refresh_queue.requested_at
         END,
         available_at = CASE
           WHEN $5::boolean THEN now()
           ELSE cache_refresh_queue.available_at
         END,
         requested_by = COALESCE(cache_refresh_queue.requested_by, EXCLUDED.requested_by),
         priority = GREATEST(cache_refresh_queue.priority, EXCLUDED.priority),
         last_error = CASE
           WHEN $5::boolean THEN NULL
           ELSE cache_refresh_queue.last_error
         END,
         leased_at = CASE
           WHEN cache_refresh_queue.leased_at < now() - make_interval(secs => $6::integer) THEN NULL
           ELSE cache_refresh_queue.leased_at
         END,
         lease_owner = CASE
           WHEN cache_refresh_queue.leased_at < now() - make_interval(secs => $6::integer) THEN NULL
           ELSE cache_refresh_queue.lease_owner
         END
       RETURNING request_generation::text`,
      [key, scopeDate, requestedBy, priority, force, leaseSeconds],
    );
    const requestGeneration = queued.rows[0]?.request_generation;
    if (!requestGeneration) {
      throw new Error(`Failed to queue schedule review refresh for ${scopeDate}.`);
    }

    await client.query(
      `INSERT INTO cache_review_refresh_requests
         (cache_key, requested_by, request_generation)
       VALUES ($1, $2, $3::bigint)
       ON CONFLICT (cache_key) DO UPDATE SET
         requested_by = EXCLUDED.requested_by,
         request_generation = EXCLUDED.request_generation,
         requested_at = now()`,
      [key, requestedBy, requestGeneration],
    );
    // A queued review generation replaces a cooled-down terminal record for
    // the same key. Capacity refusal happens before this point, so it cannot
    // accidentally erase a dead letter without replacement work.
    await client.query(
      "DELETE FROM cache_refresh_dead_letters WHERE cache_key = $1",
      [key],
    );
    return { queued: true };
  });
}

export async function pruneScheduleReviewRefreshes(
  scheduleFrom: string,
  scheduleTo: string,
) {
  assertReviewDate(scheduleFrom);
  assertReviewDate(scheduleTo);
  if (scheduleFrom > scheduleTo) {
    throw new Error("scheduleFrom must be on or before scheduleTo.");
  }

  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM cache_review_refresh_requests AS review
        WHERE NOT EXISTS (
          SELECT 1
            FROM cache_refresh_queue AS queue
           WHERE queue.cache_key = review.cache_key
             AND queue.request_generation = review.request_generation
        )`,
    );
    const pruned = await client.query<{ cache_key: string }>(
      `DELETE FROM cache_refresh_queue AS queue
        USING cache_review_refresh_requests AS review
        WHERE queue.cache_key = review.cache_key
          AND review.request_generation = queue.request_generation
          AND queue.kind = 'schedule'
          AND queue.leased_at IS NULL
          AND (queue.scope_date < $1::date OR queue.scope_date > $2::date)
          AND queue.requested_at < now() - make_interval(secs => $3::integer)
      RETURNING queue.cache_key`,
      [
        scheduleFrom,
        scheduleTo,
        SCHEDULE_REVIEW_REFRESH_POLICY.maxOutstandingAgeSeconds,
      ],
    );
    if (pruned.rows.length > 0) {
      await client.query(
        "DELETE FROM cache_review_refresh_requests WHERE cache_key = ANY($1::text[])",
        [pruned.rows.map((row) => row.cache_key)],
      );
    }
    await client.query(
      `DELETE FROM cache_refresh_dead_letters
        WHERE scope_date BETWEEN $1::date AND $2::date
           OR failed_at < now() - make_interval(secs => $3::integer)`,
      [
        scheduleFrom,
        scheduleTo,
        SCHEDULE_REVIEW_REFRESH_POLICY.deadLetterRetentionSeconds,
      ],
    );
  });
}

export async function deadLetterScheduleReviewRefresh(
  job: CacheRefreshJob,
  error: unknown,
  scheduleFrom: string,
  scheduleTo: string,
): Promise<ScheduleReviewDeadLetterResult> {
  assertReviewDate(scheduleFrom);
  assertReviewDate(scheduleTo);
  if (
    job.kind !== "schedule" ||
    job.attempts < SCHEDULE_REVIEW_REFRESH_POLICY.terminalAttempts ||
    (job.scopeDate >= scheduleFrom && job.scopeDate <= scheduleTo)
  ) {
    return { handled: false };
  }

  const message = error instanceof Error ? error.message : String(error);
  const leaseSeconds = cacheRefreshLeaseSeconds();
  return withTransaction(async (client) => {
    const activeClaim = await client.query<{
      request_generation: string;
      review_requested_by: string | null;
    }>(
      `SELECT queue.request_generation::text,
              review.requested_by::text AS review_requested_by
         FROM cache_refresh_queue AS queue
         LEFT JOIN cache_review_refresh_requests AS review
           ON review.cache_key = queue.cache_key
          AND review.request_generation = queue.request_generation
        WHERE queue.cache_key = $1
          AND queue.lease_owner = $2
          AND queue.claim_generation = $3::bigint
          AND queue.leased_at >= now() - make_interval(secs => $4::integer)
        FOR UPDATE OF queue`,
      [job.cacheKey, job.leaseOwner, job.claimGeneration, leaseSeconds],
    );
    const claimedRow = activeClaim.rows[0];
    if (!claimedRow) {
      return { handled: true, deadLettered: false, reason: "lease_lost" };
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
      return { handled: true, deadLettered: false, reason: "superseded" };
    }
    if (!claimedRow.review_requested_by) {
      return { handled: false };
    }

    await client.query(
      `UPDATE cache_snapshots
          SET last_error = $2, consecutive_failures = consecutive_failures + 1
        WHERE cache_key = $1`,
      [job.cacheKey, message],
    );
    await client.query(
      `INSERT INTO cache_refresh_dead_letters
         (cache_key, kind, scope_date, requested_by, attempts, last_error)
       VALUES ($1, 'schedule', $2, $3, $4, $5)
       ON CONFLICT (cache_key) DO UPDATE SET
         requested_by = EXCLUDED.requested_by,
         attempts = EXCLUDED.attempts,
         failed_at = now(),
         last_error = EXCLUDED.last_error`,
      [
        job.cacheKey,
        job.scopeDate,
        claimedRow.review_requested_by,
        job.attempts,
        message,
      ],
    );
    await client.query(
      `DELETE FROM cache_review_refresh_requests
        WHERE cache_key = $1
          AND request_generation = $2::bigint`,
      [job.cacheKey, job.requestGeneration],
    );
    await client.query(
      `DELETE FROM cache_refresh_queue
        WHERE cache_key = $1
          AND lease_owner = $2
          AND claim_generation = $3::bigint`,
      [job.cacheKey, job.leaseOwner, job.claimGeneration],
    );
    return { handled: true, deadLettered: true, reason: "dead_lettered" };
  });
}
