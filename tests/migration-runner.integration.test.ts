import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import { runMigrations } from "../scripts/migrate";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

type Fixture = {
  admin: Client;
  createPool: () => Pool;
  migrationsDirectory: string;
  schema: string;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  assert.ok(databaseUrl);
  const admin = new Client({ connectionString: databaseUrl });
  const schema = `migration_runner_${process.pid}_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}`;
  const migrationsDirectory = await mkdtemp(
    join(tmpdir(), "migration-runner-"),
  );
  const pools: Pool[] = [];

  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);

  try {
    await run({
      admin,
      migrationsDirectory,
      schema,
      createPool: () => {
        const pool = new Pool({
          application_name: "migration-runner-integration-test",
          connectionString: databaseUrl,
          max: 1,
          options: `-c search_path=${schema},public`,
        });
        pools.push(pool);
        return pool;
      },
    });
  } finally {
    await Promise.allSettled(pools.map((pool) => pool.end()));
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    await rm(migrationsDirectory, { recursive: true, force: true });
  }
}

function checksum(sql: string) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

test(
  "serializes concurrent migration runs and applies a migration once",
  {
    skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
    timeout: 10_000,
  },
  async () => {
    await withFixture(async ({
      admin,
      createPool,
      migrationsDirectory,
      schema,
    }) => {
      const sql = [
        "INSERT INTO migration_effects (id) VALUES (1);",
        "SELECT pg_sleep(0.25);",
        "",
      ].join("\n");
      await admin.query(
        `CREATE TABLE "${schema}".migration_effects (id integer PRIMARY KEY)`,
      );
      await writeFile(join(migrationsDirectory, "001_once.sql"), sql);

      await Promise.all([
        runMigrations(createPool(), migrationsDirectory),
        runMigrations(createPool(), migrationsDirectory),
      ]);

      const effects = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "${schema}".migration_effects`,
      );
      assert.equal(effects.rows[0].count, "1");

      const applied = await admin.query<{ name: string; checksum: string }>(
        `SELECT name, checksum FROM "${schema}".schema_migrations`,
      );
      assert.deepEqual(applied.rows, [
        { name: "001_once.sql", checksum: checksum(sql) },
      ]);
    });
  },
);

test(
  "backfills legacy records, rejects edited migrations, and releases the lock after failure",
  {
    skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
    timeout: 10_000,
  },
  async () => {
    await withFixture(async ({
      admin,
      createPool,
      migrationsDirectory,
      schema,
    }) => {
      const originalSql = "SELECT 1;\n";
      const editedSql = "SELECT 2;\n";
      const migrationPath = join(migrationsDirectory, "001_existing.sql");
      await writeFile(migrationPath, originalSql);
      await admin.query(`
        CREATE TABLE "${schema}".schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await admin.query(
        `INSERT INTO "${schema}".schema_migrations (name) VALUES ($1)`,
        ["001_existing.sql"],
      );

      await runMigrations(createPool(), migrationsDirectory);

      const backfilled = await admin.query<{
        checksum: string;
        is_nullable: "NO" | "YES";
      }>(
        `SELECT migrations.checksum, columns.is_nullable
           FROM "${schema}".schema_migrations AS migrations
           JOIN information_schema.columns AS columns
             ON columns.table_schema = $1
            AND columns.table_name = 'schema_migrations'
            AND columns.column_name = 'checksum'
          WHERE migrations.name = $2`,
        [schema, "001_existing.sql"],
      );
      assert.deepEqual(backfilled.rows[0], {
        checksum: checksum(originalSql),
        is_nullable: "NO",
      });

      await writeFile(migrationPath, editedSql);
      const failedPool = createPool();
      await assert.rejects(
        runMigrations(failedPool, migrationsDirectory),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /001_existing\.sql checksum mismatch/);
          assert.match(error.message, /Restore the applied migration file/);
          return true;
        },
      );

      await writeFile(migrationPath, originalSql);
      await runMigrations(createPool(), migrationsDirectory);
    });
  },
);
