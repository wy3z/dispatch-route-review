import assert from "node:assert/strict";
import test from "node:test";
import {
  CACHE_REFRESH_INTERVAL_SECONDS,
  CACHE_WARM_WINDOW_DAYS,
  cacheRefreshIntervalSeconds,
} from "../modules/work/server/snapshots";
import { cacheSnapshotEtag, cacheSnapshotNotModified } from "../modules/work/server/cache-http";

test("cache policy uses the approved exact refresh intervals", () => {
  const now = new Date("2026-08-07T10:00:00.000Z");
  assert.deepEqual(CACHE_REFRESH_INTERVAL_SECONDS, {
    today: 300,
    planningDemand: 300,
    future: 3_600,
    historical: 86_400,
  });
  assert.deepEqual(CACHE_WARM_WINDOW_DAYS, { past: 30, future: 30 });
  assert.equal(cacheRefreshIntervalSeconds("schedule", "2026-08-07", now), 300);
  assert.equal(
    cacheRefreshIntervalSeconds("schedule", "2026-08-08", now),
    3_600,
  );
  assert.equal(
    cacheRefreshIntervalSeconds("schedule", "2026-08-06", now),
    86_400,
  );
  assert.equal(
    cacheRefreshIntervalSeconds("planning_demand", "2026-08-06", now),
    300,
  );
});

test("cache policy classifies today in Europe/London across UTC rollover", () => {
  const londonAfterMidnight = new Date("2026-08-06T23:30:00.000Z");
  assert.equal(
    cacheRefreshIntervalSeconds(
      "schedule",
      "2026-08-07",
      londonAfterMidnight,
    ),
    300,
  );
  assert.equal(
    cacheRefreshIntervalSeconds(
      "schedule",
      "2026-08-06",
      londonAfterMidnight,
    ),
    86_400,
  );
});

test("cache snapshot validators support conditional polling", () => {
  const etag = cacheSnapshotEtag(
    "schedule",
    "2026-08-07",
    "2026-08-07T10:00:00.000Z",
  );
  assert.equal(
    etag,
    '"schedule:2026-08-07:2026-08-07T10:00:00.000Z"',
  );
  assert.equal(
    cacheSnapshotNotModified(
      new Request("https://dispatch.test/api/autotask-schedule", {
        headers: { "If-None-Match": `"older", ${etag}` },
      }),
      etag,
    ),
    true,
  );
  assert.equal(
    cacheSnapshotNotModified(
      new Request("https://dispatch.test/api/autotask-schedule", {
        headers: { "If-None-Match": '"older"' },
      }),
      etag,
    ),
    false,
  );
});
