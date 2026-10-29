import { chunks } from "../../../shared/collections";
import { locationPostcode, postcodeKey } from "./autotask-location";
import { assertCacheWorker } from "./api-activity";
import { mapById, numberValue, stringValue } from "./autotask-records";
import type { AutotaskRecord } from "./autotask-records";
import { outboundRequestSignal, abortableWait } from "./request-lifecycle";
import {
  GEOCODE_MISS_CACHE_MS,
  GEOCODE_RESULT_CACHE_MS,
  geocodeCacheKey,
  postgresGeocodeCacheStore,
} from "./geocode-cache";
import type { GeocodeCacheStore, GeocodeProvider, GeoPoint } from "./geocode-cache";
import { geocoderConfiguration } from "./geocoder-config";
import type { GeocoderConfiguration } from "./geocoder-config";

const EU_GEOCODER_REQUEST_INTERVAL_MS = 1_050;

const EUROPEAN_COUNTRY_CODES = new Set([
  "AD", "AL", "AT", "BA", "BE", "BG", "BY", "CH", "CY", "CZ", "DE",
  "DK", "EE", "ES", "FI", "FR", "GB", "GR", "HR", "HU", "IE", "IS",
  "IT", "LI", "LT", "LU", "LV", "MC", "MD", "ME", "MK", "MT", "NL",
  "NO", "PL", "PT", "RO", "RS", "SE", "SI", "SK", "SM", "UA", "VA",
]);

let lastEuropeanGeocoderRequestAt = 0;
function isUkPostcode(value: string) {
  return /^(?:GIR ?0AA|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})$/i.test(
    value.trim(),
  );
}

function coordinate(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return Number.NaN;
}

function geoPoint(latitudeValue: unknown, longitudeValue: unknown) {
  const latitude = coordinate(latitudeValue);
  const longitude = coordinate(longitudeValue);
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return { latitude, longitude };
}

function countryCode(country: AutotaskRecord | undefined) {
  return stringValue(country?.countryCode).toUpperCase();
}

function countryName(country: AutotaskRecord | undefined) {
  return stringValue(country?.displayName) || stringValue(country?.name);
}

function compactEuropeanPostcode(value: unknown) {
  const postcode = stringValue(value);
  return (
    postcode.match(/\b\d{4,5}\b/)?.[0] ||
    postcode.match(/\b[A-Z]{1,2}[- ]?\d{3,5}\b/i)?.[0] ||
    postcode
  );
}

function europeanGeocodeQueries(
  location: AutotaskRecord,
  country: AutotaskRecord,
) {
  const address = stringValue(location.address1);
  const addressWithoutRoadPrefix = address.replace(
    /^(?:aut(?:oroute)?\s*[a-z]?\d+\s+)/i,
    "",
  );
  const addressAfterComma = address.includes(",")
    ? address.split(",").slice(1).join(",").trim()
    : "";
  const addresses = [
    address,
    addressWithoutRoadPrefix,
    addressAfterComma,
  ].filter(Boolean);
  const postcode = compactEuropeanPostcode(location.postalCode);
  const city = stringValue(location.city);
  const nation = countryName(country);
  const queries = addresses.map((candidate) =>
    [candidate, postcode, city, nation].filter(Boolean).join(", "),
  );
  queries.push(
    [postcode, city, nation].filter(Boolean).join(", "),
    [city, nation].filter(Boolean).join(", "),
  );
  return [...new Set(queries.filter(Boolean))];
}

function locationCacheInput(
  location: AutotaskRecord,
  country: AutotaskRecord | undefined,
) {
  return [
    countryCode(country),
    location.address1,
    location.address2,
    location.postalCode,
    location.city,
    location.state,
  ]
    .map(stringValue)
    .join("|")
    .toLocaleLowerCase("en-GB");
}

let europeanGeocoderQueue: Promise<void> = Promise.resolve();

async function waitForEuropeanGeocoderSlot(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const run = async () => {
    signal?.throwIfAborted();
    const waitMs =
      lastEuropeanGeocoderRequestAt +
      EU_GEOCODER_REQUEST_INTERVAL_MS -
      Date.now();
    await abortableWait(waitMs, signal);
    signal?.throwIfAborted();
    lastEuropeanGeocoderRequestAt = Date.now();
  };
  const scheduled = europeanGeocoderQueue.then(run, run);
  europeanGeocoderQueue = scheduled.then(
    () => undefined,
    () => undefined,
  );
  await scheduled;
}

