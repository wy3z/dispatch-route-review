import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  autotaskEntityFields,
  autotaskQuery,
} from "../modules/work/worker/autotask-server";

test("Autotask rejects malformed collection responses", async (t) => {
  const env = {
    CACHE_WORKER: "1",
    AUTOTASK_BASE_URL: "https://autotask.test/V1.0",
    AUTOTASK_API_CODE: "fixture",
    AUTOTASK_USERNAME: "fixture",
    AUTOTASK_SECRET: "fixture",
  };
  const original = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  const oldPool = globalThis.__dispatchDatabasePool;
  globalThis.__dispatchDatabasePool = {
    query: async () => ({ rows: [], rowCount: 1 }),
  } as unknown as Pool;
  Object.assign(process.env, env);
  t.mock.method(console, "log", () => {});

  let responses: unknown[] = [];
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    assert.ok(responses.length, "unexpected Autotask request");
    return Response.json(responses.shift());
  });

  try {
    for (const payload of [
      {},
      { items: null },
      { items: {} },
      { items: [null] },
      { items: [[]] },
      { items: [42] },
    ]) {
      responses = [payload];
      await assert.rejects(autotaskQuery("Tickets", []), {
        message: "Autotask returned an invalid items collection.",
      });
    }

    responses = [
      {
        items: [{ id: 1 }],
        pageDetails: {
          nextPageUrl: "https://autotask.test/V1.0/Tickets/query?page=2",
        },
      },
      {},
    ];
    await assert.rejects(autotaskQuery("Tickets", []), {
      message: "Autotask returned an invalid items collection.",
    });

    responses = [{ items: [] }];
    assert.deepEqual(await autotaskQuery("Tickets", []), []);

    requests = 0;
    const entity = "ResponseValidationFixture";
    responses = [{}, { fields: [null] }, { fields: [] }];
    await assert.rejects(autotaskEntityFields(entity), {
      message: "Autotask returned an invalid fields collection.",
    });
    await assert.rejects(autotaskEntityFields(entity), {
      message: "Autotask returned an invalid fields collection.",
    });
    assert.deepEqual(await autotaskEntityFields(entity), []);
    assert.deepEqual(await autotaskEntityFields(entity), []);
    assert.equal(requests, 3, "only validated metadata should be cached");
  } finally {
    globalThis.__dispatchDatabasePool = oldPool;
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
