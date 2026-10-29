import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const migrationsDirectory = join(process.cwd(), "db/migrations");

test(
  "repeated cache polling cannot rejuvenate a stalled missing-cache warmup",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(databaseUrl);
    const admin = new Client({ connectionString: databaseUrl });
    const schema = `cache_polling_${process.pid}_${Date.now()}`;
    const previousDatabaseUrl = process.env.DATABASE_URL;
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

      const cacheStore = await import("../modules/work/server/snapshots");
      const cacheObservability = await import("../modules/work/server/observability");
      databaseModule = await import("../platform/database");
      const scopeDate = "2030-01-01";

      await cacheStore.requestCacheRefresh("schedule", scopeDate);
      await cacheStore.requestCacheRefresh("planning_demand", scopeDate);
      await admin.query(
        `UPDATE cache_refresh_queue
            SET requested_at = now() - interval '16 minutes',
                available_at = now() - interval '16 minutes'
          WHERE scope_date = $1::date`,
        [scopeDate],
      );
      const before = await admin.query<{
        cache_key: string;
        requested_at: Date;
        request_generation: string;
      }>(
        `SELECT cache_key, requested_at, request_generation::text
           FROM cache_refresh_queue
          ORDER BY cache_key`,
      );

      for (let index = 0; index < 3; index += 1) {
        await cacheStore.requestCacheRefresh("schedule", scopeDate);
        await cacheStore.requestCacheRefresh("planning_demand", scopeDate);
      }
      const after = await admin.query<{
        cache_key: string;
        requested_at: Date;
        request_generation: string;
      }>(
        `SELECT cache_key, requested_at, request_generation::text
           FROM cache_refresh_queue
          ORDER BY cache_key`,
      );
      assert.deepEqual(
        after.rows.map((row) => ({
          cacheKey: row.cache_key,
          requestedAt: row.requested_at.toISOString(),
          requestGeneration: row.request_generation,
        })),
        before.rows.map((row) => ({
          cacheKey: row.cache_key,
          requestedAt: row.requested_at.toISOString(),
          requestGeneration: row.request_generation,
        })),
      );

      const health = await cacheObservability.readCacheSystemHealth(
        new Date("2030-01-01T12:00:00.000Z"),
      );
      assert.equal(health.status, "not_ready");
      assert.equal(health.ready, false);
      assert.equal(health.worker.status, "stalled");
      assert.ok(
        health.issues.some((issue) => issue.code === "refresh_queue_delayed"),
      );
    } finally {
      if (databaseModule && globalThis.__dispatchDatabasePool) {
        await databaseModule.database().end();
        globalThis.__dispatchDatabasePool = undefined;
      }
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
      await admin.query("SET search_path TO public");
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
