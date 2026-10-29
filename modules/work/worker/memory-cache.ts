/**
 * Bounded process-local cache for worker-only source data.
 *
 * Entries use least-recently-used eviction, expire after a documented TTL,
 * and are swept on a timer so stale keys do not need to be read again before
 * their memory can be reclaimed. The byte limit is an estimate of serialised
 * key/value payload size; process RSS remains the authoritative heap signal.
 */

export const WORKER_CACHE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export type WorkerCacheMetrics = {
  name: string;
  ttlMs: number;
  sweepIntervalMs: number | null;
  maxEntries: number;
  maxEstimatedBytes: number;
  size: number;
  estimatedBytes: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
};

type CacheEntry<V> = {
  value: V;
  expiresAt: number;
  estimatedBytes: number;
};

type WorkerCacheOptions<K, V> = {
  name: string;
  ttlMs: number;
  maxEntries: number;
  maxEstimatedBytes: number;
  sweepIntervalMs?: number | false;
  estimateBytes?: (key: K, value: V) => number;
  now?: () => number;
  register?: boolean;
};

type UnrefTimer = ReturnType<typeof setInterval> & {
  unref?: () => void;
};

type WorkerCacheMetricsSource = {
  metrics: () => WorkerCacheMetrics;
};

const registeredCaches = new Set<WorkerCacheMetricsSource>();
const textEncoder = new TextEncoder();

export function estimatedJsonBytes(value: unknown) {
  const serialised = JSON.stringify(value);
  return textEncoder.encode(serialised ?? "").byteLength;
}

function positiveWholeNumber(name: string, value: number) {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive whole number.`);
  }
  return Math.floor(value);
}

export class WorkerCache<K, V> {
  readonly name: string;
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly maxEstimatedBytes: number;
  readonly sweepIntervalMs: number | null;

  private readonly entries = new Map<K, CacheEntry<V>>();
  private readonly estimateBytes: (key: K, value: V) => number;
  private readonly now: () => number;
  private readonly registered: boolean;
  private timer: UnrefTimer | null = null;
  private estimatedBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(options: WorkerCacheOptions<K, V>) {
    this.name = options.name.trim();
    if (!this.name) throw new Error("Worker cache name is required.");
    this.ttlMs = positiveWholeNumber("ttlMs", options.ttlMs);
    this.maxEntries = positiveWholeNumber("maxEntries", options.maxEntries);
    this.maxEstimatedBytes = positiveWholeNumber(
      "maxEstimatedBytes",
      options.maxEstimatedBytes,
    );
    this.estimateBytes =
      options.estimateBytes ??
      ((key, value) => estimatedJsonBytes([key, value]));
    this.now = options.now ?? Date.now;
    this.registered = options.register !== false;

    const requestedSweepInterval =
      options.sweepIntervalMs === undefined
        ? WORKER_CACHE_SWEEP_INTERVAL_MS
        : options.sweepIntervalMs;
    this.sweepIntervalMs =
      requestedSweepInterval === false
        ? null
        : positiveWholeNumber("sweepIntervalMs", requestedSweepInterval);
    if (this.sweepIntervalMs !== null) {
      this.timer = setInterval(
        () => this.sweepExpired(),
        this.sweepIntervalMs,
      ) as UnrefTimer;
      this.timer.unref?.();
    }
    if (this.registered) {
      registeredCaches.add(this);
    }
  }

  get size() {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.removeEntry(key, true);
      this.misses += 1;
      return undefined;
    }

    // Map insertion order is the LRU order. Reinsert a hit at the newest end.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key: K, value: V, ttlMs = this.ttlMs) {
    const entryTtlMs = positiveWholeNumber("ttlMs", ttlMs);
    this.removeEntry(key, false, false);

    let estimatedBytes: number;
    try {
      estimatedBytes = Math.max(
        1,
        Math.ceil(this.estimateBytes(key, value)),
      );
    } catch {
      estimatedBytes = this.maxEstimatedBytes + 1;
    }
    if (
      !Number.isFinite(estimatedBytes) ||
      estimatedBytes > this.maxEstimatedBytes
    ) {
      this.evictions += 1;
      return false;
    }

    this.entries.set(key, {
      value,
      expiresAt: this.now() + entryTtlMs,
      estimatedBytes,
    });
    this.estimatedBytes += estimatedBytes;
    this.enforceBounds();
    return this.entries.has(key);
  }

  sweepExpired(now = this.now()) {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.removeEntry(key, true);
        removed += 1;
      }
    }
    return removed;
  }

  metrics(): WorkerCacheMetrics {
    return {
      name: this.name,
      ttlMs: this.ttlMs,
      sweepIntervalMs: this.sweepIntervalMs,
      maxEntries: this.maxEntries,
      maxEstimatedBytes: this.maxEstimatedBytes,
      size: this.entries.size,
      estimatedBytes: this.estimatedBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
    };
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.registered) {
      registeredCaches.delete(this);
    }
  }

  private enforceBounds() {
    while (
      this.entries.size > this.maxEntries ||
      this.estimatedBytes > this.maxEstimatedBytes
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.removeEntry(oldest.value, false);
    }
  }

  private removeEntry(
    key: K,
    expired: boolean,
    countEviction = true,
  ) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.estimatedBytes = Math.max(
      0,
      this.estimatedBytes - entry.estimatedBytes,
    );
    if (expired) this.expirations += 1;
    else if (countEviction) this.evictions += 1;
    return true;
  }
}

export function workerCacheMetrics() {
  return [...registeredCaches]
    .map((cache) => cache.metrics())
    .sort((first, second) => first.name.localeCompare(second.name));
}
