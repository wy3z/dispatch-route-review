import assert from "node:assert/strict";
import test from "node:test";
import {
  OSRM_BUDGET_ERROR,
  OSRM_CIRCUIT_OPEN_ERROR,
  OSRM_DEADLINE_ERROR,
  OSRM_FALLBACK_LIMIT_ERROR,
  OsrmRoutingService,
} from "../modules/routing/server/osrm";

function okRoute(points = 2) {
  const coordinates = Array.from({ length: points }, (_, index) => [
    -0.1 - index / 100,
    51.5 + index / 100,
  ]);
  const legs = Array.from({ length: Math.max(1, points - 1) }, (_, index) => ({
    distance: 1000 + index * 100,
    duration: 600 + index * 60,
    steps: [
      {
        geometry: {
          type: "LineString" as const,
          coordinates: [
            coordinates[index],
            coordinates[index + 1] ?? coordinates[index],
          ],
        },
      },
    ],
  }));
  return {
    code: "Ok",
    routes: [
      {
        distance: legs.reduce((total, leg) => total + leg.distance, 0),
        duration: legs.reduce((total, leg) => total + leg.duration, 0),
        geometry: { type: "LineString" as const, coordinates },
        legs,
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function route(points: number) {
  return {
    id: `route-${points}`,
    coordinates: Array.from(
      { length: points },
      (_, index) => [51.5 + index / 100, -0.1 - index / 100] as [number, number],
    ),
  };
}

function controlledTimeoutSignal() {
  let controller: AbortController | undefined;
  let milliseconds: number | undefined;
  return {
    factory(timeoutMs: number) {
      milliseconds = timeoutMs;
      controller = new AbortController();
      return controller.signal;
    },
    abort() {
      assert.ok(controller, "timeout signal was not created");
      controller.abort(new DOMException("Timed out", "TimeoutError"));
    },
    milliseconds() {
      return milliseconds;
    },
  };
}

function afterCurrentTurn(action: () => void) {
  setImmediate(action);
}

test("successful routes use one outbound OSRM call", async () => {
  let calls = 0;
  const service = new OsrmRoutingService({
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse(okRoute(3));
    }) as typeof fetch,
    baseUrl: () => "https://osrm.example.test",
  });

  const context = service.beginRequest();
  const result = await service.routeOnRoads(route(3), context);

  assert.equal(calls, 1);
  assert.equal(context.callsUsed, 1);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.legErrors, [null, null]);
});

test("NoRoute retries individual legs within the fallback ceiling", async () => {
  let calls = 0;
  const service = new OsrmRoutingService({
    fetchImpl: (async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ code: "NoRoute", message: "No route" })
        : jsonResponse(okRoute(2));
    }) as typeof fetch,
    baseUrl: () => "https://osrm.example.test",
  });

  const context = service.beginRequest();
  const result = await service.routeOnRoads(route(4), context);

  assert.equal(calls, 4);
  assert.equal(context.callsUsed, 4);
  assert.deepEqual(result.legErrors, [null, null, null]);
});

test("partial fallback preserves successful legs and reports failed legs", async () => {
  let calls = 0;
  const service = new OsrmRoutingService({
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1 || calls === 3) {
        return jsonResponse({ code: "NoRoute", message: "No route" });
      }
      return jsonResponse(okRoute(2));
    }) as typeof fetch,
    baseUrl: () => "https://osrm.example.test",
  });

  const result = await service.routeOnRoads(route(4), service.beginRequest());

  assert.equal(calls, 4);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.legErrors, [null, "No route", null]);
  assert.deepEqual(result.legDurationsMinutes, [10, null, 10]);
});

test("large NoRoute responses stop at the configured fallback leg maximum", async () => {
  let calls = 0;
  const service = new OsrmRoutingService({
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse({ code: "NoRoute", message: "No route" });
    }) as typeof fetch,
    baseUrl: () => "https://osrm.example.test",
    limits: { maxFallbackLegs: 3 },
  });

  const result = await service.routeOnRoads(route(20), service.beginRequest());

  assert.equal(calls, 4, "one full request plus three fallback legs");
  assert.equal(result.legErrors?.length, 19);
  assert.equal(result.legErrors?.[3], OSRM_FALLBACK_LIMIT_ERROR);
  assert.equal(result.legErrors?.at(-1), OSRM_FALLBACK_LIMIT_ERROR);
});

test("the per-request outbound-call budget cannot be exceeded", async () => {
  let calls = 0;
  const service = new OsrmRoutingService({
    fetchImpl: (async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ code: "NoRoute", message: "No route" })
        : jsonResponse(okRoute(2));
    }) as typeof fetch,
    baseUrl: () => "https://osrm.example.test",
    limits: { maxCallsPerRequest: 3, maxFallbackLegs: 8 },
  });
  const context = service.beginRequest();

  const result = await service.routeOnRoads(route(10), context);

  assert.equal(calls, 3);
  assert.equal(context.callsUsed, 3);
  assert.equal(result.legErrors?.[2], OSRM_BUDGET_ERROR);
  assert.equal(result.legErrors?.at(-1), OSRM_BUDGET_ERROR);
});

