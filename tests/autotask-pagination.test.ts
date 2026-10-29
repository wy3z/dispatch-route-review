import assert from "node:assert/strict";
import test from "node:test";
import { safeAutotaskPaginationUrl } from "../modules/work/worker/autotask-server";

test("credential-bearing Autotask pagination stays on the configured API origin", () => {
  const base = "https://autotask.test/ATServicesRest/V1.0";
  assert.equal(
    safeAutotaskPaginationUrl(
      "/ATServicesRest/V1.0/Tickets/query?next=abc",
      base,
    ),
    "https://autotask.test/ATServicesRest/V1.0/Tickets/query?next=abc",
  );
  assert.throws(
    () => safeAutotaskPaginationUrl("https://attacker.example/collect", base),
    /unsafe pagination URL/i,
  );
  assert.throws(
    () =>
      safeAutotaskPaginationUrl(
        "http://autotask.test/ATServicesRest/V1.0/Tickets",
        base,
      ),
    /unsafe pagination URL/i,
  );
});
