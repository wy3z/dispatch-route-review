import assert from "node:assert/strict";
import test from "node:test";
import { loadRoadRoutes } from "../modules/routing/client/road-routes";

const coolingRoute = {
  id: "cooling-route",
  coordinates: [
    [12.34567, 23.45678],
    [12.35567, 23.46678],
  ] as Array<[number, number]>,
};

const availableRoute = {
  id: "available-route",
  coordinates: [
    [34.56789, 45.67891],
    [34.57789, 45.68891],
  ] as Array<[number, number]>,
};

test("one cooling route does not suppress unrelated road geometry", async () => {
  const previousFetch = globalThis.fetch;
  const requestedRouteIds: string[][] = [];

  const controller = new AbortController();
  let abortFirstRequest = true;
  globalThis.fetch = async (_input, init) => {
    if (abortFirstRequest) {
      abortFirstRequest = false;
      controller.abort();
      throw controller.signal.reason;
    }
    const request = JSON.parse(String(init?.body)) as {
      routes: Array<{ id: string; coordinates: Array<[number, number]> }>;
    };
    requestedRouteIds.push(request.routes.map((route) => route.id));
    return Response.json({
      routes: request.routes.map((route) => ({
        id: route.id,
        legGeometries: [[route.coordinates[0], route.coordinates[1]]],
        legDurationsMinutes: [12],
        legDistancesKm: [8.4],
        legErrors: [null],
        totalDurationMinutes: 12,
        totalDistanceKm: 8.4,
      })),
    });
  };

  try {
    await assert.rejects(loadRoadRoutes([coolingRoute], controller.signal), { name: "AbortError" });
    const results = await loadRoadRoutes(
      [coolingRoute, availableRoute],
      new AbortController().signal,
    );

    assert.deepEqual(requestedRouteIds, [["available-route"]]);
    assert.match(
      results.find((route) => route.id === coolingRoute.id)?.error ?? "",
      /cooling down/,
    );
    assert.equal(
      results.find((route) => route.id === availableRoute.id)
        ?.totalDurationMinutes,
      12,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});
