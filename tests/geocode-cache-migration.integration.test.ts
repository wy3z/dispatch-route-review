import assert from "node:assert/strict";
import test from "node:test";
import { isolatedDatabase } from "./support/database";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

function isCheckViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23514"
  );
}

test(
  "geocode-cache migration stores only hashed location keys and valid outcomes",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async (t) => {
    const client = await isolatedDatabase(t, { migrations: ["014_geocode_cache.sql"] });
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'geocode_cache'
        ORDER BY ordinal_position`,
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      [
        "cache_key",
        "provider",
        "provider_host",
        "outcome",
        "latitude",
        "longitude",
        "refreshed_at",
        "expires_at",
      ],
    );

    await client.query(
      `INSERT INTO geocode_cache
         (cache_key, provider, provider_host, outcome, latitude, longitude,
          expires_at)
       VALUES
         ($1, 'uk_postcode', 'geo.approved.test', 'resolved', 53.48, -2.24,
          now() + interval '30 days'),
         ($2, 'eu_address', 'geo.approved.test', 'not_found', NULL, NULL,
          now() + interval '1 hour')`,
      ["a".repeat(64), "b".repeat(64)],
    );
    const stored = await client.query<{
      outcome: string;
      latitude: number | null;
      longitude: number | null;
    }>(
      `SELECT outcome, latitude, longitude
         FROM geocode_cache
        ORDER BY cache_key`,
    );
    assert.deepEqual(stored.rows, [
      { outcome: "resolved", latitude: 53.48, longitude: -2.24 },
      { outcome: "not_found", latitude: null, longitude: null },
    ]);

    await assert.rejects(
      client.query(
        `INSERT INTO geocode_cache
           (cache_key, provider, provider_host, outcome, latitude, longitude,
            expires_at)
         VALUES ('M1 1AE', 'uk_postcode', 'geo.approved.test', 'not_found',
                 NULL, NULL, now() + interval '1 hour')`,
      ),
      isCheckViolation,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO geocode_cache
           (cache_key, provider, provider_host, outcome, latitude, longitude,
            expires_at)
         VALUES ($1, 'eu_address', 'geo.approved.test', 'resolved',
                 NULL, NULL, now() + interval '30 days')`,
        ["c".repeat(64)],
      ),
      isCheckViolation,
    );

  },
);
