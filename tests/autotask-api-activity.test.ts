import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  AUTOTASK_API_ACTIVITY_RETENTION_DAYS,
  autotaskApiLogEntry,
  autotaskApiOutcome,
  trackedAutotaskFetch,
} from "../modules/work/worker/api-activity";
import type { AutotaskApiActivity } from "../modules/work/worker/api-activity";

test("final Autotask transport rejects outside the worker before fetch", async () => {
  const originalWorkerFlag = process.env.CACHE_WORKER;
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  delete process.env.CACHE_WORKER;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("unexpected network request");
  };

  try {
    await assert.rejects(
      trackedAutotaskFetch(
        "https://example.invalid/Tickets/query",
        { method: "POST" },
        { entity: "Tickets", operation: "query" },
      ),
      /restricted to the cache worker/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    if (originalWorkerFlag === undefined) delete process.env.CACHE_WORKER;
    else process.env.CACHE_WORKER = originalWorkerFlag;
    globalThis.fetch = originalFetch;
  }
});

test("final Autotask transport allows worker fetches", async () => {
  const originalWorkerFlag = process.env.CACHE_WORKER;
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  process.env.CACHE_WORKER = "1";
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response(null, { status: 204 });
  };

  try {
    const response = await trackedAutotaskFetch(
      "https://example.invalid/Tickets/query",
      { method: "POST" },
      { entity: "Tickets", operation: "query" },
    );
    assert.equal(fetchCalled, true);
    assert.equal(response.status, 204);
  } finally {
    if (originalWorkerFlag === undefined) delete process.env.CACHE_WORKER;
    else process.env.CACHE_WORKER = originalWorkerFlag;
    globalThis.fetch = originalFetch;
  }
});

test("final Autotask transport blocks redirects for query, metadata and pagination", async () => {
  const originalWorkerFlag = process.env.CACHE_WORKER;
  const originalFetch = globalThis.fetch;
  const seen: RequestInit[] = [];
  const queryInit: RequestInit = { method: "POST", redirect: "follow" };
  const metadataInit: RequestInit = { redirect: "manual" };
  const paginationInit: RequestInit = { redirect: "follow" };
  process.env.CACHE_WORKER = "1";
  globalThis.fetch = async (_input, init) => {
    seen.push(init ?? {});
    return new Response(null, { status: 204 });
  };

  try {
    await trackedAutotaskFetch(
      "https://example.invalid/Tickets/query",
      queryInit,
      { entity: "Tickets", operation: "query", pageNumber: 1 },
    );
    await trackedAutotaskFetch(
      "https://example.invalid/Tickets/entityInformation/fields",
      metadataInit,
      { entity: "Tickets", operation: "entity_information" },
    );
    await trackedAutotaskFetch(
      "https://example.invalid/Tickets/query?page=2",
      paginationInit,
      { entity: "Tickets", operation: "query", pageNumber: 2 },
    );

    assert.deepEqual(
      seen.map(({ method, redirect }) => [method ?? "GET", redirect]),
      [["POST", "error"], ["GET", "error"], ["GET", "error"]],
    );
    assert.deepEqual(
      [queryInit.redirect, metadataInit.redirect, paginationInit.redirect],
      ["follow", "manual", "follow"],
    );
  } finally {
    if (originalWorkerFlag === undefined) delete process.env.CACHE_WORKER;
    else process.env.CACHE_WORKER = originalWorkerFlag;
    globalThis.fetch = originalFetch;
  }
});

test("Autotask activity classifies HTTP and network outcomes", () => {
  assert.equal(autotaskApiOutcome({ ok: true }), "success");
  assert.equal(autotaskApiOutcome({ ok: false }), "http_error");
  assert.equal(
    autotaskApiOutcome(null, new DOMException("timed out", "TimeoutError")),
    "timeout",
  );
  assert.equal(autotaskApiOutcome(null, new Error("socket closed")), "network_error");
});

test("structured activity logs expose metadata but no request data", () => {
  const activity: AutotaskApiActivity = {
    entity: "Tickets",
    operation: "query",
    method: "POST",
    pageNumber: 2,
    statusCode: 200,
    outcome: "success",
    durationMs: 125,
  };
  assert.deepEqual(autotaskApiLogEntry(activity), {
    event: "autotask_api_request_completed",
    entity: "Tickets",
    operation: "query",
    method: "POST",
    pageNumber: 2,
    statusCode: 200,
    outcome: "success",
    durationMs: 125,
  });
  assert.doesNotMatch(
    JSON.stringify(autotaskApiLogEntry(activity)),
    /url|header|body|filter/i,
  );
});

test("Autotask activity migration stores only bounded operational metadata", () => {
  const migration = readFileSync(
    join(process.cwd(), "db/migrations/005_autotask_api_activity.sql"),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE autotask_api_activity/);
  assert.doesNotMatch(migration, /url|headers|body|payload|filter/i);
  assert.equal(AUTOTASK_API_ACTIVITY_RETENTION_DAYS, 8);
});
