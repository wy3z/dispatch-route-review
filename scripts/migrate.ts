import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { database } from "../platform/database";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const migrationsDirectory = resolve(scriptDirectory, "../db/migrations");
const MIGRATION_LOCK_CLASS_ID = 0x41545241; // ATRA
const MIGRATION_LOCK_OBJECT_ID = 0x4d494752; // MIGR

type Migration = {
  name: string;
  sql: string;
  checksum: string;
};

type AppliedMigration = {
  name: string;
  checksum: string | null;
};

async function readMigrations(directory: string) {
  const migrationNames = (await readdir(directory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();

  return Promise.all(
    migrationNames.map(async (name): Promise<Migration> => {
      const contents = await readFile(resolve(directory, name));
      return {
        name,
        sql: contents.toString("utf8"),
        checksum: createHash("sha256").update(contents).digest("hex"),
      };
    }),
  );
}

function checksumMismatch(
  name: string,
  storedChecksum: string,
  currentChecksum: string,
) {
  return new Error(
    `Database migration ${name} checksum mismatch: stored ${storedChecksum}, current ${currentChecksum}. Restore the applied migration file before retrying.`,
  );
}

async function rollbackAndRethrow(
  client: PoolClient,
  error: unknown,
  message: string,
): Promise<never> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError(
      [error, rollbackError],
      `${message}; rollback failed.`,
    );
  }
  throw error;
}

async function prepareMigrationTable(
  client: PoolClient,
  migrations: Migration[],
) {
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text",
    );

    const applied = await client.query<AppliedMigration>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name",
    );
    const migrationsByName = new Map(
      migrations.map((migration) => [migration.name, migration]),
    );

    for (const row of applied.rows) {
      const migration = migrationsByName.get(row.name);
      if (!migration) {
        throw new Error(
          `Applied database migration ${row.name} is missing from the migration directory. Restore the file before retrying.`,
        );
      }
      if (
        row.checksum !== null &&
        row.checksum !== migration.checksum
      ) {
        throw checksumMismatch(row.name, row.checksum, migration.checksum);
      }
    }

    const backfilledNames: string[] = [];
    for (const row of applied.rows) {
      if (row.checksum !== null) {
        continue;
      }
      const migration = migrationsByName.get(row.name);
      if (!migration) {
        throw new Error(`Cannot backfill checksum for ${row.name}.`);
      }
      const checksum = migration.checksum;
      const updated = await client.query(
        `UPDATE schema_migrations
            SET checksum = $2
          WHERE name = $1 AND checksum IS NULL`,
        [row.name, checksum],
      );
      if (updated.rowCount !== 1) {
        throw new Error(
          `Database migration ${row.name} checksum changed during backfill. Retry the migration run.`,
        );
      }
      backfilledNames.push(row.name);
    }

    await client.query(
      "ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL",
    );
    await client.query("COMMIT");
    for (const name of backfilledNames) {
      console.log(`Database migration ${name} checksum backfilled.`);
    }
  } catch (error) {
    await rollbackAndRethrow(
      client,
      error,
      "Failed to prepare database migration metadata",
    );
  }
}

export async function runMigrations(
  pool: Pool,
  directory = migrationsDirectory,
) {
  const client = await pool.connect();
  let lockAcquired = false;
  let runError: unknown;

  try {
    console.log("Waiting for database migration lock.");
    await client.query(
      "SELECT pg_advisory_lock($1::integer, $2::integer)",
      [MIGRATION_LOCK_CLASS_ID, MIGRATION_LOCK_OBJECT_ID],
    );
    lockAcquired = true;
    console.log("Database migration lock acquired.");

    const migrations = await readMigrations(directory);
    await prepareMigrationTable(client, migrations);

    for (const migration of migrations) {
      const alreadyApplied = await client.query<AppliedMigration>(
        "SELECT name, checksum FROM schema_migrations WHERE name = $1",
        [migration.name],
      );
      const applied = alreadyApplied.rows[0];
      if (applied) {
        if (
          applied.checksum === null ||
          applied.checksum !== migration.checksum
        ) {
          throw checksumMismatch(
            migration.name,
            applied.checksum ?? "missing",
            migration.checksum,
          );
        }
        console.log(`Database migration ${migration.name} already applied.`);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [migration.name, migration.checksum],
        );
        await client.query("COMMIT");
        console.log(`Database migration ${migration.name} applied.`);
      } catch (error) {
        await rollbackAndRethrow(
          client,
          error,
          `Database migration ${migration.name} failed`,
        );
      }
    }
  } catch (error) {
    runError = error;
  }

  let cleanupError: unknown;
  if (lockAcquired) {
    try {
      const unlocked = await client.query<{ unlocked: boolean }>(
        "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked",
        [MIGRATION_LOCK_CLASS_ID, MIGRATION_LOCK_OBJECT_ID],
      );
      if (!unlocked.rows[0]?.unlocked) {
        throw new Error("The database migration lock was not held by this session.");
      }
      console.log("Database migration lock released.");
    } catch (error) {
      cleanupError = new AggregateError(
        [error],
        "Failed to release the database migration lock; the connection was closed.",
      );
    }
  }

  client.release(Boolean(cleanupError));

  if (runError && cleanupError) {
    throw new AggregateError(
      [runError, cleanupError],
      "The database migration run and lock cleanup both failed.",
    );
  }
  if (runError) {
    throw runError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

async function main() {
  const pool = database();
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

// PostgreSQL also releases this session-level advisory lock when an interrupted
// process closes its database connection.
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
