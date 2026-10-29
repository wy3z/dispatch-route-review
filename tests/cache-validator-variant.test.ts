import assert from "node:assert/strict";
import test from "node:test";
import { describeCacheFreshness, IDLE_CACHE_REFRESH } from "../modules/work/freshness";
import { cacheSnapshotResponse } from "../modules/work/server/cache-http";

const now = new Date("2026-08-20T12:00:00.000Z");
const freshness = describeCacheFreshness(
  "planning_demand",
  "2026-08-20",
  {
    sourceRefreshedAt: "2026-08-20T11:58:00.000Z",
    refreshedAt: "2026-08-20T11:58:00.000Z",
    expiresAt: "2026-08-20T12:03:00.000Z",
    stale: false,
    lastError: null,
    consecutiveFailures: 0,
  },
  IDLE_CACHE_REFRESH,
  now,
);

test("projected cache validators vary with the response projection", () => {
  const monday = cacheSnapshotResponse({
    request: new Request("https://dispatch.test/api/ready-to-book?date=2026-08-24"),
    freshness,
    payload: { planningDate: "2026-08-24" },
    label: "ready-to-book",
    validatorVariant: "2026-08-24",
  });
  const mondayEtag = monday.headers.get("ETag");
  assert.ok(mondayEtag);

  const tuesday = cacheSnapshotResponse({
    request: new Request("https://dispatch.test/api/ready-to-book?date=2026-08-25", {
      headers: { "If-None-Match": mondayEtag },
    }),
    freshness,
    payload: { planningDate: "2026-08-25" },
    label: "ready-to-book",
    validatorVariant: "2026-08-25",
  });
  assert.equal(tuesday.status, 200);
  assert.notEqual(tuesday.headers.get("ETag"), mondayEtag);

  const mondayAgain = cacheSnapshotResponse({
    request: new Request("https://dispatch.test/api/ready-to-book?date=2026-08-24", {
      headers: { "If-None-Match": mondayEtag },
    }),
    freshness,
    payload: { planningDate: "2026-08-24" },
    label: "ready-to-book",
    validatorVariant: "2026-08-24",
  });
  assert.equal(mondayAgain.status, 304);
});
