import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("Leaflet runtime and dependencies remain retired", () => {
  for (const path of ["app/components/RouteMap.tsx", "app/components/route-map-runtime.ts", "app/components/route-map-camera.ts", "app/components/use-route-map-keyboard.ts"]) {
    assert.equal(existsSync(join(root, path)), false, path);
  }
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const name of ["leaflet", "@types/leaflet", "@maplibre/maplibre-gl-leaflet"]) {
    assert.equal(manifest.dependencies[name] ?? manifest.devDependencies[name], undefined, name);
  }
});

test("retired Draft, scheduler, matrix, and Timefold runtime surfaces stay absent", () => {
  for (const path of [
    "app/draft/page.tsx",
    "app/api/draft-queue/route.ts",
    "app/api/scheduler/plans/route.ts",
    "app/api/scheduler/plans/[id]/route.ts",
    "app/api/timefold-export/route.ts",
    "app/api/travel-matrix/route.ts",
    "app/lib/scheduler-store.ts",
    "app/lib/timefold-export.ts",
    "app/lib/travel-matrix-client.ts",
    "app/lib/travel-matrix.ts",
    "app/lib/inflight-join.ts",
  ]) {
    assert.equal(existsSync(join(root, path)), false, path);
  }
});

test("Dispatch compatibility and database-backed read APIs remain present", () => {
  for (const path of [
    "app/page.tsx",
    "app/dispatch/page.tsx",
    "app/api/autotask-schedule/route.ts",
    "app/api/planning-demand/route.ts",
    "app/api/ready-to-book/route.ts",
    "app/api/route-geometry/route.ts",
  ]) {
    assert.equal(existsSync(join(root, path)), true, path);
  }
});

test("the public app icon bypasses authentication while arbitrary images and image optimisation stay protected", async () => {
  const { unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server");
  const { NextRequest } = await import("next/server");
  const { config, proxy } = await import("../proxy");
  const previousMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "forward-auth";
  try {
    for (const path of ["/icon.svg", "/_next/static/chunk.js", "/api/health/live"]) {
      assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: path }), false, path);
    }
    for (const path of ["/private.png", "/icon.svg/private", "/private-icon.svg", "/_next/image?url=%2Ficon.svg&w=32&q=75", "/api/engineers", "/engineers"]) {
      assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: path }), true, path);
      assert.equal(proxy(new NextRequest(`https://test.invalid${path}`)).status, 401);
    }
  } finally {
    if (previousMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousMode;
  }
});

test("live Autotask source clients remain read-only", () => {
  for (const path of [
    "modules/work/worker/autotask-server.ts",
    "modules/work/worker/schedule-source.ts",
    "modules/work/worker/demand-source.ts",
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    assert.doesNotMatch(
      source,
      /method:\s*["'](?:PATCH|PUT|DELETE)["']/,
      `${path} must not write to Autotask`,
    );
  }
});
