import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { isolatedDatabase } from "./support/database";
import { withTransaction } from "../platform/database";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

async function seedSnapshot(
  client: Client,
  kind: "schedule" | "planning_demand",
  scopeDate: string,
  payload: Record<string, unknown>,
) {
  await client.query(
    `INSERT INTO cache_snapshots
       (cache_key, kind, scope_date, payload, source_refreshed_at, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, now(), now() - interval '1 minute')`,
    [`${kind}:${scopeDate}`, kind, scopeDate, JSON.stringify(payload)],
  );
}

test(
  "cache refresh claims are fenced and retain mid-flight invalidations",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async (t) => {
    const admin = await isolatedDatabase(t, {
      environment: { CACHE_REFRESH_LEASE_SECONDS: "60" },
    });
    const cacheStore = await import("../modules/work/server/snapshots");
    const reset = async () => {
      await admin.query("TRUNCATE cache_refresh_queue, cache_snapshots");
    };

    await t.test(
      "an expired worker cannot overwrite a newer success or failure metadata",
      async () => {
        await reset();
        const scopeDate = "2030-01-01";
        await cacheStore.requestCacheRefresh("schedule", scopeDate, null, 10);
        const firstClaim = (await cacheStore.claimCacheRefreshJobs(1))[0];
        assert.ok(firstClaim);
        assert.equal(firstClaim.claimGeneration, "1");
        assert.equal(firstClaim.requestGeneration, "1");

        await admin.query(
          `UPDATE cache_refresh_queue
              SET leased_at = now() - interval '61 seconds'
            WHERE cache_key = $1`,
          [firstClaim.cacheKey],
        );
        const secondClaim = (await cacheStore.claimCacheRefreshJobs(1))[0];
        assert.ok(secondClaim);
        assert.equal(secondClaim.claimGeneration, "2");
        assert.notEqual(secondClaim.leaseOwner, firstClaim.leaseOwner);

        assert.deepEqual(
          await cacheStore.storeCacheSnapshot(
            secondClaim,
            { version: "new" },
            "2030-01-01T12:00:00.000Z",
          ),
          { stored: true, refreshPending: false },
        );
        assert.deepEqual(
          await cacheStore.storeCacheSnapshot(
            firstClaim,
            { version: "old" },
            "2030-01-01T11:00:00.000Z",
          ),
          { stored: false, reason: "lease_lost" },
        );
        assert.deepEqual(
          await cacheStore.failCacheRefresh(
            firstClaim,
            new Error("stale worker failure"),
          ),
          { recorded: false, reason: "lease_lost" },
        );

        const snapshot = await admin.query<{
          payload: { version: string };
          last_error: string | null;
          consecutive_failures: number;
        }>(
          `SELECT payload, last_error, consecutive_failures
             FROM cache_snapshots
            WHERE cache_key = $1`,
          [firstClaim.cacheKey],
        );
        assert.deepEqual(snapshot.rows[0], {
          payload: { version: "new" },
          last_error: null,
          consecutive_failures: 0,
        });
      },
    );

    await t.test(
      "a refresh requested during an active claim remains queued",
      async () => {
        await reset();
        const scopeDate = "2030-01-02";
        await cacheStore.requestCacheRefresh("schedule", scopeDate);
        const firstClaim = (await cacheStore.claimCacheRefreshJobs(1))[0];
        assert.ok(firstClaim);

        await cacheStore.requestCacheRefresh("schedule", scopeDate, null, 10);
        const inFlight = await admin.query<{
          lease_owner: string | null;
          claim_generation: string;
          request_generation: string;
        }>(
          `SELECT lease_owner, claim_generation::text, request_generation::text
             FROM cache_refresh_queue
            WHERE cache_key = $1`,
          [firstClaim.cacheKey],
        );
        assert.deepEqual(inFlight.rows[0], {
          lease_owner: firstClaim.leaseOwner,
          claim_generation: firstClaim.claimGeneration,
          request_generation: "2",
        });

        assert.deepEqual(
          await cacheStore.storeCacheSnapshot(
            firstClaim,
            { version: "first" },
            "2030-01-02T11:00:00.000Z",
          ),
          { stored: true, refreshPending: true },
        );
        const pending = await admin.query<{
          lease_owner: string | null;
          attempts: number;
          request_generation: string;
        }>(
          `SELECT lease_owner, attempts, request_generation::text
             FROM cache_refresh_queue
            WHERE cache_key = $1`,
          [firstClaim.cacheKey],
        );
        assert.deepEqual(pending.rows[0], {
          lease_owner: null,
          attempts: 0,
          request_generation: "2",
        });

        const secondClaim = (await cacheStore.claimCacheRefreshJobs(1))[0];
        assert.ok(secondClaim);
        assert.equal(secondClaim.claimGeneration, "2");
        assert.equal(secondClaim.requestGeneration, "2");
        assert.deepEqual(
          await cacheStore.storeCacheSnapshot(
            secondClaim,
            { version: "second" },
            "2030-01-02T12:00:00.000Z",
          ),
          { stored: true, refreshPending: false },
        );
        const remaining = await admin.query(
          "SELECT 1 FROM cache_refresh_queue WHERE cache_key = $1",
          [firstClaim.cacheKey],
        );
        assert.equal(remaining.rowCount, 0);
      },
    );

    await t.test(
      "a superseded failure does not poison the snapshot or delay the newer request",
      async () => {
        await reset();
        const scopeDate = "2030-01-03";
        await seedSnapshot(admin, "schedule", scopeDate, { version: "cached" });
        await cacheStore.requestCacheRefresh("schedule", scopeDate);
        const claim = (await cacheStore.claimCacheRefreshJobs(1))[0];
        assert.ok(claim);
        await cacheStore.requestCacheRefresh("schedule", scopeDate, null, 10);

        assert.deepEqual(
          await cacheStore.failCacheRefresh(
            claim,
            new Error("superseded failure"),
          ),
          { recorded: false, reason: "superseded" },
        );
        const snapshot = await admin.query<{
          last_error: string | null;
          consecutive_failures: number;
        }>(
          `SELECT last_error, consecutive_failures
             FROM cache_snapshots
            WHERE cache_key = $1`,
          [claim.cacheKey],
        );
        assert.deepEqual(snapshot.rows[0], {
          last_error: null,
          consecutive_failures: 0,
        });
        const pending = await admin.query<{
          lease_owner: string | null;
          attempts: number;
          available: boolean;
        }>(
          `SELECT lease_owner, attempts, available_at <= now() AS available
             FROM cache_refresh_queue
            WHERE cache_key = $1`,
          [claim.cacheKey],
        );
        assert.deepEqual(pending.rows[0], {
          lease_owner: null,
          attempts: 0,
          available: true,
        });
      },
    );

    await t.test(
      "roster and status invalidations are preserved while snapshots are leased",
      async () => {
        await reset();
        const scheduleDate = "2030-01-04";
        const demandDate = "2030-01-05";
        const warmingDate = "2030-01-06";
        await seedSnapshot(admin, "schedule", scheduleDate, { version: "schedule" });
        await seedSnapshot(admin, "planning_demand", demandDate, {
          version: "demand",
        });
        await cacheStore.requestCacheRefresh("schedule", scheduleDate);
        await cacheStore.requestCacheRefresh("planning_demand", demandDate);
        await cacheStore.requestCacheRefresh("schedule", warmingDate);
        const claims = await cacheStore.claimCacheRefreshJobs(3);
        assert.equal(claims.length, 3);

        await withTransaction((client) =>
          cacheStore.invalidateCacheSnapshots(
            client,
            ["schedule", "planning_demand"],
            null,
          ),
        );
        const inFlight = await admin.query<{
          cache_key: string;
          lease_owner: string | null;
          request_generation: string;
        }>(
          `SELECT cache_key, lease_owner, request_generation::text
             FROM cache_refresh_queue
            ORDER BY cache_key`,
        );
        assert.equal(inFlight.rowCount, 3);
        for (const row of inFlight.rows) {
          const claim = claims.find((candidate) => candidate.cacheKey === row.cache_key);
          assert.ok(claim);
          assert.equal(row.lease_owner, claim.leaseOwner);
          assert.equal(row.request_generation, "2");
        }

        for (const claim of claims) {
          assert.deepEqual(
            await cacheStore.storeCacheSnapshot(
              claim,
              { version: "pre-invalidation" },
              "2030-01-04T12:00:00.000Z",
            ),
            { stored: true, refreshPending: true },
          );
        }
        const pending = await admin.query<{
          lease_owner: string | null;
          request_generation: string;
        }>(
          `SELECT lease_owner, request_generation::text
             FROM cache_refresh_queue
            ORDER BY cache_key`,
        );
        assert.equal(pending.rowCount, 3);
        assert.ok(pending.rows.every((row) => row.lease_owner === null));
        assert.ok(
          pending.rows.every((row) => row.request_generation === "2"),
        );
      },
    );

    await t.test(
      "an active long-running claim can renew but an expired claim cannot",
      async () => {
        await reset();
        const scopeDate = "2030-01-07";
        await cacheStore.requestCacheRefresh("schedule", scopeDate);
        const claim = (await cacheStore.claimCacheRefreshJobs(1))[0];
        assert.ok(claim);

        await admin.query(
          `UPDATE cache_refresh_queue
              SET leased_at = now() - interval '30 seconds'
            WHERE cache_key = $1`,
          [claim.cacheKey],
        );
        const before = await admin.query<{ leased_at: Date }>(
          "SELECT leased_at FROM cache_refresh_queue WHERE cache_key = $1",
          [claim.cacheKey],
        );
        assert.equal(await cacheStore.renewCacheRefreshLease(claim), true);
        const renewed = await admin.query<{ leased_at: Date }>(
          "SELECT leased_at FROM cache_refresh_queue WHERE cache_key = $1",
          [claim.cacheKey],
        );
        assert.ok(renewed.rows[0].leased_at > before.rows[0].leased_at);

        await admin.query(
          `UPDATE cache_refresh_queue
              SET leased_at = now() - interval '61 seconds'
            WHERE cache_key = $1`,
          [claim.cacheKey],
        );
        assert.equal(await cacheStore.renewCacheRefreshLease(claim), false);
      },
    );
  },
);
