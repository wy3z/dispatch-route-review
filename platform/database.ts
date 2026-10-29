import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";

declare global {
  var __dispatchDatabasePool: Pool | undefined;
}

function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required.");
  }

  const pool = new Pool({
    application_name: "dispatch-route-review",
    connectionString,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl:
      process.env.DATABASE_SSL === "require"
        ? { rejectUnauthorized: true }
        : undefined,
  });
  pool.on("error", () => {
    console.error('{"event":"database_pool_idle_error"}');
  });
  return pool;
}

export function database() {
  if (!globalThis.__dispatchDatabasePool) {
    globalThis.__dispatchDatabasePool = createPool();
  }
  return globalThis.__dispatchDatabasePool;
}

export async function query<Row extends QueryResultRow>(
  text: string,
  values: unknown[] = [],
) {
  return database().query<Row>(text, values);
}

export async function withTransaction<T>(
  run: (client: PoolClient) => Promise<T>,
) {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
