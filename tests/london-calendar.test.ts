import assert from "node:assert/strict";
import test from "node:test";
import {
  addIsoCalendarDays,
  isIsoCalendarDate,
  londonCalendarDate,
  londonLocalMidnightUtc,
} from "../shared/calendar";

test("London calendar dates stay correct across UTC and DST boundaries", () => {
  assert.equal(
    londonCalendarDate(new Date("2026-07-01T23:30:00.000Z")),
    "2026-07-02",
  );
  const midnight = (date: string) =>
    new Date(londonLocalMidnightUtc(date)).toISOString();
  assert.equal(midnight("2026-01-15"), "2026-01-15T00:00:00.000Z");
  assert.equal(midnight("2026-03-29"), "2026-03-29T00:00:00.000Z");
  assert.equal(midnight("2026-03-30"), "2026-03-29T23:00:00.000Z");
  assert.equal(midnight("2026-10-25"), "2026-10-24T23:00:00.000Z");
  assert.equal(midnight("2026-10-26"), "2026-10-26T00:00:00.000Z");
});

test("ISO calendar validation and day arithmetic reject rollover impostors", () => {
  assert.equal(isIsoCalendarDate("2026-02-28"), true);
  assert.equal(isIsoCalendarDate("2026-02-29"), false);
  assert.equal(isIsoCalendarDate("2026-2-28"), false);
  assert.equal(addIsoCalendarDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addIsoCalendarDays("2026-03-01", -1), "2026-02-28");
});
