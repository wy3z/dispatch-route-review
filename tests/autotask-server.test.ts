import assert from "node:assert/strict";
import test from "node:test";
import {
  GEOCODE_MISS_CACHE_MS,
  GEOCODE_RESULT_CACHE_MS,
} from "../modules/work/worker/geocode-cache";
import type {
  GeocodeCacheStore,
  GeocodeCacheWrite,
  GeoPoint,
} from "../modules/work/worker/geocode-cache";
import { autotaskQuery } from "../modules/work/worker/autotask-server";
import { geocodeCompanyLocations } from "../modules/work/worker/geocoding";

function memoryGeocodeCache() {
  const records = new Map<string, GeocodeCacheWrite>();
  const store: GeocodeCacheStore = {
    async read(cacheKeys) {
      const result = new Map<string, GeoPoint | null>();
      cacheKeys.forEach((cacheKey) => {
        const record = records.get(cacheKey);
        if (record) result.set(cacheKey, record.point);
      });
      return result;
    },
    async write(entries) {
      entries.forEach((entry) => records.set(entry.cacheKey, entry));
    },
  };
  return { records, store };
}

function setApprovedProductionGeocoders() {
  const names = [
    "CACHE_WORKER",
    "NODE_ENV",
    "UK_GEOCODER_URL",
    "EU_GEOCODER_URL",
    "GEOCODER_ALLOWED_HOSTS",
    "GEOCODER_USER_AGENT_CONTACT",
  ] as const;
  const original = new Map(names.map((name) => [name, process.env[name]]));
  Reflect.set(process.env, "CACHE_WORKER", "1");
  Reflect.set(process.env, "NODE_ENV", "production");
  Reflect.set(
    process.env,
    "UK_GEOCODER_URL",
    "https://geo.approved.test/postcodes",
  );
  Reflect.set(
    process.env,
    "EU_GEOCODER_URL",
    "https://geo.approved.test/search",
  );
  Reflect.set(process.env, "GEOCODER_ALLOWED_HOSTS", "geo.approved.test");
  Reflect.set(process.env, "GEOCODER_USER_AGENT_CONTACT", "https://dispatch.example.test/contact");
  return () => {
    names.forEach((name) => {
      const value = original.get(name);
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else Reflect.set(process.env, name, value);
    });
  };
}

test("live data transports reject non-worker processes before any network request", async () => {
  const originalWorkerFlag = process.env.CACHE_WORKER;
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  delete process.env.CACHE_WORKER;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("unexpected network request");
  };

  try {
    await assert.rejects(
      autotaskQuery("Tickets", []),
      /restricted to the cache worker/,
    );
    await assert.rejects(
      geocodeCompanyLocations([{ id: 1, postalCode: "M1 1AE" }], []),
      /restricted to the cache worker/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    if (originalWorkerFlag === undefined) delete process.env.CACHE_WORKER;
    else process.env.CACHE_WORKER = originalWorkerFlag;
    globalThis.fetch = originalFetch;
  }
});

test("resolved UK coordinates persist without storing the submitted postcode", async () => {
  const restoreEnvironment = setApprovedProductionGeocoders();
  const cache = memoryGeocodeCache();
  const fixedNow = Date.parse("2026-08-20T12:00:00.000Z");
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    fetchCalls += 1;
    assert.equal(String(input), "https://geo.approved.test/postcodes");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(typeof init?.body, "string");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      postcodes: ["M11AE"],
    });
    return Response.json({
      result: [
        {
          query: "M1 1AE",
          result: { latitude: 53.48, longitude: -2.24 },
        },
      ],
    });
  };

  try {
    const options = {
      cacheStore: cache.store,
      fetchImpl,
      now: () => fixedNow,
    };
    const first = await geocodeCompanyLocations(
      [{ id: 1, postalCode: "M1 1AE" }],
      [],
      options,
    );
    const second = await geocodeCompanyLocations(
      [{ id: 1, postalCode: "M1 1AE" }],
      [],
      options,
    );

    assert.deepEqual(first.get(1), { latitude: 53.48, longitude: -2.24 });
    assert.deepEqual(second.get(1), { latitude: 53.48, longitude: -2.24 });
    assert.equal(fetchCalls, 1);
    assert.equal(cache.records.size, 1);
    const record = [...cache.records.values()][0];
    assert.match(record.cacheKey, /^[0-9a-f]{64}$/);
    assert.equal(record.provider, "uk_postcode");
    assert.equal(record.providerHost, "geo.approved.test");
    assert.equal(
      record.expiresAt.toISOString(),
      new Date(fixedNow + GEOCODE_RESULT_CACHE_MS).toISOString(),
    );
    assert.doesNotMatch(JSON.stringify(record), /M1|1AE/i);
  } finally {
    restoreEnvironment();
  }
});

