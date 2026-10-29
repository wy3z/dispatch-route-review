import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  engineerResourceIdMutationError,
  validateEngineerRosterPayload,
} from "../modules/engineers/validation";
import { engineerRosterEntryFromDatabaseRow } from "../modules/engineers/server/roster";
import { engineerWorkingMinutesForDate, findEngineerBase } from "../modules/engineers/model";

const validPayload = {
  resourceId: 1_001,
  name: "  Alex   Example  ",
  base: "  York  ",
  region: "North",
  latitude: 53.959,
  longitude: -1.0815,
  active: true,
  workingDays: [5, 1, 3, 3, 2, 4],
  workdayStart: "9:00",
  workdayEnd: "17:00",
};

test("complete engineer payloads are normalised deterministically", () => {
  const result = validateEngineerRosterPayload(validPayload);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.engineer, {
    resourceId: 1_001,
    name: "Alex Example",
    base: "York",
    region: "North",
    latitude: 53.959,
    longitude: -1.0815,
    active: true,
    workingDays: [1, 2, 3, 4, 5],
    workdayStart: "09:00",
    workdayEnd: "17:00",
    aliases: [],
  });
});

test("invalid roster facts are rejected as one full payload", () => {
  const result = validateEngineerRosterPayload({
    ...validPayload,
    resourceId: 0,
    name: " ",
    base: " ",
    region: "Europe",
    latitude: 91,
    longitude: Number.NaN,
    active: "yes",
    workingDays: [0, 8],
    workdayStart: "17:00",
    workdayEnd: "09:00",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(Object.keys(result.errors).sort(), [
    "active",
    "base",
    "latitude",
    "longitude",
    "name",
    "region",
    "resourceId",
    "workdayEnd",
    "workingDays",
  ]);
});

test("stored roster rows serialise bigint IDs and wall-clock times safely", () => {
  assert.deepEqual(
    engineerRosterEntryFromDatabaseRow({
      id: "00000000-0000-4000-8000-000000000123",
      autotask_resource_id: "1001",
      name: "Alex Example",
      base: "York",
      region: "North",
      latitude: 53.959,
      longitude: -1.0815,
      colour_index: 7,
      active: false,
      working_days: [1, 2, 3, 4, 5],
      workday_start: "09:00:00",
      workday_end: "17:00:00",
      aliases: ["Alexandra Example"],
    }),
    {
      id: "00000000-0000-4000-8000-000000000123",
      resourceId: 1_001,
      name: "Alex Example",
      base: "York",
      region: "North",
      latitude: 53.959,
      longitude: -1.0815,
      colourIndex: 7,
      active: false,
      workingDays: [1, 2, 3, 4, 5],
      workdayStart: "09:00",
      workdayEnd: "17:00",
      aliases: ["Alexandra Example"],
    },
  );
});

test("managed hours drive weekday capacity while inactive engineers add none", () => {
  const engineer = engineerRosterEntryFromDatabaseRow({
    id: "00000000-0000-4000-8000-000000000123",
    autotask_resource_id: "1001",
    name: "Alex Example",
    base: "York",
    region: "North",
    latitude: 53.959,
    longitude: -1.0815,
    active: true,
    working_days: [1, 2, 3, 4, 5],
    colour_index: 7,
    workday_start: "08:30:00",
    workday_end: "16:30:00",
    aliases: [],
  });
  assert.equal(engineerWorkingMinutesForDate(engineer, "2026-08-17"), 480);
  assert.equal(engineerWorkingMinutesForDate(engineer, "2026-08-16"), 0);
  assert.equal(
    engineerWorkingMinutesForDate({ ...engineer, active: false }, "2026-08-17"),
    0,
  );
});

test("engineer lookup remains ID-first even when names are editable", () => {
  const engineers = [
    {
      resourceId: 1,
      name: "First Engineer",
      base: "York",
      region: "North" as const,
      latitude: 53.9,
      longitude: -1.1,
    },
    {
      resourceId: 2,
      name: "Second Engineer",
      base: "Leeds",
      region: "North" as const,
      latitude: 53.8,
      longitude: -1.5,
    },
  ];
  assert.equal(findEngineerBase(engineers, 2, "First Engineer")?.name, "Second Engineer");
  assert.equal(findEngineerBase(engineers, 99, "First Engineer"), null);
});

test("roster aliases are normalised, deduplicated, and never duplicate the name", () => {
  const result = validateEngineerRosterPayload({
    ...validPayload,
    name: "Alex Example",
    aliases: [
      "Alexandra Example",
      "alexandra   example",
      "Alex Example",
      "  A. Example ",
      "",
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.engineer.aliases, ["Alexandra Example", "A. Example"]);
});

test("invalid alias lists are rejected without a partial save", () => {
  for (const aliases of ["Alexandra Example", [42], Array.from({ length: 11 }, (_, index) => `Alias ${index}`)]) {
    const result = validateEngineerRosterPayload({ ...validPayload, aliases });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.errors.aliases ?? "", /./);
  }
});

test("name fallback matching uses operator-managed roster aliases", () => {
  const engineers = [
    {
      resourceId: 7,
      name: "Alex Example",
      base: "York",
      region: "North" as const,
      latitude: 53.9,
      longitude: -1.1,
      aliases: ["Alexandra Example"],
    },
  ];
  assert.equal(findEngineerBase(engineers, null, "Alexandra   Example")?.resourceId, 7);
  assert.equal(findEngineerBase(engineers, null, "alex example")?.resourceId, 7);
  assert.equal(findEngineerBase(engineers, null, "Unknown Name"), null);
});

test("an ambiguous name or alias match resolves to no engineer at all", () => {
  // Alias ↔ alias collision across roster entries (per-engineer dedupe cannot
  // see this) after case/space normalisation.
  const aliasClash = [
    {
      resourceId: 7,
      name: "Alex Example",
      base: "York",
      region: "North" as const,
      latitude: 53.9,
      longitude: -1.1,
      aliases: ["Alexandra Example"],
    },
    {
      resourceId: 8,
      name: "A Example",
      base: "Leeds",
      region: "North" as const,
      latitude: 53.8,
      longitude: -1.5,
      aliases: ["ALEXANDRA  EXAMPLE"],
    },
  ];
  assert.equal(findEngineerBase(aliasClash, null, "alexandra example"), null);
  // Unambiguous names and aliases in the same roster still resolve.
  assert.equal(findEngineerBase(aliasClash, null, "Alex Example")?.resourceId, 7);

  // Alias ↔ canonical-name collision across entries.
  const nameClash = [
    {
      resourceId: 7,
      name: "Alex Example",
      base: "York",
      region: "North" as const,
      latitude: 53.9,
      longitude: -1.1,
      aliases: ["Alexandra Example"],
    },
    {
      resourceId: 8,
      name: "Alexandra Example",
      base: "Leeds",
      region: "North" as const,
      latitude: 53.8,
      longitude: -1.5,
    },
  ];
  assert.equal(findEngineerBase(nameClash, null, "Alexandra Example"), null);
  assert.equal(findEngineerBase(nameClash, null, "Alex Example")?.resourceId, 7);
});

test("managed engineer resource IDs are immutable after creation", () => {
  assert.equal(engineerResourceIdMutationError(1_001, 1_001), null);
  assert.equal(
    engineerResourceIdMutationError(1_001, 1_002),
    "Autotask resource ID cannot be changed after an engineer is created.",
  );

});

test("roster migration creates an empty managed schema", () => {
  const migration = readFileSync(
    join(process.cwd(), "db/migrations/009_engineer_roster.sql"),
    "utf8",
  );
  assert.match(
    migration,
    /permission_key IN \('dispatch_review', 'engineer_management'\)/,
  );
  assert.match(migration, /CREATE TABLE engineer_roster/);
  assert.match(migration, /autotask_resource_id bigint NOT NULL UNIQUE/);
  assert.match(migration, /autotask_resource_id > 0/);
  assert.match(migration, /working_days smallint\[\]/);
  assert.match(migration, /CHECK \(workday_end > workday_start\)/);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+engineer_roster/i);
});
