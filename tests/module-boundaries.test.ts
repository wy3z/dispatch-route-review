import assert from "node:assert/strict";
import test from "node:test";
import { checkBoundaries } from "../scripts/check-boundaries.mjs";

const check = (files: Record<string, string>) => checkBoundaries(new Map(Object.entries(files)));

test("public contracts and directed domain dependencies are allowed", () => {
  assert.deepEqual(check({
    "modules/routing/domain.ts": 'import type { Visit } from "@/modules/work/contracts";',
    "modules/work/contracts.ts": "export type Visit = { id: string };",
  }), []);
});

test("private imports and reverse dependencies are rejected even through aliases", () => {
  const errors = check({
    "modules/work/domain.ts": 'import { calculate } from "@/modules/routing/internal";',
    "modules/routing/internal.ts": "export const calculate = () => 1;",
  });
  assert.ok(errors.some((error) => error.includes("public entry point")));
  assert.ok(errors.some((error) => error.includes("work must not depend on routing")));
});

test("client imports cannot hide server access behind a re-export or dynamic import", () => {
  const errors = check({
    "modules/work/client.ts": '"use client"; export { load } from "./loader";',
    "modules/work/loader.ts": 'export const load = () => import("./server/database");',
    "modules/work/server/database.ts": "export const query = () => 1;",
  });
  assert.ok(errors.some((error) => error.includes("Client reaches server code")));
});

test("web routes cannot reach the worker through a server facade", () => {
  const errors = check({
    "app/api/work/route.ts": 'import { load } from "@/modules/work/server";',
    "modules/work/server.ts": 'export { load } from "./worker/source";',
    "modules/work/worker/source.ts": "export const load = () => 1;",
  });
  assert.ok(errors.some((error) => error.includes("Only the cache worker")));
});

test("runtime cycles fail while erased type-only imports remain safe", () => {
  const files = {
    "modules/work/a.ts": 'import { b } from "./b"; export const a = () => b;',
    "modules/work/b.ts": 'import { a } from "./a"; export const b = () => a;',
  };
  assert.ok(check(files).some((error) => error.includes("Runtime import cycle")));
  assert.deepEqual(check({
    "modules/work/client.ts": '"use client"; import type { Config } from "./server/config";',
    "modules/work/server/config.ts": "export type Config = { id: string };",
  }), []);
});
