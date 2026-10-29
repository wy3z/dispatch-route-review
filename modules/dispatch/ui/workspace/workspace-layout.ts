import type { CSSProperties } from "react";

export type RoutePaneMode = "routes" | "timeline" | "fullscreen";

export type WorkspaceTool =
  | "date"
  | "filters"
  | "notifications";

export type WorkspaceLayoutState = {
  routePaneWidth: number;
  routePaneMode: RoutePaneMode;
  activeTool: WorkspaceTool | null;
  unassignedExpanded: boolean;
};

export type RoutePaneSnapPoints = Record<RoutePaneMode, number>;

export type RoutePaneSnapConfig = {
  routesWidth?: number;
  timelineWidth?: number;
  outerGutter?: number;
  minimumAvailableWidth?: number;
};

export type WorkspaceLayoutAction =
  | {
      type: "hydrate";
      state: Partial<WorkspaceLayoutState> | null;
      snapPoints?: RoutePaneSnapPoints;
    }
  | {
      type: "resize-route-pane";
      width: number;
      snapPoints: RoutePaneSnapPoints;
      hysteresis?: number;
    }
  | {
      type: "snap-route-pane";
      mode?: RoutePaneMode;
      snapPoints: RoutePaneSnapPoints;
    }
  | {
      type: "set-route-pane";
      mode: RoutePaneMode;
      width: number;
      snapPoints?: RoutePaneSnapPoints;
    }
  | { type: "fit-route-pane-to-snap-points"; snapPoints: RoutePaneSnapPoints }
  | { type: "set-active-tool"; tool: WorkspaceTool | null }
  | { type: "toggle-tool"; tool: WorkspaceTool }
  | { type: "set-unassigned-expanded"; expanded: boolean }
  | { type: "toggle-unassigned" }
  | { type: "reset"; state?: Partial<WorkspaceLayoutState> };

export const ROUTE_PANE_DEFAULTS = {
  routesWidth: 360,
  timelineWidth: 760,
  outerGutter: 14,
  minimumAvailableWidth: 240,
  hysteresis: 28,
} as const;

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayoutState = {
  routePaneWidth: ROUTE_PANE_DEFAULTS.routesWidth,
  routePaneMode: "routes",
  activeTool: null,
  unassignedExpanded: false,
};

export const WORKSPACE_LAYOUT_STORAGE_KEY =
  "dispatch-route-review.workspace-layout.v1";

const routePaneModes: RoutePaneMode[] = ["routes", "timeline", "fullscreen"];
const workspaceTools: WorkspaceTool[] = [
  "date",
  "filters",
  "notifications",
];

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRoutePaneMode(value: unknown): value is RoutePaneMode {
  return routePaneModes.includes(value as RoutePaneMode);
}

function isWorkspaceTool(value: unknown): value is WorkspaceTool {
  return workspaceTools.includes(value as WorkspaceTool);
}

function orderedBounds(points: RoutePaneSnapPoints) {
  return {
    minimum: Math.min(points.routes, points.timeline, points.fullscreen),
    maximum: Math.max(points.routes, points.timeline, points.fullscreen),
  };
}

export function getRoutePaneSnapPoints(
  viewportWidth: number,
  config: RoutePaneSnapConfig = {},
): RoutePaneSnapPoints {
  const routesTarget = config.routesWidth ?? ROUTE_PANE_DEFAULTS.routesWidth;
  const timelineTarget =
    config.timelineWidth ?? ROUTE_PANE_DEFAULTS.timelineWidth;
  const outerGutter = config.outerGutter ?? ROUTE_PANE_DEFAULTS.outerGutter;
  const minimumAvailableWidth =
    config.minimumAvailableWidth ?? ROUTE_PANE_DEFAULTS.minimumAvailableWidth;
  const safeViewport = finiteNumber(viewportWidth)
    ? Math.max(0, viewportWidth)
    : routesTarget + outerGutter * 2;
  const available = Math.max(
    Math.min(minimumAvailableWidth, safeViewport),
    safeViewport - outerGutter * 2,
  );
  const routes = Math.min(Math.max(0, routesTarget), available);
  const fullscreen = Math.max(routes, available);
  const timeline = Math.min(Math.max(routes, timelineTarget), fullscreen);

  return { routes, timeline, fullscreen };
}

