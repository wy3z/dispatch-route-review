import { createHash } from "node:crypto";
import { query } from "../../../platform/database";

export const GEOCODE_RESULT_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
export const GEOCODE_MISS_CACHE_MS = 60 * 60 * 1000;

export type GeoPoint = { latitude: number; longitude: number };
export type GeocodeProvider = "uk_postcode" | "eu_address";
export type GeocodeCacheWrite = {
  cacheKey: string;
  provider: GeocodeProvider;
  providerHost: string;
  point: GeoPoint | null;
  expiresAt: Date;
};

export type GeocodeCacheStore = {
  read(cacheKeys: string[]): Promise<Map<string, GeoPoint | null>>;
  write(entries: GeocodeCacheWrite[]): Promise<void>;
};

type GeocodeCacheRow = {
  cache_key: string;
  outcome: "resolved" | "not_found";
  latitude: number | string | null;
  longitude: number | string | null;
};

export function geocodeCacheKey(
  provider: GeocodeProvider,
  endpoint: string,
  normalisedLocation: string,
) {
  const url = new URL(endpoint);
  return createHash("sha256")
    .update(provider)
    .update("\0")
    .update(`${url.origin}${url.pathname}`)
    .update("\0")
    .update(normalisedLocation)
    .digest("hex");
}

export const postgresGeocodeCacheStore: GeocodeCacheStore = {
  async read(cacheKeys) {
    const unique = [...new Set(cacheKeys)].filter(Boolean);
    if (!unique.length) return new Map();
    const result = await query<GeocodeCacheRow>(
      `SELECT cache_key, outcome, latitude, longitude
         FROM geocode_cache
        WHERE cache_key = ANY($1::text[])
          AND expires_at > now()`,
      [unique],
    );
    return new Map(
      result.rows.map((row) => {
        if (row.outcome === "not_found") {
          return [row.cache_key, null] as const;
        }
        const latitude = Number(row.latitude);
        const longitude = Number(row.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          throw new Error("The geocode cache contains invalid coordinates.");
        }
        return [row.cache_key, { latitude, longitude }] as const;
      }),
    );
  },

  async write(entries) {
    if (!entries.length) return;
    const payload = entries.map((entry) => ({
      cache_key: entry.cacheKey,
      provider: entry.provider,
      provider_host: entry.providerHost,
      outcome: entry.point ? "resolved" : "not_found",
      latitude: entry.point?.latitude ?? null,
      longitude: entry.point?.longitude ?? null,
      expires_at: entry.expiresAt.toISOString(),
    }));
    await query(
      `INSERT INTO geocode_cache
         (cache_key, provider, provider_host, outcome, latitude, longitude,
          refreshed_at, expires_at)
       SELECT candidate.cache_key,
              candidate.provider,
              candidate.provider_host,
              candidate.outcome,
              candidate.latitude,
              candidate.longitude,
              now(),
              candidate.expires_at
         FROM jsonb_to_recordset($1::jsonb) AS candidate(
           cache_key text,
           provider text,
           provider_host text,
           outcome text,
           latitude double precision,
           longitude double precision,
           expires_at timestamptz
         )
       ON CONFLICT (cache_key) DO UPDATE SET
         provider = EXCLUDED.provider,
         provider_host = EXCLUDED.provider_host,
         outcome = EXCLUDED.outcome,
         latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude,
         refreshed_at = now(),
         expires_at = EXCLUDED.expires_at`,
      [JSON.stringify(payload)],
    );
  },
};
