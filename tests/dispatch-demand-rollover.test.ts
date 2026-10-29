import assert from "node:assert/strict";
import test from "node:test";
import {
  isDispatchReviewDemandDateEligible,
  nextDispatchReviewDemandEligibilityCheckAt,
} from "../modules/dispatch/state/use-dispatch-review-data";

test("dispatch demand eligibility rechecks at the London day rollover", () => {
  const beforeRollover = new Date("2026-08-20T22:59:59.000Z");
  const rolloverAt = nextDispatchReviewDemandEligibilityCheckAt(beforeRollover);

  assert.equal(
    new Date(rolloverAt).toISOString(),
    "2026-08-20T23:00:00.000Z",
    "summer London midnight is 23:00 UTC",
  );
  assert.equal(
    isDispatchReviewDemandDateEligible("2026-08-20", beforeRollover),
    true,
  );
  assert.equal(
    isDispatchReviewDemandDateEligible("2026-08-20", new Date(rolloverAt)),
    false,
  );
});