test("UK not-found results persist with the shorter refresh policy", async () => {
  const restoreEnvironment = setApprovedProductionGeocoders();
  const cache = memoryGeocodeCache();
  const fixedNow = Date.parse("2026-08-20T12:00:00.000Z");
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    return Response.json({
      result: [{ query: "M1 1AA", result: null }],
    });
  };

  try {
    const options = {
      cacheStore: cache.store,
      fetchImpl,
      now: () => fixedNow,
    };
    const first = await geocodeCompanyLocations(
      [{ id: 2, postalCode: "M1 1AA" }],
      [],
      options,
    );
    const second = await geocodeCompanyLocations(
      [{ id: 2, postalCode: "M1 1AA" }],
      [],
      options,
    );

    assert.equal(first.size, 0);
    assert.equal(second.size, 0);
    assert.equal(fetchCalls, 1);
    const record = [...cache.records.values()][0];
    assert.equal(record.point, null);
    assert.equal(
      record.expiresAt.toISOString(),
      new Date(fixedNow + GEOCODE_MISS_CACHE_MS).toISOString(),
    );
  } finally {
    restoreEnvironment();
  }
});

test("EU not-found results do not log or persist full address queries", async () => {
  const restoreEnvironment = setApprovedProductionGeocoders();
  const cache = memoryGeocodeCache();
  const logged: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => logged.push(values.map(String).join(" "));
  console.error = (...values) => logged.push(values.map(String).join(" "));
  let fetchCalls = 0;

  try {
    const points = await geocodeCompanyLocations(
      [
        {
          id: 3,
          countryID: 10,
          address1: "1 Sensitive Customer Road",
          postalCode: "75001",
          city: "Paris",
        },
      ],
      [{ id: 10, countryCode: "FR", displayName: "France" }],
      {
        cacheStore: cache.store,
        fetchImpl: async (_input, init) => {
          fetchCalls += 1;
          assert.equal(init?.redirect, "error");
          assert.equal(new Headers(init?.headers).get("User-Agent"),
            "DispatchRouteReview/0.1 (https://dispatch.example.test/contact)");
          return Response.json([]);
        },
        waitForEuropeanSlot: async () => undefined,
        now: () => Date.parse("2026-08-20T12:00:00.000Z"),
      },
    );

    assert.equal(points.size, 0);
    assert.ok(fetchCalls > 0);
    assert.deepEqual(logged, []);
    assert.equal(cache.records.size, 1);
    const stored = JSON.stringify([...cache.records.values()]);
    assert.doesNotMatch(stored, /Sensitive Customer Road|75001|Paris/i);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    restoreEnvironment();
  }
});

test("malformed UK coordinates are not cached as a location or a miss", async () => {
  const restoreEnvironment = setApprovedProductionGeocoders();
  const cache = memoryGeocodeCache();

  try {
    const points = await geocodeCompanyLocations(
      [{ id: 4, postalCode: "B1 1AA" }],
      [],
      {
        cacheStore: cache.store,
        fetchImpl: async () =>
          Response.json({
            result: [
              {
                query: "B1 1AA",
                result: { latitude: null, longitude: null },
              },
            ],
          }),
      },
    );

    assert.equal(points.size, 0);
    assert.equal(cache.records.size, 0);
  } finally {
    restoreEnvironment();
  }
});

test("transient EU provider failures are not persisted as not-found", async () => {
  const restoreEnvironment = setApprovedProductionGeocoders();
  const cache = memoryGeocodeCache();

  try {
    const points = await geocodeCompanyLocations(
      [
        {
          id: 5,
          countryID: 10,
          address1: "2 Sensitive Customer Road",
          postalCode: "75002",
          city: "Paris",
        },
      ],
      [{ id: 10, countryCode: "FR", displayName: "France" }],
      {
        cacheStore: cache.store,
        fetchImpl: async () => {
          throw new Error("provider unavailable");
        },
        waitForEuropeanSlot: async () => undefined,
      },
    );

    assert.equal(points.size, 0);
    assert.equal(cache.records.size, 0);
  } finally {
    restoreEnvironment();
  }
});
