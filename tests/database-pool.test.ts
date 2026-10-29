import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Pool } from "pg";
import { database, query } from "../platform/database";

class FixtureClient extends EventEmitter {
  _queryable = true;
  _ending = false;

  connect(callback: (error?: Error) => void) {
    callback();
  }

  end(callback: () => void) {
    this._ending = true;
    callback();
  }

  query(
    text: string,
    _values: unknown[],
    callback: (error: Error | null, result?: { rows: unknown[] }) => void,
  ) {
    if (text === "query failure") {
      callback(queryFailure);
      return;
    }
    callback(null, { rows: [{ value: 1 }] });
  }
}

const queryFailure = new Error("synthetic active query failure");

test("database pool contains idle errors without changing query failures", async (t) => {
  const previousPool = globalThis.__dispatchDatabasePool;
  const previousEnvironment = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_SSL: process.env.DATABASE_SSL,
    DATABASE_POOL_SIZE: process.env.DATABASE_POOL_SIZE,
  };
  globalThis.__dispatchDatabasePool = undefined;
  process.env.DATABASE_URL =
    "postgresql://fixture:synthetic-url-secret@localhost/fixture";
  process.env.DATABASE_SSL = "disable";
  process.env.DATABASE_POOL_SIZE = "1";
  const logged = t.mock.method(console, "error", () => {});
  const pool = database();
  Object.assign(pool, { Client: FixtureClient });

  try {
    assert.ok(pool instanceof Pool);
    assert.equal(pool.listenerCount("error"), 1);

    const idleClient = await pool.connect();
    idleClient.release();
    assert.equal(pool.idleCount, 1);

    const idleFailure = new Error(
      "synthetic SQL and connection details must not be logged",
    );
    assert.doesNotThrow(() => idleClient.emit("error", idleFailure));
    assert.equal(pool.totalCount, 0);
    assert.equal(pool.idleCount, 0);
    assert.deepEqual(logged.mock.calls.map((call) => call.arguments), [
      ['{"event":"database_pool_idle_error"}'],
    ]);

    assert.deepEqual((await query("SELECT 1")).rows, [{ value: 1 }]);
    assert.equal(pool.totalCount, 1);

    await assert.rejects(query("query failure"), (error) => error === queryFailure);
    assert.equal(logged.mock.callCount(), 1);
  } finally {
    await pool.end();
    globalThis.__dispatchDatabasePool = previousPool;
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
