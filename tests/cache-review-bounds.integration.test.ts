import assert from "node:assert/strict";
import test from "node:test";
import { isolatedDatabase } from "./support/database";
import { withTransaction } from "../platform/database";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://planner.example.test${path}`, init);
}

function dateFromOffset(year: number, month: number, dayOffset: number) {
  return new Date(Date.UTC(year, month - 1, 1 + dayOffset))
    .toISOString()
    .slice(0, 10);
}

test(
  "historical calendar browsing and selected-date refresh work stay bounded",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async (t) => {
    const admin = await isolatedDatabase(t, {
      environment: {
        AUTH_MODE: "development", BOOTSTRAP_ADMIN_EMAILS: "",
        DEV_USER_SUBJECT: "dev:cache-review-bounds", DEV_USER_EMAIL: "cache-review@example.test",
        DEV_USER_NAME: "Cache Review Tester", DEV_PAGE_PERMISSIONS: "dispatch_review",
      },
    });
    const { GET: getSchedule } = await import(
      "../app/api/autotask-schedule/route"
    );
    const cacheStore = await import("../modules/work/server/snapshots");
    const reviewRefresh = await import(
      "../modules/work/server/refresh"
    );

    const reset = async () => {
      await admin.query(
        "TRUNCATE cache_review_refresh_requests, cache_refresh_dead_letters, cache_refresh_queue, cache_snapshots",
      );
    };

    await t.test("browsing many month summaries never queues live refreshes", async () => {
      await reset();
      for (const month of [
        "2018-01",
        "2019-06",
        "2022-12",
        "2025-03",
        "2030-09",
        "2035-12",
        "2040-04",
        "2050-11",
      ]) {
        const response = await getSchedule(
          request(`/api/autotask-schedule?month=${month}`),
        );
        assert.equal(response.status, 200, month);
      }
      const queue = await admin.query("SELECT cache_key FROM cache_refresh_queue");
      assert.equal(queue.rowCount, 0);
    });

    const user = await admin.query<{ id: string }>(
      "SELECT id::text FROM app_users WHERE external_subject = $1",
      [process.env.DEV_USER_SUBJECT],
    );
    const userId = user.rows[0]?.id;
    assert.ok(userId);

    await t.test("selected-date reads never queue review refreshes", async () => {
      await reset();
      for (let index = 0; index < 20; index += 1) {
        const date = dateFromOffset(2040, 1, index);
        const response = await getSchedule(
          request(`/api/autotask-schedule?date=${date}`),
        );
        assert.equal(response.status, 503, date);
      }
      assert.equal(
        (await admin.query("SELECT 1 FROM cache_refresh_queue")).rowCount,
        0,
      );
      assert.equal(
        (await admin.query("SELECT 1 FROM cache_review_refresh_requests")).rowCount,
        0,
      );
    });

    await t.test("conditional and ordinary reads cannot recreate aged-out work", async () => {
      await reset();
      const date = "2050-01-01";
      const initialResponse = await getSchedule(
        request(`/api/autotask-schedule?date=${date}`),
      );
      assert.equal(initialResponse.status, 503);
      const etag = initialResponse.headers.get("ETag");
      assert.ok(etag);

      const passiveResponse = await getSchedule(
        request(`/api/autotask-schedule?date=${date}`, {
          headers: { "If-None-Match": etag },
        }),
      );
      assert.equal(passiveResponse.status, 503);
      const passiveBody = (await passiveResponse.json()) as { detail?: string };
      assert.equal(
        passiveBody.detail,
        "No background refresh is currently queued.",
      );

      assert.equal(
        (await getSchedule(request(`/api/autotask-schedule?date=${date}`))).status,
        503,
      );
      assert.equal(
        (await admin.query(
          "SELECT 1 FROM cache_refresh_queue WHERE cache_key = $1",
          [`schedule:${date}`],
        )).rowCount,
        0,
      );
    });

    await t.test("priority invalidations never become bounded review work", async () => {
      await reset();
      const date = "2053-01-01";
      assert.deepEqual(
        await reviewRefresh.requestScheduleReviewRefresh(date, userId),
        { queued: true },
      );
      await admin.query(
        `UPDATE cache_refresh_queue
            SET attempts = $2 - 1
          WHERE cache_key = $1`,
        [
          `schedule:${date}`,
          reviewRefresh.SCHEDULE_REVIEW_REFRESH_POLICY.terminalAttempts,
        ],
      );

      await withTransaction((client) =>
        cacheStore.invalidateCacheSnapshots(client, ["schedule"], userId),
      );

      const invalidated = await admin.query<{
        priority: number;
        request_generation: string;
      }>(
        `SELECT priority, request_generation::text
           FROM cache_refresh_queue
          WHERE cache_key = $1`,
        [`schedule:${date}`],
      );
      assert.equal(invalidated.rows[0]?.priority, 10);
      const marker = await admin.query<{ request_generation: string }>(
        `SELECT request_generation::text
           FROM cache_review_refresh_requests
          WHERE cache_key = $1`,
        [`schedule:${date}`],
      );
      assert.notEqual(
        marker.rows[0]?.request_generation,
        invalidated.rows[0]?.request_generation,
      );

      const claim = (await cacheStore.claimCacheRefreshJobs(1))[0];
      assert.ok(claim);
      assert.equal(
        claim.attempts,
        reviewRefresh.SCHEDULE_REVIEW_REFRESH_POLICY.terminalAttempts,
      );
      const failureError = new Error("priority invalidation failure");
      assert.deepEqual(
        await reviewRefresh.deadLetterScheduleReviewRefresh(
          claim,
          failureError,
          "2026-01-01",
          "2026-12-31",
        ),
        { handled: false },
      );
      assert.equal(
        (await cacheStore.failCacheRefresh(claim, failureError)).recorded,
        true,
      );
      assert.equal(
        (await admin.query(
          "SELECT 1 FROM cache_refresh_dead_letters WHERE cache_key = $1",
          [`schedule:${date}`],
        )).rowCount,
        0,
      );

      await admin.query(
        `UPDATE cache_refresh_queue
            SET requested_at = now() - interval '2 hours'
          WHERE cache_key = $1`,
        [`schedule:${date}`],
      );
      await reviewRefresh.pruneScheduleReviewRefreshes(
        "2026-01-01",
        "2026-12-31",
      );
      assert.equal(
        (await admin.query(
          "SELECT 1 FROM cache_refresh_queue WHERE cache_key = $1",
          [`schedule:${date}`],
        )).rowCount,
        1,
        "priority invalidation survives review-age pruning",
      );
      assert.equal(
        (await admin.query(
          "SELECT 1 FROM cache_review_refresh_requests WHERE cache_key = $1",
          [`schedule:${date}`],
        )).rowCount,
        0,
        "superseded review marker is cleaned",
      );

      for (
        let index = 0;
        index < reviewRefresh.SCHEDULE_REVIEW_REFRESH_POLICY.maxOutstandingPerUser;
        index += 1
      ) {
        assert.deepEqual(
          await reviewRefresh.requestScheduleReviewRefresh(
            dateFromOffset(2070, 1, index),
            userId,
          ),
          { queued: true },
        );
      }
      assert.equal(
        (await admin.query<{ count: number }>(
          `SELECT COUNT(*)::integer AS count
             FROM cache_review_refresh_requests
            WHERE requested_by = $1::uuid`,
          [userId],
        )).rows[0]?.count,
        reviewRefresh.SCHEDULE_REVIEW_REFRESH_POLICY.maxOutstandingPerUser,
      );
      assert.equal(
        (await admin.query(
          "SELECT 1 FROM cache_refresh_queue WHERE cache_key = $1",
          [`schedule:${date}`],
        )).rowCount,
        1,
        "review quota eviction never deletes the invalidation",
      );
    });

    await t.test("capacity refusal preserves the existing dead letter", async () => {
      await reset();
      const deadLetterDate = "2052-01-01";
      await admin.query(
        `INSERT INTO cache_refresh_dead_letters
           (cache_key, kind, scope_date, requested_by, attempts, failed_at, last_error)
         VALUES ($1, 'schedule', $2, $3::uuid, $4, now() - interval '2 hours', $5)`,
        [
          `schedule:${deadLetterDate}`,
          deadLetterDate,
          userId,
          reviewRefresh.SCHEDULE_REVIEW_REFRESH_POLICY.terminalAttempts,
          "terminal failure",
        ],
      );
      for (
        let index = 0;
        index < reviewRefresh.SCHEDULE_REVIEW_REFRESH_POLICY.maxOutstandingPerUser;
        index += 1
      ) {
        assert.deepEqual(
          await reviewRefresh.requestScheduleReviewRefresh(
            dateFromOffset(2060, 1, index),
            userId,
          ),
          { queued: true },
        );
      }
      const claims = await cacheStore.claimCacheRefreshJobs(
        reviewRefresh.SCHEDULE_REVIEW_REFRESH_POLICY.maxOutstandingPerUser,
      );
      assert.equal(
        claims.length,
        reviewRefresh.SCHEDULE_REVIEW_REFRESH_POLICY.maxOutstandingPerUser,
      );

      assert.deepEqual(
        await reviewRefresh.requestScheduleReviewRefresh(
          deadLetterDate,
          userId,
          true,
        ),
        { queued: false, reason: "limit" },
      );
      assert.equal(
        (await admin.query(
          "SELECT 1 FROM cache_refresh_dead_letters WHERE cache_key = $1",
          [`schedule:${deadLetterDate}`],
        )).rowCount,
        1,
      );
      assert.equal(
        (await admin.query(
          "SELECT 1 FROM cache_refresh_queue WHERE cache_key = $1",
          [`schedule:${deadLetterDate}`],
        )).rowCount,
        0,
      );
    });

    await t.test("repeated out-of-window failures enter a dead letter", async () => {
      await reset();
      const date = "2051-01-01";
      assert.deepEqual(
        await reviewRefresh.requestScheduleReviewRefresh(date, userId),
        { queued: true },
      );

      for (
        let attempt = 1;
        attempt <= reviewRefresh.SCHEDULE_REVIEW_REFRESH_POLICY.terminalAttempts;
        attempt += 1
      ) {
        const claim = (await cacheStore.claimCacheRefreshJobs(1))[0];
        assert.ok(claim);
        assert.equal(claim.attempts, attempt);
        const error = new Error(`historical failure ${attempt}`);
        const terminal = await reviewRefresh.deadLetterScheduleReviewRefresh(
          claim,
          error,
          "2026-01-01",
          "2026-12-31",
        );
        if (attempt < reviewRefresh.SCHEDULE_REVIEW_REFRESH_POLICY.terminalAttempts) {
          assert.deepEqual(terminal, { handled: false });
          const failure = await cacheStore.failCacheRefresh(claim, error);
          assert.equal(failure.recorded, true);
          await admin.query(
            "UPDATE cache_refresh_queue SET available_at = now() WHERE cache_key = $1",
            [claim.cacheKey],
          );
        } else {
          assert.deepEqual(terminal, {
            handled: true,
            deadLettered: true,
            reason: "dead_lettered",
          });
        }
      }

      assert.equal((await cacheStore.claimCacheRefreshJobs(1)).length, 0);
      const deadLetter = await admin.query<{
        attempts: number;
        last_error: string;
      }>(
        `SELECT attempts, last_error
           FROM cache_refresh_dead_letters
          WHERE cache_key = $1`,
        [`schedule:${date}`],
      );
      assert.deepEqual(deadLetter.rows[0], {
        attempts: reviewRefresh.SCHEDULE_REVIEW_REFRESH_POLICY.terminalAttempts,
        last_error: `historical failure ${reviewRefresh.SCHEDULE_REVIEW_REFRESH_POLICY.terminalAttempts}`,
      });

      assert.deepEqual(
        await reviewRefresh.requestScheduleReviewRefresh(date, userId),
        { queued: false, reason: "dead_lettered" },
      );
      assert.equal(
        (await admin.query(
          "SELECT 1 FROM cache_refresh_queue WHERE cache_key = $1",
          [`schedule:${date}`],
        )).rowCount,
        0,
      );

      assert.deepEqual(
        await reviewRefresh.requestScheduleReviewRefresh(date, userId, true),
        { queued: true },
      );
      assert.equal(
        (await admin.query(
          "SELECT 1 FROM cache_refresh_dead_letters WHERE cache_key = $1",
          [`schedule:${date}`],
        )).rowCount,
        0,
      );
    });
  },
);