test("the outbound-call budget is shared across every route in one API request", async () => {
  let calls = 0;
  const service = new OsrmRoutingService({
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse(okRoute(2));
    }) as typeof fetch,
    baseUrl: () => "https://osrm.example.test",
    limits: { maxCallsPerRequest: 3, maxConcurrency: 4 },
  });
  const context = service.beginRequest();

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      service.routeOnRoads(
        { ...route(2), id: `shared-${index}` },
        context,
      ),
    ),
  );

  assert.equal(calls, 3);
  assert.equal(context.callsUsed, 3);
  assert.equal(
    results.filter((result) => result.error === OSRM_BUDGET_ERROR).length,
    2,
  );
});

test("an overall deadline abort during fetch is classified deterministically", async () => {
  const timeout = controlledTimeoutSignal();
  let calls = 0;
  const service = new OsrmRoutingService({
    fetchImpl: ((_: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
        afterCurrentTurn(() => timeout.abort());
      });
    }) as typeof fetch,
    baseUrl: () => "https://osrm.example.test",
    timeoutSignal: timeout.factory,
    limits: { requestDeadlineMs: 15, requestTimeoutMs: 500 },
  });

  const result = await service.routeOnRoads(route(2), service.beginRequest());

  assert.equal(calls, 1);
  assert.ok((timeout.milliseconds() ?? Infinity) <= 15);
  assert.equal(result.error, OSRM_DEADLINE_ERROR);
});

test("an overall deadline abort while reading the body is classified deterministically", async () => {
  const timeout = controlledTimeoutSignal();
  const service = new OsrmRoutingService({
    fetchImpl: (async (_input, init) =>
      ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason ?? new Error("aborted")),
              { once: true },
            );
            afterCurrentTurn(() => timeout.abort());
          }),
      }) as Response) as typeof fetch,
    baseUrl: () => "https://osrm.example.test",
    timeoutSignal: timeout.factory,
    limits: { requestDeadlineMs: 15, requestTimeoutMs: 500 },
  });

  const result = await service.routeOnRoads(route(2), service.beginRequest());

  assert.ok((timeout.milliseconds() ?? Infinity) <= 15);
  assert.equal(result.error, OSRM_DEADLINE_ERROR);
});

test("an individual provider timeout consumes one outbound call", async () => {
  const timeout = controlledTimeoutSignal();
  let calls = 0;
  const service = new OsrmRoutingService({
    fetchImpl: ((_: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
        afterCurrentTurn(() => timeout.abort());
      });
    }) as typeof fetch,
    baseUrl: () => "https://osrm.example.test",
    timeoutSignal: timeout.factory,
    limits: { requestDeadlineMs: 500, requestTimeoutMs: 15 },
  });
  const context = service.beginRequest();

  const result = await service.routeOnRoads(route(2), context);

  assert.equal(calls, 1);
  assert.equal(context.callsUsed, 1);
  assert.equal(timeout.milliseconds(), 15);
  assert.match(result.error ?? "", /request failed/i);
  assert.notEqual(result.error, OSRM_DEADLINE_ERROR);
});

test("sustained provider failures open the circuit without another fetch", async () => {
  let calls = 0;
  const service = new OsrmRoutingService({
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse({ code: "Error", message: "upstream down" }, 503);
    }) as typeof fetch,
    baseUrl: () => "https://osrm.example.test",
    limits: { circuitFailureThreshold: 2, circuitOpenMs: 1000 },
  });

  await service.routeOnRoads(route(2), service.beginRequest());
  await service.routeOnRoads(route(2), service.beginRequest());
  const result = await service.routeOnRoads(route(2), service.beginRequest());

  assert.equal(calls, 2);
  assert.equal(result.error, OSRM_CIRCUIT_OPEN_ERROR);
});

test("process-wide OSRM concurrency never exceeds the configured semaphore", async () => {
  let active = 0;
  let peak = 0;
  const service = new OsrmRoutingService({
    fetchImpl: (async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return jsonResponse(okRoute(2));
    }) as typeof fetch,
    baseUrl: () => "https://osrm.example.test",
    limits: { maxConcurrency: 2, requestDeadlineMs: 500 },
  });

  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      service.routeOnRoads(
        { ...route(2), id: `route-${index}` },
        service.beginRequest(),
      ),
    ),
  );

  assert.equal(peak, 2);
});

test("authenticated caller rate limiting resets after its fixed window", () => {
  let now = 1_000;
  const service = new OsrmRoutingService({
    now: () => now,
    baseUrl: () => "https://osrm.example.test",
    limits: { rateLimitRequests: 2, rateLimitWindowMs: 1000 },
  });

  assert.deepEqual(service.takeCallerRequest("user-1"), { allowed: true });
  assert.deepEqual(service.takeCallerRequest("user-1"), { allowed: true });
  assert.deepEqual(service.takeCallerRequest("user-1"), {
    allowed: false,
    retryAfterSeconds: 1,
  });
  assert.deepEqual(service.takeCallerRequest("user-2"), { allowed: true });

  now += 1001;
  assert.deepEqual(service.takeCallerRequest("user-1"), { allowed: true });
});
