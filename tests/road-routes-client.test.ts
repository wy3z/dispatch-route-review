import assert from "node:assert/strict";
import test from "node:test";
import { loadRoadRoutes } from "../modules/routing/client/road-routes";
import type { RoadRoute } from "../modules/routing/contracts";

type TestRoute = {
  id: string;
  coordinates: Array<[number, number]>;
};

const ROAD_ROUTE_CACHE_TTL_MS = 30 * 60 * 1000;
const ROAD_ROUTE_CACHE_MAX_ENTRIES = 64;

function testRoute(id: string, index: number): TestRoute {
  const latitude = 10 + index * 0.001;
  const longitude = -10 - index * 0.001;
  return {
    id,
    coordinates: [
      [latitude, longitude],
      [latitude + 0.0005, longitude - 0.0005],
    ],
  };
}

function requestedRoutes(init?: RequestInit) {
  return (JSON.parse(String(init?.body)) as { routes: TestRoute[] }).routes;
}

test("geometry requests survive aborted remounts and resume after cooldown", async () => {
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  const route = testRoute("claim-remount", 50);
  const controller = new AbortController();
  let now = 500_000;
  let requests = 0;
  Date.now = () => now;
  globalThis.fetch = async (_input, init) => {
    requests += 1;
    if (requests === 1) {
      controller.abort();
      throw controller.signal.reason;
    }
    return Response.json({ routes: requestedRoutes(init).map(({ id }) => ({ id })) });
  };
  try {
    await assert.rejects(loadRoadRoutes([route], controller.signal), { name: "AbortError" });
    const remount = await loadRoadRoutes([{ ...route, id: "remounted" }], new AbortController().signal);
    assert.equal(requests, 1, "remount does not retry an aborted route immediately");
    assert.match(remount[0].error ?? "", /cooling down/);
    now += 30_001;
    const recovered = await loadRoadRoutes([{ ...route, id: "recovered" }], new AbortController().signal);
    assert.equal(requests, 2);
    assert.deepEqual(recovered, [{ id: "recovered" }]);
  } finally {
    globalThis.fetch = previousFetch;
    Date.now = previousNow;
  }
});

