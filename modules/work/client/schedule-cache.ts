import { cacheMaximumAgeSeconds } from "../freshness";
import type { ScheduleSnapshot } from "../contracts";

const CACHE_PREFIX = "dispatch-route-review.schedule.";
const CACHE_MAX_AGE_MS = 2 * 60 * 1000;

type CacheEntry = {
  storedAt: number;
  hardExpiresAt: number;
  snapshot: ScheduleSnapshot;
};

export function scheduleSnapshotHardExpiryMilliseconds(
  snapshot: ScheduleSnapshot,
  now = new Date(),
) {
  const generatedAt = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(generatedAt)) return null;
  return (
    generatedAt +
    cacheMaximumAgeSeconds("schedule", snapshot.date, now) * 1_000
  );
}

export function readScheduleSnapshot(date: string) {
  try {
    const raw = window.sessionStorage.getItem(`${CACHE_PREFIX}${date}`);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    const now = Date.now();
    const effectiveHardExpiry = entry?.snapshot
      ? scheduleSnapshotHardExpiryMilliseconds(entry.snapshot, new Date(now))
      : null;
    if (
      !entry?.snapshot ||
      entry.snapshot.date !== date ||
      !Number.isFinite(entry.hardExpiresAt) ||
      effectiveHardExpiry === null ||
      now >= Math.min(entry.hardExpiresAt, effectiveHardExpiry) ||
      now - entry.storedAt > CACHE_MAX_AGE_MS
    ) {
      window.sessionStorage.removeItem(`${CACHE_PREFIX}${date}`);
      return null;
    }
    return entry.snapshot;
  } catch {
    return null;
  }
}

export function writeScheduleSnapshot(snapshot: ScheduleSnapshot) {
  try {
    const hardExpiresAt = scheduleSnapshotHardExpiryMilliseconds(snapshot);
    if (hardExpiresAt === null || Date.now() >= hardExpiresAt) {
      removeScheduleSnapshot(snapshot.date);
      return;
    }
    window.sessionStorage.setItem(
      `${CACHE_PREFIX}${snapshot.date}`,
      JSON.stringify({
        storedAt: Date.now(),
        hardExpiresAt,
        snapshot,
      } satisfies CacheEntry),
    );
  } catch {
    // The live response remains usable when browser storage is unavailable.
  }
}

export function removeScheduleSnapshot(date: string) {
  try {
    window.sessionStorage.removeItem(`${CACHE_PREFIX}${date}`);
  } catch {
    // The in-memory snapshot is still removed when browser storage is unavailable.
  }
}