type GeocoderRuntime = {
  configuration: GeocoderConfiguration;
  cacheStore: GeocodeCacheStore;
  cachedResults: Map<string, GeoPoint | null>;
  fetchImpl: typeof fetch;
  waitForEuropeanSlot: (signal?: AbortSignal) => Promise<void>;
  now: () => number;
  signal?: AbortSignal;
};

async function persistGeocodeResult(
  runtime: GeocoderRuntime,
  cacheKey: string,
  provider: GeocodeProvider,
  providerHost: string,
  point: GeoPoint | null,
) {
  runtime.signal?.throwIfAborted();
  const refreshedAt = runtime.now();
  await runtime.cacheStore.write([
    {
      cacheKey,
      provider,
      providerHost,
      point,
      expiresAt: new Date(
        refreshedAt +
          (point ? GEOCODE_RESULT_CACHE_MS : GEOCODE_MISS_CACHE_MS),
      ),
    },
  ]);
  runtime.signal?.throwIfAborted();
  runtime.cachedResults.set(cacheKey, point);
}

async function geocodeEuropeanLocation(
  location: AutotaskRecord,
  country: AutotaskRecord,
  cacheKey: string,
  runtime: GeocoderRuntime,
) {
  runtime.signal?.throwIfAborted();
  if (runtime.cachedResults.has(cacheKey)) {
    return runtime.cachedResults.get(cacheKey) ?? null;
  }

  const code = countryCode(country);
  const queries = europeanGeocodeQueries(location, country);
  let notFoundResponses = 0;
  for (const query of queries) {
    runtime.signal?.throwIfAborted();
    let point: GeoPoint | null = null;
    try {
      await runtime.waitForEuropeanSlot(runtime.signal);
      const url = new URL(runtime.configuration.euUrl);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "1");
      url.searchParams.set("countrycodes", code.toLowerCase());
      url.searchParams.set("q", query);
      const response = await runtime.fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "Accept-Language": "en-GB,en;q=0.8",
          "User-Agent": runtime.configuration.userAgent,
        },
        cache: "no-store",
        redirect: "error",
        signal: outboundRequestSignal(runtime.signal),
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as unknown;
      if (!Array.isArray(payload)) continue;
      if (payload.length === 0) {
        notFoundResponses += 1;
        continue;
      }
      const first = payload[0] as { lat?: unknown; lon?: unknown } | undefined;
      point = geoPoint(first?.lat, first?.lon);
    } catch {
      runtime.signal?.throwIfAborted();
      // Try the next, less-specific address form without logging its query.
      continue;
    }
    if (!point) continue;
    await persistGeocodeResult(
      runtime,
      cacheKey,
      "eu_address",
      runtime.configuration.euHost,
      point,
    );
    return point;
  }

  if (queries.length > 0 && notFoundResponses === queries.length) {
    await persistGeocodeResult(
      runtime,
      cacheKey,
      "eu_address",
      runtime.configuration.euHost,
      null,
    );
  }
  return null;
}

