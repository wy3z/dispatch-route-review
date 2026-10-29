import assert from "node:assert/strict";
import test from "node:test";
import { locationPostcode } from "../modules/work/worker/autotask-location";

test("Autotask locations normalise UK postcodes found in any address field", () => {
  assert.equal(
    locationPostcode({
      postalCode: "",
      address1: "Unit 1, Example Road",
      city: "Manchester M11AE",
    }),
    "M1 1AE",
  );
  assert.equal(locationPostcode({ postalCode: "m11ae" }), "M1 1AE");
  assert.equal(
    locationPostcode({ postalCode: "Dublin 2", city: "Dublin" }),
    "Dublin 2",
  );
});
