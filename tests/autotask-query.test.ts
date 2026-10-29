import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  autotaskEntityFields,
  autotaskQuery,
} from "../modules/work/worker/autotask-server";

const baseUrl = "https://autotask.example.invalid/ATServicesRest/V1.0";
const queryUrl = `${baseUrl}/Tickets/query`;
const nextPageUrl = `${queryUrl}?page=2`;
const filter = [{ field: "id", op: "in", value: [101, 102] }];
const queryBody = '{"MaxRecords":500,"filter":[{"field":"id","op":"in","value":[101,102]}]}';

type ExpectedRequest = {
  url: string;
  method: "GET" | "POST";
  body?: string;
  payload: unknown;
  status?: number;
};

// Only external boundaries are replaced: query construction, pagination and
// tracked transport all run normally. These tests must remain serial because
// their synthetic worker environment, fetch and telemetry pool are global.
async function withAutotaskFixture(
  requests: ExpectedRequest[],
  run: (signals: AbortSignal[]) => Promise<void>,
) {
  const environment = {
    CACHE_WORKER: "1",
    AUTOTASK_BASE_URL: baseUrl,
    AUTOTASK_API_CODE: "synthetic-integration-code",
    AUTOTASK_USERNAME: "synthetic-user",
    AUTOTASK_SECRET: "synthetic-secret",
  };
  const originalEnvironment = new Map(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  const originalFetch = globalThis.fetch;
  const originalPool = globalThis.__dispatchDatabasePool;
  const signals: AbortSignal[] = [];
  const telemetryQueries: string[] = [];
  let calls = 0;

  try {
    Object.assign(process.env, environment);
    globalThis.__dispatchDatabasePool = {
      async query(sql: string) {
        telemetryQueries.push(sql);
        return { rows: [], rowCount: 1 };
      },
    } as unknown as Pool;
    globalThis.fetch = async (input, init) => {
      const expected = requests[calls++];
      assert.ok(expected, "unexpected additional fetch");
      assert.equal(String(input), expected.url);
      assert.equal(init?.method ?? "GET", expected.method);
      assert.equal(init?.body, expected.body);
      assert.equal(init?.cache, "no-store");
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      signals.push(init.signal);
      const headers = new Headers(init.headers);
      assert.equal(headers.get("ApiIntegrationCode"), "synthetic-integration-code");
      assert.equal(headers.get("UserName"), "synthetic-user");
      assert.equal(headers.get("Secret"), "synthetic-secret");
      assert.equal(headers.get("Accept"), "application/json");
      assert.equal(headers.get("Content-Type"), "application/json");
      return Response.json(expected.payload, { status: expected.status ?? 200 });
    };

    await run(signals);
    assert.equal(calls, requests.length, "all expected requests were dispatched");
    assert.equal(telemetryQueries.length, calls);
    for (const sql of telemetryQueries) {
      assert.match(sql, /^INSERT INTO autotask_api_activity\b/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__dispatchDatabasePool = originalPool;
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("Autotask query posts only to Tickets/query then reads continuation without a body", async () => {
  const controller = new AbortController();
  await withAutotaskFixture(
    [
      {
        url: queryUrl,
        method: "POST",
        body: queryBody,
        payload: { items: [{ id: 101 }], pageDetails: { nextPageUrl } },
      },
      {
        url: nextPageUrl,
        method: "GET",
        payload: { items: [{ id: 102 }], pageDetails: { nextPageUrl: null } },
      },
    ],
    async (signals) => {
      assert.deepEqual(await autotaskQuery("Tickets", filter, controller.signal), [
        { id: 101 },
        { id: 102 },
      ]);
      controller.abort();
      assert.equal(signals.length, 2);
      for (const signal of signals) assert.equal(signal.aborted, true);
    },
  );
});

test("Autotask field metadata is a bodyless GET with caller cancellation", async () => {
  const controller = new AbortController();
  const fields = [{ name: "id", dataType: "integer", isQueryable: true }];
  await withAutotaskFixture(
    [
      {
        url: `${baseUrl}/Tickets/entityInformation/fields`,
        method: "GET",
        payload: { fields },
      },
    ],
    async (signals) => {
      assert.deepEqual(await autotaskEntityFields("Tickets", controller.signal), fields);
      controller.abort();
      assert.equal(signals.length, 1);
      assert.equal(signals[0].aborted, true);
    },
  );
});

for (const [reason, unsafeUrl] of [
  ["foreign origin", "https://other.example.invalid/ATServicesRest/V1.0/Tickets/query?page=2"],
  ["non-HTTPS protocol", "http://autotask.example.invalid/ATServicesRest/V1.0/Tickets/query?page=2"],
  ["path outside the API root", "https://autotask.example.invalid/ATServicesRest/V1.0-other/Tickets/query?page=2"],
]) {
  test(`Autotask query rejects continuation with ${reason} before dispatch`, async () => {
    await withAutotaskFixture(
      [
        {
          url: queryUrl,
          method: "POST",
          body: queryBody,
          payload: { items: [{ id: 101 }], pageDetails: { nextPageUrl: unsafeUrl } },
        },
      ],
      async () => {
        await assert.rejects(autotaskQuery("Tickets", filter), /unsafe pagination URL/);
      },
    );
  });
}

test("Autotask query rejects an already-aborted caller without any fetch", async () => {
  const controller = new AbortController();
  const reason = new Error("synthetic caller cancellation");
  controller.abort(reason);
  await withAutotaskFixture([], async () => {
    await assert.rejects(
      autotaskQuery("Tickets", filter, controller.signal),
      (error) => error === reason,
    );
  });
});

test("Autotask query rejects a later HTTP failure instead of returning the first page", async () => {
  await withAutotaskFixture(
    [
      {
        url: queryUrl,
        method: "POST",
        body: queryBody,
        payload: { items: [{ id: 101 }], pageDetails: { nextPageUrl } },
      },
      {
        url: nextPageUrl,
        method: "GET",
        status: 503,
        payload: { errors: ["synthetic second-page failure"] },
      },
    ],
    async () => {
      await assert.rejects(autotaskQuery("Tickets", filter), {
        name: "Error",
        message: "Tickets: synthetic second-page failure",
      });
    },
  );
});