test("road loading returns the final ordered result", async () => {
  const previousFetch = globalThis.fetch;
  const expected: RoadRoute = {
    id: "single-owner-route",
    totalDurationMinutes: 42,
  };
  globalThis.fetch = async () => Response.json({ routes: [expected] });

  try {
    const result = await loadRoadRoutes(
      [
        {
          id: expected.id,
          coordinates: [
            [51.50001, -0.10001],
            [51.51001, -0.11001],
          ],
        },
      ],
      new AbortController().signal,
    );

    assert.deepEqual(result, [expected]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("reuses a retained complete road route without another API request", async () => {
  const previousFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async (_input, init) => {
    requestCount += 1;
    return Response.json({
      routes: requestedRoutes(init).map((route) => ({
        id: route.id,
        geometry: route.coordinates,
        totalDurationMinutes: 18,
      })),
    });
  };

  const first = testRoute("cache-reuse-first", 100);
  const second = { ...first, id: "cache-reuse-second" };

  try {
    await loadRoadRoutes([first], new AbortController().signal);
    const result = await loadRoadRoutes(
      [second],
      new AbortController().signal,
    );

    assert.equal(requestCount, 1);
    assert.equal(result[0]?.id, second.id);
    assert.equal(result[0]?.totalDurationMinutes, 18);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("expires browser road-route cache entries after the fixed TTL", async () => {
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  let now = previousNow();
  let requestCount = 0;
  Date.now = () => now;
  globalThis.fetch = async (_input, init) => {
    requestCount += 1;
    return Response.json({
      routes: requestedRoutes(init).map((route) => ({
        id: route.id,
        totalDurationMinutes: requestCount,
      })),
    });
  };

  const route = testRoute("cache-expiry", 200);

  try {
    await loadRoadRoutes([route], new AbortController().signal);
    now += ROAD_ROUTE_CACHE_TTL_MS - 1;
    await loadRoadRoutes([route], new AbortController().signal);
    assert.equal(requestCount, 1);

    now += 1;
    const refreshed = await loadRoadRoutes(
      [route],
      new AbortController().signal,
    );
    assert.equal(requestCount, 2);
    assert.equal(refreshed[0]?.totalDurationMinutes, 2);
  } finally {
    globalThis.fetch = previousFetch;
    Date.now = previousNow;
  }
});

test("does not drop a cached route when the TTL boundary advances during one load", async () => {
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  const baseNow = previousNow();
  let requestCount = 0;
  Date.now = () => baseNow;
  globalThis.fetch = async (_input, init) => {
    requestCount += 1;
    return Response.json({
      routes: requestedRoutes(init).map((route) => ({
        id: route.id,
        totalDurationMinutes: 24,
      })),
    });
  };

  const route = testRoute("cache-boundary", 250);

  try {
    await loadRoadRoutes([route], new AbortController().signal);
    let cacheReadCalls = 0;
    Date.now = () => {
      cacheReadCalls += 1;
      return cacheReadCalls === 1
        ? baseNow + ROAD_ROUTE_CACHE_TTL_MS - 1
        : baseNow + ROAD_ROUTE_CACHE_TTL_MS;
    };

    const result = await loadRoadRoutes(
      [route],
      new AbortController().signal,
    );

    assert.equal(requestCount, 1);
    assert.equal(cacheReadCalls, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.id, route.id);
    assert.equal(result[0]?.totalDurationMinutes, 24);
  } finally {
    globalThis.fetch = previousFetch;
    Date.now = previousNow;
  }
});

test("evicts the least recently used route once the client cache is full", async () => {
  const previousFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async (_input, init) => {
    requestCount += 1;
    return Response.json({
      routes: requestedRoutes(init).map((route) => ({
        id: route.id,
        totalDurationMinutes: 12,
      })),
    });
  };

  const routes = Array.from(
    { length: ROAD_ROUTE_CACHE_MAX_ENTRIES },
    (_, index) => testRoute(`cache-bound-${index}`, 1000 + index),
  );

  try {
    await loadRoadRoutes(routes, new AbortController().signal);
    assert.equal(requestCount, ROAD_ROUTE_CACHE_MAX_ENTRIES / 4);

    await loadRoadRoutes([routes[0]], new AbortController().signal);
    const requestsAfterReuse = requestCount;

    await loadRoadRoutes(
      [testRoute("cache-bound-extra", 2000)],
      new AbortController().signal,
    );
    assert.equal(requestCount, requestsAfterReuse + 1);

    await loadRoadRoutes([routes[0]], new AbortController().signal);
    assert.equal(requestCount, requestsAfterReuse + 1);

    await loadRoadRoutes([routes[1]], new AbortController().signal);
    assert.equal(requestCount, requestsAfterReuse + 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("backs off repeated road-route failures returned by the API", async () => {
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  let now = previousNow();
  let requestCount = 0;
  Date.now = () => now;
  globalThis.fetch = async (_input, init) => {
    requestCount += 1;
    return Response.json({
      routes: requestedRoutes(init).map((route) => ({
        id: route.id,
        error: "Road-routing service unavailable.",
      })),
    });
  };

  const first = testRoute("failure-backoff-first", 3000);
  const second = { ...first, id: "failure-backoff-second" };

  try {
    const initial = await loadRoadRoutes(
      [first],
      new AbortController().signal,
    );
    const repeated = await loadRoadRoutes(
      [second],
      new AbortController().signal,
    );

    assert.equal(requestCount, 1);
    assert.equal(initial[0]?.error, "Road-routing service unavailable.");
    assert.equal(repeated[0]?.id, second.id);
    assert.equal(repeated[0]?.error, "Road-routing service unavailable.");

    now += 30 * 1000;
    await loadRoadRoutes([second], new AbortController().signal);
    assert.equal(requestCount, 2);
  } finally {
    globalThis.fetch = previousFetch;
    Date.now = previousNow;
  }
});

test("honours route-geometry Retry-After without retrying immediately", async () => {
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  let now = previousNow();
  let requestCount = 0;
  Date.now = () => now;
  globalThis.fetch = async () => {
    requestCount += 1;
    return Response.json(
      { message: "Too many road-routing requests." },
      { status: 429, headers: { "Retry-After": "120" } },
    );
  };

  const route = testRoute("rate-limited", 3050);

  try {
    await loadRoadRoutes([route], new AbortController().signal);
    now += 119_999;
    await loadRoadRoutes([route], new AbortController().signal);
    assert.equal(requestCount, 1);

    now += 1;
    await loadRoadRoutes([route], new AbortController().signal);
    assert.equal(requestCount, 2);
  } finally {
    globalThis.fetch = previousFetch;
    Date.now = previousNow;
  }
});

test(
  "turns a same-origin geometry deadline into a backed-off route error",
  { concurrency: false },
  async () => {
    const previousFetch = globalThis.fetch;
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(
      AbortSignal,
      "timeout",
    );
    let requestCount = 0;
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: () =>
        AbortSignal.abort(
          new DOMException("The operation timed out.", "TimeoutError"),
        ),
    });
    globalThis.fetch = async (_input, init) => {
      requestCount += 1;
      const signal = init?.signal;
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, true);
      throw signal.reason;
    };

    const route = testRoute("client-deadline", 3070);

    try {
      const initial = await loadRoadRoutes(
        [route],
        new AbortController().signal,
      );
      const repeated = await loadRoadRoutes(
        [{ ...route, id: "client-deadline-repeat" }],
        new AbortController().signal,
      );

      assert.equal(requestCount, 1);
      assert.equal(
        initial[0]?.error,
        "Road routing took too long. Try again shortly.",
      );
      assert.equal(repeated[0]?.error, initial[0]?.error);
    } finally {
      globalThis.fetch = previousFetch;
      if (timeoutDescriptor) {
        Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor);
      }
    }
  },
);

test(
  "fails closed instead of following an authentication redirect",
  { concurrency: false },
  async () => {
    const previousFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async (_input, init) => {
      requestCount += 1;
      assert.equal(init?.redirect, "error");
      throw new TypeError("fetch failed: redirect mode is set to error");
    };

    const route = testRoute("redirect-refused", 3080);

    try {
      const initial = await loadRoadRoutes(
        [route],
        new AbortController().signal,
      );
      const repeated = await loadRoadRoutes(
        [{ ...route, id: "redirect-refused-repeat" }],
        new AbortController().signal,
      );

      assert.equal(requestCount, 1);
      assert.match(initial[0]?.error ?? "", /redirect mode is set to error/);
      assert.match(repeated[0]?.error ?? "", /redirect mode is set to error/);
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
);

test(
  "turns an unreachable route-geometry endpoint into backed-off route errors",
  { concurrency: false },
  async () => {
    const previousFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      throw new TypeError("Failed to fetch");
    };

    const first = testRoute("unreachable-first", 3100);
    const deferred = Array.from(
      { length: 4 },
      (_, index) => testRoute(`unreachable-deferred-${index}`, 3110 + index),
    );
    const routes = [first, ...deferred];

    try {
      const initial = await loadRoadRoutes(
        routes,
        new AbortController().signal,
      );
      const repeated = await loadRoadRoutes(
        routes.map((route) => ({ ...route, id: `${route.id}-repeat` })),
        new AbortController().signal,
      );

      assert.equal(requestCount, 1);
      assert.equal(initial.length, routes.length);
      assert.equal(repeated.length, routes.length);
      assert.ok(initial.every((route) => route.error === "Failed to fetch"));
      assert.ok(repeated.every((route) => route.error === "Failed to fetch"));
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
);
