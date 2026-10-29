import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("demo seed CLI refuses production before accessing a database", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/demo-seed.ts"], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production", DATABASE_URL: "", AUTH_MODE: "development" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Demo seed refuses to run when NODE_ENV=production/);
  assert.equal(result.stdout, "");
});

for (const [name, overrides, message] of [
  ["forward-auth", { AUTH_MODE: "forward-auth", DEMO_SEED: "1" }, /requires development authentication/],
  ["missing explicit opt-in", { AUTH_MODE: "development", DEMO_SEED: "" }, /requires explicit opt-in DEMO_SEED=1/],
] as const) {
  test(`demo seed CLI refuses ${name} before accessing a database`, () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/demo-seed.ts"], {
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "development", DATABASE_URL: "", ...overrides },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, "");
  });
}