export function clampRoutePaneWidth(
  width: number,
  points: RoutePaneSnapPoints,
) {
  const { minimum, maximum } = orderedBounds(points);
  const safeWidth = finiteNumber(width) ? width : minimum;
  return Math.min(maximum, Math.max(minimum, safeWidth));
}

export function nearestRoutePaneMode(
  width: number,
  points: RoutePaneSnapPoints,
): RoutePaneMode {
  const safeWidth = clampRoutePaneWidth(width, points);
  return routePaneModes.reduce((nearest, mode) =>
    Math.abs(points[mode] - safeWidth) < Math.abs(points[nearest] - safeWidth)
      ? mode
      : nearest,
  );
}

/** Pane mode with a dead-band so dragging across a breakpoint does not flicker. */
export function resolveRoutePaneMode(
  width: number,
  currentMode: RoutePaneMode,
  points: RoutePaneSnapPoints,
  hysteresis: number = ROUTE_PANE_DEFAULTS.hysteresis,
): RoutePaneMode {
  const safeWidth = clampRoutePaneWidth(width, points);
  const deadBand = Math.max(0, hysteresis);
  const routesTimelineBoundary = (points.routes + points.timeline) / 2;
  const timelineFullscreenBoundary = (points.timeline + points.fullscreen) / 2;

  if (currentMode === "routes") {
    if (safeWidth >= timelineFullscreenBoundary + deadBand) return "fullscreen";
    if (safeWidth >= routesTimelineBoundary + deadBand) return "timeline";
    return "routes";
  }

  if (currentMode === "fullscreen") {
    if (safeWidth <= routesTimelineBoundary - deadBand) return "routes";
    if (safeWidth <= timelineFullscreenBoundary - deadBand) return "timeline";
    return "fullscreen";
  }

  if (safeWidth <= routesTimelineBoundary - deadBand) return "routes";
  if (safeWidth >= timelineFullscreenBoundary + deadBand) return "fullscreen";
  return "timeline";
}

function sanitizeState(
  input: Partial<WorkspaceLayoutState> | null | undefined,
  fallback: WorkspaceLayoutState,
  snapPoints?: RoutePaneSnapPoints,
): WorkspaceLayoutState {
  const requestedMode = isRoutePaneMode(input?.routePaneMode)
    ? input.routePaneMode
    : fallback.routePaneMode;
  const requestedWidth = finiteNumber(input?.routePaneWidth)
    ? input.routePaneWidth
    : fallback.routePaneWidth;
  const routePaneWidth = snapPoints
    ? clampRoutePaneWidth(requestedWidth, snapPoints)
    : Math.max(0, requestedWidth);

  return {
    routePaneWidth,
    routePaneMode: requestedMode,
    activeTool:
      input?.activeTool === null || isWorkspaceTool(input?.activeTool)
        ? input.activeTool
        : fallback.activeTool,
    unassignedExpanded:
      typeof input?.unassignedExpanded === "boolean"
        ? input.unassignedExpanded
        : fallback.unassignedExpanded,
  };
}

export function createWorkspaceLayoutState(
  initial: Partial<WorkspaceLayoutState> = {},
  snapPoints?: RoutePaneSnapPoints,
): WorkspaceLayoutState {
  return sanitizeState(initial, DEFAULT_WORKSPACE_LAYOUT, snapPoints);
}

