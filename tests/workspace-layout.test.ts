import assert from "node:assert/strict";
import test from "node:test";
import {
  clearPersistedWorkspaceLayout,
  createWorkspaceLayoutState,
  getRoutePaneSnapPoints,
  nearestRoutePaneMode,
  readPersistedWorkspaceLayout,
  resolveRoutePaneMode,
  workspaceLayoutCssVariables,
  workspaceLayoutReducer,
  writePersistedWorkspaceLayout,
} from "../modules/dispatch/ui/workspace/workspace-layout";
import type { WorkspaceLayoutStorage } from "../modules/dispatch/ui/workspace/workspace-layout";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

test("route pane snap points remain ordered and fit the available viewport", () => {
  assert.deepEqual(getRoutePaneSnapPoints(1440), {
    routes: 360,
    timeline: 760,
    fullscreen: 1412,
  });
  assert.deepEqual(getRoutePaneSnapPoints(700), {
    routes: 360,
    timeline: 672,
    fullscreen: 672,
  });
  assert.deepEqual(getRoutePaneSnapPoints(260), {
    routes: 240,
    timeline: 240,
    fullscreen: 240,
  });
});

test("route pane mode changes use hysteresis instead of flickering at a boundary", () => {
  const points = getRoutePaneSnapPoints(1440);
  const firstBoundary = (points.routes + points.timeline) / 2;
  assert.equal(resolveRoutePaneMode(firstBoundary + 10, "routes", points), "routes");
  assert.equal(resolveRoutePaneMode(firstBoundary + 29, "routes", points), "timeline");
  assert.equal(resolveRoutePaneMode(firstBoundary - 10, "timeline", points), "timeline");
  assert.equal(resolveRoutePaneMode(firstBoundary - 29, "timeline", points), "routes");
  assert.equal(nearestRoutePaneMode(300, points), "routes");
  assert.equal(nearestRoutePaneMode(720, points), "timeline");
  assert.equal(nearestRoutePaneMode(1300, points), "fullscreen");
});

test("workspace reducer owns mutually exclusive tools and pane semantics", () => {
  const points = getRoutePaneSnapPoints(1440);
  let state = createWorkspaceLayoutState({}, points);
  state = workspaceLayoutReducer(state, { type: "toggle-tool", tool: "date" });
  assert.equal(state.activeTool, "date");
  state = workspaceLayoutReducer(state, { type: "toggle-tool", tool: "filters" });
  assert.equal(state.activeTool, "filters");
  state = workspaceLayoutReducer(state, { type: "toggle-tool", tool: "filters" });
  assert.equal(state.activeTool, null);

  state = workspaceLayoutReducer(state, {
    type: "resize-route-pane",
    width: 800,
    snapPoints: points,
  });
  assert.equal(state.routePaneMode, "timeline");
  assert.equal(state.routePaneWidth, 800);
  state = workspaceLayoutReducer(state, {
    type: "snap-route-pane",
    mode: "fullscreen",
    snapPoints: points,
  });
  assert.equal(state.routePaneMode, "fullscreen");
  assert.equal(state.routePaneWidth, points.fullscreen);
  state = workspaceLayoutReducer(state, { type: "toggle-unassigned" });
  assert.equal(state.unassignedExpanded, true);
  state = workspaceLayoutReducer(state, {
    type: "set-route-pane",
    mode: "timeline",
    width: Number.NaN,
  });
  assert.equal(state.routePaneWidth, points.fullscreen);
  const narrowerPoints = getRoutePaneSnapPoints(1000);
  state = workspaceLayoutReducer(state, {
    type: "fit-route-pane-to-snap-points",
    snapPoints: narrowerPoints,
  });
  assert.equal(state.routePaneWidth, narrowerPoints.timeline);
});

test("workspace CSS variables share exact pane geometry with all consumers", () => {
  const points = getRoutePaneSnapPoints(1440);
  const state = createWorkspaceLayoutState(
    { routePaneMode: "timeline", routePaneWidth: 760 },
    points,
  );
  assert.deepEqual(workspaceLayoutCssVariables(state, { snapPoints: points }), {
    "--route-pane-width": "760px",
    "--route-pane-left-occlusion": "774px",
    "--route-pane-layout-progress": (760 - 360) / (1412 - 360),
  });
  assert.equal(
    workspaceLayoutCssVariables(
      { ...state, routePaneWidth: 10_000 },
      { snapPoints: points },
    )["--route-pane-width"],
    "1412px",
  );
});

test("persistence is data-minimised, validated, and tolerant of unavailable storage", () => {
  const values = new Map<string, string>();
  const storage: WorkspaceLayoutStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const state = createWorkspaceLayoutState({
    routePaneWidth: 640,
    routePaneMode: "timeline",
    activeTool: "notifications",
    unassignedExpanded: true,
  });
  assert.equal(writePersistedWorkspaceLayout(state, storage, "test"), true);
  assert.deepEqual(readPersistedWorkspaceLayout(storage, "test"), {
    routePaneWidth: 640,
    routePaneMode: "timeline",
    unassignedExpanded: true,
  });
  assert.doesNotMatch(values.get("test") ?? "", /notifications/);
  assert.equal(clearPersistedWorkspaceLayout(storage, "test"), true);
  assert.equal(readPersistedWorkspaceLayout(storage, "test"), null);

  const unavailable: WorkspaceLayoutStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readPersistedWorkspaceLayout(unavailable), null);
  assert.equal(writePersistedWorkspaceLayout(state, unavailable), false);
  assert.equal(clearPersistedWorkspaceLayout(unavailable), false);
});

test("an explicit URL mode stays authoritative over an incompatible saved mode", () => {
  const hook = readFileSync(
    join(
      root,
      "modules/dispatch/ui/workspace/use-workspace-layout.ts",
    ),
    "utf8",
  );
  assert.match(hook, /persisted\?\.routePaneMode !== initialMode/);
  assert.match(hook, /routePaneMode: initialMode/);
  assert.match(hook, /persistenceOptions\.initialState\?\.routePaneWidth/);
  assert.match(
    hook,
    /function initialViewportWidth[\s\S]*?return SSR_VIEWPORT_WIDTH/,
    "the first render must not read window.innerWidth or timeline CSS vars hydrate differently",
  );
  assert.doesNotMatch(
    hook,
    /typeof window === "undefined"\) return 1440/,
  );
});
