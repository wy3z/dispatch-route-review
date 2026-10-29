import assert from "node:assert/strict";
import test from "node:test";
import { isolatedDatabase } from "./support/database";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

test(
  "calendar month totals count each ServiceCall once across projected owners",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async (t) => {
    const admin = await isolatedDatabase(t);
    await admin.query(
      `INSERT INTO cache_snapshots
         (cache_key, kind, scope_date, payload, source_refreshed_at, expires_at)
       VALUES ($1, 'schedule', $2, $3::jsonb, now(), now() + interval '5 minutes')`,
      [
        "schedule:2030-02-12",
        "2030-02-12",
        JSON.stringify({
          visits: [
            { serviceCallId: 100, isComplete: false },
            { serviceCallId: 100, isComplete: false },
            { serviceCallId: 200, isComplete: true },
            { serviceCallId: 300, isComplete: false },
            { serviceCallId: 400, isComplete: false },
          ],
        }),
      ],
    );

    const cacheStore = await import("../modules/work/server/snapshots");
    const days = await cacheStore.getCachedScheduleMonth("2030-02");

    assert.deepEqual(
      days.map(({ date, calls, complete, scheduled }) => ({
        date,
        calls,
        complete,
        scheduled,
      })),
      [
        {
          date: "2030-02-12",
          calls: 4,
          complete: 1,
          scheduled: 3,
        },
      ],
    );

  },
);