export function workspaceLayoutReducer(
  state: WorkspaceLayoutState,
  action: WorkspaceLayoutAction,
): WorkspaceLayoutState {
  switch (action.type) {
    case "hydrate":
      return sanitizeState(action.state, state, action.snapPoints);
    case "resize-route-pane": {
      const routePaneWidth = clampRoutePaneWidth(action.width, action.snapPoints);
      return {
        ...state,
        routePaneWidth,
        routePaneMode: resolveRoutePaneMode(
          routePaneWidth,
          state.routePaneMode,
          action.snapPoints,
          action.hysteresis,
        ),
      };
    }
    case "snap-route-pane": {
      const mode =
        action.mode ?? nearestRoutePaneMode(state.routePaneWidth, action.snapPoints);
      return { ...state, routePaneMode: mode, routePaneWidth: action.snapPoints[mode] };
    }
    case "set-route-pane": {
      const width = action.snapPoints
        ? clampRoutePaneWidth(action.width, action.snapPoints)
        : finiteNumber(action.width)
          ? Math.max(0, action.width)
          : state.routePaneWidth;
      return { ...state, routePaneMode: action.mode, routePaneWidth: width };
    }
    case "fit-route-pane-to-snap-points":
      return {
        ...state,
        routePaneWidth: action.snapPoints[state.routePaneMode],
      };
    case "set-active-tool":
      return { ...state, activeTool: action.tool };
    case "toggle-tool":
      return {
        ...state,
        activeTool: state.activeTool === action.tool ? null : action.tool,
      };
    case "set-unassigned-expanded":
      return { ...state, unassignedExpanded: action.expanded };
    case "toggle-unassigned":
      return { ...state, unassignedExpanded: !state.unassignedExpanded };
    case "reset":
      return createWorkspaceLayoutState(action.state);
  }
}

export type WorkspaceLayoutCssVariables = CSSProperties & {
  "--route-pane-width": string;
  "--route-pane-left-occlusion": string;
  "--route-pane-layout-progress": number;
};

export function workspaceLayoutCssVariables(
  state: WorkspaceLayoutState,
  options: { outerGutter?: number; snapPoints?: RoutePaneSnapPoints } = {},
): WorkspaceLayoutCssVariables {
  const gutter = options.outerGutter ?? ROUTE_PANE_DEFAULTS.outerGutter;
  const points = options.snapPoints;
  const routePaneWidth = points
    ? clampRoutePaneWidth(state.routePaneWidth, points)
    : state.routePaneWidth;
  const totalRange = points ? points.fullscreen - points.routes : 0;
  const progress =
    points && totalRange > 0
      ? (routePaneWidth - points.routes) / totalRange
      : state.routePaneMode === "routes"
        ? 0
        : state.routePaneMode === "timeline"
          ? 0.5
          : 1;

  return {
    "--route-pane-width": `${routePaneWidth}px`,
    "--route-pane-left-occlusion": `${routePaneWidth + gutter}px`,
    "--route-pane-layout-progress": progress,
  };
}

export type WorkspaceLayoutStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): WorkspaceLayoutStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readPersistedWorkspaceLayout(
  storage: WorkspaceLayoutStorage | null = browserStorage(),
  key = WORKSPACE_LAYOUT_STORAGE_KEY,
): Partial<WorkspaceLayoutState> | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Record<string, unknown>;
    const result: Partial<WorkspaceLayoutState> = {};
    if (finiteNumber(candidate.routePaneWidth) && candidate.routePaneWidth >= 0) {
      result.routePaneWidth = candidate.routePaneWidth;
    }
    if (isRoutePaneMode(candidate.routePaneMode)) {
      result.routePaneMode = candidate.routePaneMode;
    }
    if (typeof candidate.unassignedExpanded === "boolean") {
      result.unassignedExpanded = candidate.unassignedExpanded;
    }
    return Object.keys(result).length ? result : null;
  } catch {
    return null;
  }
}

export function writePersistedWorkspaceLayout(
  state: WorkspaceLayoutState,
  storage: WorkspaceLayoutStorage | null = browserStorage(),
  key = WORKSPACE_LAYOUT_STORAGE_KEY,
) {
  if (!storage) return false;
  try {
    storage.setItem(
      key,
      JSON.stringify({
        routePaneWidth: state.routePaneWidth,
        routePaneMode: state.routePaneMode,
        unassignedExpanded: state.unassignedExpanded,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearPersistedWorkspaceLayout(
  storage: WorkspaceLayoutStorage | null = browserStorage(),
  key = WORKSPACE_LAYOUT_STORAGE_KEY,
) {
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
