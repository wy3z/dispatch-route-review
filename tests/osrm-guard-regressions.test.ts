import assert from "node:assert/strict";
import test from "node:test";
import { OSRM_BUDGET_ERROR, OsrmRoutingService } from "../modules/routing/server/osrm";
import { loadRoadRoutes } from "../modules/routing/client/road-routes";

function okRoute() {
  const coordinates = [
    [-0.1, 51.5],
    [-0.11, 51.51],
  ];
  return {
    code: "Ok",
    routes: [
      {
        distance: 1000,
        duration: 600,
        geometry: {
          type: "LineString" as const,
          coordinates,
        },
        legs: [
          {
            distance: 1000,
            duration: 600,
            steps: [
              {
                geometry: {
                  type: "LineString" as const,
                  coordinates,
                },
              },
            ],
          },
        ],
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

test("guard-limited partial routes are briefly cached to prevent rapid retries", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const route = {
    id: "guard-retry-route",
    coordinates: [
      [51.50031, -0.10031],
      [51.51031, -0.11031],
    ] as Array<[number, number]>,
  };
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse({
      routes: [
        calls === 1
          ? {
              id: route.id,
              legGeometries: [[]],
              legDurationsMinutes: [null],
              legDistancesKm: [null],
              legErrors: [OSRM_BUDGET_ERROR],
              totalDurationMinutes: 0,
              totalDistanceKm: 0,
            }
          : {
              id: route.id,
              geometry: [
                [51.50031, -0.10031],
                [51.51031, -0.11031],
              ],
              legGeometries: [
                [
                  [51.50031, -0.10031],
                  [51.51031, -0.11031],
                ],
              ],
              legDurationsMinutes: [10],
              legDistancesKm: [1],
              legErrors: [null],
              totalDurationMinutes: 10,
              totalDistanceKm: 1,
            },
      ],
    });
  }) as typeof fetch;

  const signal = new AbortController().signal;
  const first = await loadRoadRoutes([route], signal);
  const second = await loadRoadRoutes([route], signal);

  assert.equal(calls, 1);
  assert.equal(first[0]?.legErrors?.[0], OSRM_BUDGET_ERROR);
  assert.equal(second[0]?.legErrors?.[0], OSRM_BUDGET_ERROR);
});

test("shared provider budget is consumed in processing order", async () => {
  let calls = 0;
  const service = new OsrmRoutingService({
    fetchImpl: (async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ code: "NoRoute", message: "No route" })
        : jsonResponse(okRoute());
    }) as typeof fetch,
    baseUrl: () => "https://osrm.example.test",
    limits: { maxCallsPerRequest: 4, maxFallbackLegs: 3 },
  });
  const context = service.beginRequest();
  const firstRoute = {
    id: "fallback-first",
    coordinates: [
      [51.5, -0.1],
      [51.51, -0.11],
      [51.52, -0.12],
      [51.53, -0.13],
    ] as Array<[number, number]>,
  };
  const laterRoute = {
    id: "later-route",
    coordinates: [
      [52.5, -1.1],
      [52.51, -1.11],
    ] as Array<[number, number]>,
  };

  const first = await service.routeOnRoads(firstRoute, context);
  const later = await service.routeOnRoads(laterRoute, context);

  assert.equal(first.error, undefined);
  assert.deepEqual(first.legErrors, [null, null, null]);
  assert.equal(calls, 4);
  assert.equal(context.callsUsed, 4);
  assert.equal(later.error, OSRM_BUDGET_ERROR);
});
