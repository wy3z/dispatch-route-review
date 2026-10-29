import assert from "node:assert/strict";
import test from "node:test";
import { WorkerCache, workerCacheMetrics } from "../modules/work/worker/memory-cache";

test("expired entries are swept without reading the same key again", () => {
  let now = 1_000;
  const cache = new WorkerCache<string, string>({
    name: "expiry-test",
    ttlMs: 100,
    maxEntries: 10,
    maxEstimatedBytes: 1_000,
    now: () => now,
    sweepIntervalMs: false,
    register: false,
  });
  cache.set("never-read-again", "value");

  now += 101;
  assert.equal(cache.sweepExpired(), 1);
  assert.equal(cache.size, 0);
  assert.deepEqual(cache.metrics(), {
    name: "expiry-test",
    ttlMs: 100,
    sweepIntervalMs: null,
    maxEntries: 10,
    maxEstimatedBytes: 1_000,
    size: 0,
    estimatedBytes: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
    expirations: 1,
  });
});

test("least-recently-used entries are evicted first", () => {
  const cache = new WorkerCache<string, number>({
    name: "lru-test",
    ttlMs: 1_000,
    maxEntries: 2,
    maxEstimatedBytes: 1_000,
    sweepIntervalMs: false,
    register: false,
  });
  cache.set("first", 1);
  cache.set("second", 2);
  assert.equal(cache.get("first"), 1);
  cache.set("third", 3);

  assert.equal(cache.get("second"), undefined);
  assert.equal(cache.get("first"), 1);
  assert.equal(cache.get("third"), 3);
  assert.equal(cache.metrics().evictions, 1);
  assert.equal(cache.size, 2);
});

test("null values remain distinguishable from cache misses", () => {
  let now = 5_000;
  const cache = new WorkerCache<string, { value: number } | null>({
    name: "null-test",
    ttlMs: 60,
    maxEntries: 2,
    maxEstimatedBytes: 1_000,
    now: () => now,
    sweepIntervalMs: false,
    register: false,
  });
  cache.set("known-null", null);

  assert.equal(cache.get("known-null"), null);
  now += 61;
  assert.equal(cache.get("known-null"), undefined);
  assert.equal(cache.metrics().hits, 1);
  assert.equal(cache.metrics().misses, 1);
  assert.equal(cache.metrics().expirations, 1);
});

test("high-cardinality input stays inside entry and byte limits", () => {
  const cache = new WorkerCache<string, number>({
    name: "cardinality-test",
    ttlMs: 60_000,
    maxEntries: 100,
    maxEstimatedBytes: 1_000,
    estimateBytes: () => 10,
    sweepIntervalMs: false,
    register: false,
  });
  for (let index = 0; index < 10_000; index += 1) {
    cache.set(`key-${index}`, index);
  }

  const metrics = cache.metrics();
  assert.equal(metrics.size, 100);
  assert.equal(metrics.estimatedBytes, 1_000);
  assert.equal(metrics.evictions, 9_900);
  assert.ok(metrics.size <= metrics.maxEntries);
  assert.ok(metrics.estimatedBytes <= metrics.maxEstimatedBytes);
});

test("an oversized value is not retained", () => {
  const cache = new WorkerCache<string, string>({
    name: "oversized-test",
    ttlMs: 1_000,
    maxEntries: 10,
    maxEstimatedBytes: 50,
    estimateBytes: (_key, value) => value.length,
    sweepIntervalMs: false,
    register: false,
  });

  assert.equal(cache.set("too-large", "x".repeat(51)), false);
  assert.equal(cache.size, 0);
  assert.equal(cache.metrics().estimatedBytes, 0);
  assert.equal(cache.metrics().evictions, 1);
});

test("the periodic sweep removes an expired untouched entry", async () => {
  const cache = new WorkerCache<string, string>({
    name: "periodic-test",
    ttlMs: 10,
    maxEntries: 2,
    maxEstimatedBytes: 1_000,
    sweepIntervalMs: 10,
    register: false,
  });
  cache.set("untouched", "value");

  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cache.size, 0);
    assert.equal(cache.metrics().expirations, 1);
  } finally {
    cache.dispose();
  }
});

test("registered cache metrics expose hit, miss, eviction, and size counters", () => {
  const cache = new WorkerCache<string, number>({
    name: "observable-test",
    ttlMs: 1_000,
    maxEntries: 1,
    maxEstimatedBytes: 1_000,
    sweepIntervalMs: false,
  });
  try {
    cache.set("first", 1);
    assert.equal(cache.get("first"), 1);
    assert.equal(cache.get("missing"), undefined);
    cache.set("second", 2);

    const metrics = workerCacheMetrics().find(
      (candidate) => candidate.name === "observable-test",
    );
    assert.ok(metrics);
    assert.equal(metrics.ttlMs, 1_000);
    assert.equal(metrics.sweepIntervalMs, null);
    assert.equal(metrics.maxEntries, 1);
    assert.equal(metrics.maxEstimatedBytes, 1_000);
    assert.equal(metrics.size, 1);
    assert.ok(metrics.estimatedBytes > 0);
    assert.equal(metrics.hits, 1);
    assert.equal(metrics.misses, 1);
    assert.equal(metrics.evictions, 1);
    assert.equal(metrics.expirations, 0);
  } finally {
    cache.dispose();
  }
});
