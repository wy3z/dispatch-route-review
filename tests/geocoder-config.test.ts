import assert from "node:assert/strict";
import test from "node:test";
import { geocoderConfiguration } from "../modules/work/worker/geocoder-config";

const approvedProductionEnvironment = {
  NODE_ENV: "production",
  UK_GEOCODER_URL: "https://geo.approved.test/postcodes",
  EU_GEOCODER_URL: "https://geo.approved.test/search",
  GEOCODER_ALLOWED_HOSTS: "geo.approved.test",
  GEOCODER_USER_AGENT_CONTACT: "https://dispatch.example.test/contact",
};

test("production geocoders fail closed when an endpoint is missing", () => {
  assert.throws(
    () => geocoderConfiguration({ NODE_ENV: "production" }),
    /UK_GEOCODER_URL is required in production/,
  );
  assert.throws(
    () =>
      geocoderConfiguration({
        NODE_ENV: "production",
        UK_GEOCODER_URL: approvedProductionEnvironment.UK_GEOCODER_URL,
        GEOCODER_ALLOWED_HOSTS:
          approvedProductionEnvironment.GEOCODER_ALLOWED_HOSTS,
      }),
    /EU_GEOCODER_URL is required in production/,
  );
});

test("geocoder endpoints must be valid HTTPS URLs without embedded options", () => {
  assert.throws(
    () =>
      geocoderConfiguration({
        ...approvedProductionEnvironment,
        EU_GEOCODER_URL: "not a url",
      }),
    /EU_GEOCODER_URL must be a valid absolute URL/,
  );
  assert.throws(
    () =>
      geocoderConfiguration({
        ...approvedProductionEnvironment,
        UK_GEOCODER_URL: "http://geo.approved.test/postcodes",
      }),
    /UK_GEOCODER_URL must use HTTPS/,
  );
  assert.throws(
    () =>
      geocoderConfiguration({
        ...approvedProductionEnvironment,
        EU_GEOCODER_URL: "https://geo.approved.test/search?key=secret",
      }),
    /must not include a query string or fragment/,
  );
});

test("configured geocoder hosts must be explicitly approved", () => {
  assert.throws(
    () =>
      geocoderConfiguration({
        ...approvedProductionEnvironment,
        EU_GEOCODER_URL: "https://unapproved.test/search",
      }),
    /host "unapproved.test" is not listed in GEOCODER_ALLOWED_HOSTS/,
  );
});

test("approved production geocoder configuration is returned canonically", () => {
  assert.deepEqual(
    geocoderConfiguration(approvedProductionEnvironment),
    {
      ukUrl: "https://geo.approved.test/postcodes",
      ukHost: "geo.approved.test",
      euUrl: "https://geo.approved.test/search",
      euHost: "geo.approved.test",
      userAgent: "DispatchRouteReview/0.1 (https://dispatch.example.test/contact)",
    },
  );
});

test("public provider defaults remain local-development only", () => {
  assert.deepEqual(geocoderConfiguration({ NODE_ENV: "development" }), {
    ukUrl: "https://api.postcodes.io/postcodes",
    ukHost: "api.postcodes.io",
    euUrl: "https://nominatim.openstreetmap.org/search",
    euHost: "nominatim.openstreetmap.org",
    userAgent: "DispatchRouteReview/0.1",
  });
});

test("production geocoders require an identifying contact URL", () => {
  for (const contact of [undefined, "", "   "]) {
    assert.throws(
      () => geocoderConfiguration({
        ...approvedProductionEnvironment,
        GEOCODER_USER_AGENT_CONTACT: contact,
      }),
      /GEOCODER_USER_AGENT_CONTACT is required in production/,
    );
  }
});

test("geocoder contact rejects invalid or unsafe header content", () => {
  for (const contact of [
    "not a url",
    "http://dispatch.example.test/contact",
    "https://user:password@dispatch.example.test/contact",
    "https://dispatch.example.test/contact?key=secret",
    "https://dispatch.example.test/contact#fragment",
    "https://dispatch.example.test/(contact)",
    "https://dispatch.example.test/contact with spaces",
    "https://dispatch.example.test/contact\r\nInjected: value",
  ]) {
    assert.throws(
      () => geocoderConfiguration({
        ...approvedProductionEnvironment,
        GEOCODER_USER_AGENT_CONTACT: contact,
      }),
      /GEOCODER_USER_AGENT_CONTACT/,
      contact,
    );
  }
});

test("configured contact is trimmed and its URL canonicalised in the User-Agent", () => {
  const configuration = geocoderConfiguration({
    ...approvedProductionEnvironment,
    GEOCODER_USER_AGENT_CONTACT: "  https://DISPATCH.example.test  ",
  });
  assert.equal(configuration.userAgent, "DispatchRouteReview/0.1 (https://dispatch.example.test/)");
});
