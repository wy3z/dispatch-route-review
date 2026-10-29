import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const migrationsDirectory = join(process.cwd(), "db/migrations");

test(
  "worker cancellation releases claims without backoff; stale releases remain fenced",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(databaseUrl);
    const admin = new Client({ connectionString: databaseUrl });
    const schema = `cache_cancel_${process.pid}_${Date.now()}`;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousLeaseSeconds = process.env.CACHE_REFRESH_LEASE_SECONDS;
    let databaseModule: typeof import("../platform/database") | null = null;

    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(`SET search_path TO "${schema}", public`);

      const migrationNames = (await readdir(migrationsDirectory))
        .filter((name) => /^\d{3}_.*\.sql$/.test(name))
        .sort();
      for (const name of migrationNames) {
        await admin.query(await readFile(join(migrationsDirectory, name), "utf8"));
      }

      const scopedDatabaseUrl = new URL(databaseUrl);
      scopedDatabaseUrl.searchParams.set(
        "options",
        `-csearch_path=${schema},public`,
      );
      process.env.DATABASE_URL = scopedDatabaseUrl.toString();
      process.env.CACHE_REFRESH_LEASE_SECONDS = "60";

      const cacheStore = await import("../modules/work/server/snapshots");
      databaseModule = await import("../platform/database");
      const { handleCacheRefreshFailure } = await import("../modules/work/worker/run");
      const { CacheRefreshLeaseLostError } = await import("../modules/work/worker/refresh-lease");
      const scopeDate = "2030-02-01";
      const window = { from: scopeDate, to: scopeDate };
      const shutdown = new AbortController();
      shutdown.abort();
      const activeSignal = new AbortController().signal;
      await cacheStore.requestCacheRefresh("schedule", scopeDate, null, 10);

      const firstClaim = (await cacheStore.claimCacheRefreshJobs(1))[0];
      assert.ok(firstClaim);
      assert.equal(firstClaim.attempts, 1);
      await handleCacheRefreshFailure(firstClaim, new Error("cancelled"), shutdown.signal, window);

      const released = await admin.query<{
        lease_owner: string | null;
        attempts: number;
        available: boolean;
        last_error: string | null;
      }>(
        `SELECT lease_owner, attempts, available_at <= now() AS available, last_error
           FROM cache_refresh_queue
          WHERE cache_key = $1`,
        [firstClaim.cacheKey],
      );
      assert.deepEqual(released.rows[0], {
        lease_owner: null,
        attempts: 0,
        available: true,
        last_error: null,
      });

      const secondClaim = (await cacheStore.claimCacheRefreshJobs(1))[0];
      assert.ok(secondClaim);
      assert.equal(secondClaim.cacheKey, firstClaim.cacheKey);
      assert.equal(secondClaim.attempts, 1);
      assert.notEqual(secondClaim.claimGeneration, firstClaim.claimGeneration);

      assert.deepEqual(await cacheStore.releaseCacheRefreshJob(firstClaim), {
        released: false,
        reason: "lease_lost",
      });
      const stillLeased = await admin.query<{
        lease_owner: string | null;
        claim_generation: string;
      }>(
        `SELECT lease_owner, claim_generation::text
           FROM cache_refresh_queue
          WHERE cache_key = $1`,
        [secondClaim.cacheKey],
      );
      assert.deepEqual(stillLeased.rows[0], {
        lease_owner: secondClaim.leaseOwner,
        claim_generation: secondClaim.claimGeneration,
      });

      await cacheStore.requestCacheRefresh("schedule", scopeDate, null, 10);
      await handleCacheRefreshFailure(
        secondClaim,
        new CacheRefreshLeaseLostError("renewal_rejected"),
        activeSignal,
        window,
      );
      const superseded = await admin.query<{
        lease_owner: string | null;
        attempts: number;
        available: boolean;
        last_error: string | null;
      }>(
        `SELECT lease_owner, attempts, available_at <= now() AS available, last_error
           FROM cache_refresh_queue
          WHERE cache_key = $1`,
        [secondClaim.cacheKey],
      );
      assert.deepEqual(superseded.rows[0], {
        lease_owner: null,
        attempts: 0,
        available: true,
        last_error: null,
      });

      // A genuine provider failure still records its error and retry backoff.
      const thirdClaim = (await cacheStore.claimCacheRefreshJobs(1))[0];
      assert.ok(thirdClaim);
      await handleCacheRefreshFailure(thirdClaim, new Error("provider unavailable"), activeSignal, window);
      const failed = await admin.query<{
        lease_owner: string | null;
        attempts: number;
        available: boolean;
        last_error: string | null;
      }>(
        `SELECT lease_owner, attempts, available_at <= now() AS available, last_error
           FROM cache_refresh_queue WHERE cache_key = $1`,
        [thirdClaim.cacheKey],
      );
      assert.deepEqual(failed.rows[0], {
        lease_owner: null,
        attempts: 1,
        available: false,
        last_error: "provider unavailable",
      });
    } finally {
      if (databaseModule && globalThis.__dispatchDatabasePool) {
        await databaseModule.database().end();
        globalThis.__dispatchDatabasePool = undefined;
      }
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousLeaseSeconds === undefined) {
        delete process.env.CACHE_REFRESH_LEASE_SECONDS;
      } else {
        process.env.CACHE_REFRESH_LEASE_SECONDS = previousLeaseSeconds;
      }
      await admin.query("SET search_path TO public");
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
