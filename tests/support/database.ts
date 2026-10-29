import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Client } from "pg";

/** One disposable schema per test. Callers in a file must run sequentially. */
export async function isolatedDatabase(
  t: TestContext,
  { migrations, environment = {} }: {
    migrations?: string[];
    environment?: Record<string, string>;
  } = {},
) {
  const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required.");
  const url = new URL(databaseUrl);
  const client = new Client({ connectionString: url.toString() });
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const previous = Object.fromEntries(
    ["DATABASE_URL", ...Object.keys(environment)].map(key => [key, process.env[key]]),
  );
  await client.connect();
  t.after(async () => {
    try {
      if (globalThis.__dispatchDatabasePool) {
        const pool = globalThis.__dispatchDatabasePool;
        globalThis.__dispatchDatabasePool = undefined;
        await pool.end();
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      try {
        await client.query("SET search_path TO public");
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await client.end();
      }
    }
  });
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}", public`);
  const directory = join(process.cwd(), "db/migrations");
  const names = migrations ?? (await readdir(directory)).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort();
  for (const name of names) await client.query(await readFile(join(directory, name), "utf8"));
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  Object.assign(process.env, environment, { DATABASE_URL: url.toString() });
  return client;
}
