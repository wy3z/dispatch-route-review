import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  RESOURCE_COLOURS,
  getContrastingTextColour,
  getResourceColour,
  getResourceColourIndex,
  withAlpha,
} from "../modules/engineers/colours";

const resources = [
  { resourceId: 1001, name: "Fixture Engineer A" },
  { resourceId: 1002, name: "Fixture Engineer B" },
  { resourceId: 1003, name: "Fixture Engineer C" },
];

const PERSISTED_RESOURCE_PALETTE = [
  "#D70000", "#8C3CFF", "#028800", "#00ACC7", "#E7A500", "#FF7FD1",
  "#6C004F", "#583B00", "#005759", "#15E18D", "#0000DD", "#A2766A",
  "#BCB7FF", "#C004B9", "#645473", "#790000", "#0774D8", "#739B7D",
  "#FF7852", "#004B00", "#8F7B01", "#F3007B", "#8FBA00", "#A67BB8",
  "#5A02A3", "#E3AFAF", "#A03A52", "#A2C8C8", "#9E4B00", "#546745",
] as const;

test("resource palette indexes remain a stable persistence contract", () => {
  assert.equal(RESOURCE_COLOURS.length, 30);
  assert.equal(new Set(RESOURCE_COLOURS).size, 30);
  assert.deepEqual(RESOURCE_COLOURS, PERSISTED_RESOURCE_PALETTE);
  PERSISTED_RESOURCE_PALETTE.forEach((colour, colourIndex) => {
    assert.equal(getResourceColour({ resourceId: 42, colourIndex }), colour);
  });
});

test("stable identifiers keep their colours through sorting and filtering", () => {
  const original = new Map(
    resources.map((resource) => [resource.resourceId, getResourceColour(resource)]),
  );
  [...resources].reverse().forEach((resource) =>
    assert.equal(getResourceColour(resource), original.get(resource.resourceId)),
  );
  resources.slice(1).forEach((resource) =>
    assert.equal(getResourceColour(resource), original.get(resource.resourceId)),
  );
});

test("stored indexes win while invalid indexes use a deterministic safe fallback", () => {
  assert.equal(getResourceColour({ resourceId: 42, colourIndex: 5 }), "#FF7FD1");
  const fallback = getResourceColourIndex({ resourceId: 42 });
  assert.equal(getResourceColourIndex({ resourceId: 42, colourIndex: -1 }), fallback);
  assert.equal(getResourceColourIndex({ resourceId: 42, colourIndex: 30 }), fallback);
  assert.ok(fallback >= 0 && fallback < RESOURCE_COLOURS.length);
});

test("palette overflow cycles safely through deterministic identity fallbacks", () => {
  const colours = Array.from({ length: 60 }, (_, index) =>
    getResourceColour({ resourceId: 50_000 + index }),
  );
  assert.equal(colours.length, 60);
  colours.forEach((colour) => assert.ok(RESOURCE_COLOURS.includes(colour as never)));
});

test("contrast helper chooses readable ink and alpha values", () => {
  for (const pale of ["#FF7FD1", "#BCB7FF", "#E3AFAF", "#A2C8C8"]) {
    assert.equal(getContrastingTextColour(pale), "#111827", pale);
  }
  for (const dark of ["#0000DD", "#6C004F", "#004B00", "#790000"]) {
    assert.equal(getContrastingTextColour(dark), "#FFFFFF", dark);
  }
  assert.equal(withAlpha("#D70000", 0.1), "rgba(215, 0, 0, 0.1)");
});

test("resource colour migration persists bounded palette indexes", () => {
  const migration = readFileSync(
    join(process.cwd(), "db/migrations/010_resource_colour_index.sql"),
    "utf8",
  );
  assert.match(migration, /ADD COLUMN colour_index smallint/);
  assert.match(migration, /ORDER BY autotask_resource_id/);
  assert.match(migration, /colour_index BETWEEN 0 AND 29/);
  assert.match(migration, /ALTER COLUMN colour_index SET NOT NULL/);
});