type GeocodeCompanyLocationOptions = {
  cacheStore?: GeocodeCacheStore;
  fetchImpl?: typeof fetch;
  waitForEuropeanSlot?: (signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
};

function geocodeCompanyLocationOptions(
  optionsOrSignal: GeocodeCompanyLocationOptions | AbortSignal,
): GeocodeCompanyLocationOptions {
  return optionsOrSignal instanceof AbortSignal
    ? { signal: optionsOrSignal }
    : optionsOrSignal;
}

/**
 * Approved Postcodes.io-compatible UK endpoint, then approved
 * Nominatim-compatible EU endpoint.
 */
export async function geocodeCompanyLocations(
  companyLocations: AutotaskRecord[],
  countries: AutotaskRecord[],
  optionsOrSignal: GeocodeCompanyLocationOptions | AbortSignal = {},
) {
  assertCacheWorker();
  const options = geocodeCompanyLocationOptions(optionsOrSignal);
  const signal = options.signal;
  signal?.throwIfAborted();
  const configuration = geocoderConfiguration();
  const cacheStore = options.cacheStore ?? postgresGeocodeCacheStore;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const points = new Map<number, GeoPoint>();
  const countriesById = mapById(countries);
  const ukLocationsByPostcode = new Map<string, AutotaskRecord[]>();
  const ukCacheKeys = new Map<string, string>();
  const europeanDetails = new Map<
    number,
    { country: AutotaskRecord; cacheKey: string }
  >();

  companyLocations.forEach((location) => {
    signal?.throwIfAborted();
    const postcode = locationPostcode(location);
    if (isUkPostcode(postcode)) {
      const key = postcodeKey(postcode);
      ukLocationsByPostcode.set(key, [
        ...(ukLocationsByPostcode.get(key) ?? []),
        location,
      ]);
      if (!ukCacheKeys.has(key)) {
        ukCacheKeys.set(
          key,
          geocodeCacheKey("uk_postcode", configuration.ukUrl, key),
        );
      }
      return;
    }

    const country = countriesById.get(numberValue(location.countryID));
    const code = countryCode(country);
    if (!country || !EUROPEAN_COUNTRY_CODES.has(code) || code === "GB") return;
    europeanDetails.set(numberValue(location.id), {
      country,
      cacheKey: geocodeCacheKey(
        "eu_address",
        configuration.euUrl,
        locationCacheInput(location, country),
      ),
    });
  });

  signal?.throwIfAborted();
  const cachedResults = await cacheStore.read([
    ...ukCacheKeys.values(),
    ...[...europeanDetails.values()].map((detail) => detail.cacheKey),
  ]);
  signal?.throwIfAborted();
  const runtime: GeocoderRuntime = {
    configuration,
    cacheStore,
    cachedResults,
    fetchImpl,
    waitForEuropeanSlot:
      options.waitForEuropeanSlot ?? waitForEuropeanGeocoderSlot,
    now,
    signal,
  };
  const ukMisses: string[] = [];

  ukLocationsByPostcode.forEach((locations, key) => {
    signal?.throwIfAborted();
    const cacheKey = ukCacheKeys.get(key);
    if (!cacheKey) return;
    if (cachedResults.has(cacheKey)) {
      const point = cachedResults.get(cacheKey);
      if (point) {
        locations.forEach((location) =>
          points.set(numberValue(location.id), point),
        );
      }
      return;
    }
    ukMisses.push(key);
  });

  for (const batch of chunks(ukMisses, 100)) {
    signal?.throwIfAborted();
    let payload: {
      result?: Array<{
        query: string;
        result: { latitude: number; longitude: number } | null;
      }>;
    };
    try {
      const response = await fetchImpl(configuration.ukUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postcodes: batch }),
        cache: "no-store",
        redirect: "error",
        signal: outboundRequestSignal(signal),
      });
      if (!response.ok) continue;
      payload = (await response.json()) as typeof payload;
    } catch {
      signal?.throwIfAborted();
      // Missing coordinates are reported to the UI instead of failing the sync.
      continue;
    }
    if (!Array.isArray(payload.result)) continue;
    const providerResults = new Map<string, GeoPoint | null>();
    payload.result.forEach((entry) => {
      if (!entry || typeof entry.query !== "string") return;
      const key = postcodeKey(entry.query);
      if (entry.result === null) {
        providerResults.set(key, null);
        return;
      }
      const point = geoPoint(
        entry.result?.latitude,
        entry.result?.longitude,
      );
      if (point) providerResults.set(key, point);
    });
    const refreshedAt = now();
    const writes = batch.flatMap((key) => {
      const cacheKey = ukCacheKeys.get(key);
      if (!cacheKey || !providerResults.has(key)) return [];
      const point = providerResults.get(key) ?? null;
      if (point) {
        (ukLocationsByPostcode.get(key) ?? []).forEach((location) =>
          points.set(numberValue(location.id), point),
        );
      }
      cachedResults.set(cacheKey, point);
      return [
        {
          cacheKey,
          provider: "uk_postcode" as const,
          providerHost: configuration.ukHost,
          point,
          expiresAt: new Date(
            refreshedAt +
              (point ? GEOCODE_RESULT_CACHE_MS : GEOCODE_MISS_CACHE_MS),
          ),
        },
      ];
    });
    signal?.throwIfAborted();
    await cacheStore.write(writes);
  }

  for (const location of companyLocations) {
    signal?.throwIfAborted();
    const locationId = numberValue(location.id);
    if (points.has(locationId)) continue;
    const detail = europeanDetails.get(locationId);
    if (!detail) continue;
    const point = await geocodeEuropeanLocation(
      location,
      detail.country,
      detail.cacheKey,
      runtime,
    );
    if (point) points.set(locationId, point);
  }
  return points;
}
