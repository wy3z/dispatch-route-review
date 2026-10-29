"use client";

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  createWorkspaceLayoutState,
  getRoutePaneSnapPoints,
  readPersistedWorkspaceLayout,
  workspaceLayoutCssVariables,
  workspaceLayoutReducer,
  writePersistedWorkspaceLayout,
} from "./workspace-layout";
import type {
  RoutePaneMode,
  RoutePaneSnapConfig,
  WorkspaceLayoutState,
  WorkspaceTool,
} from "./workspace-layout";

export type UseWorkspaceLayoutOptions = {
  initialState?: Partial<WorkspaceLayoutState>;
  persistenceKey?: string;
  persist?: boolean;
  snapConfig?: RoutePaneSnapConfig;
  viewportWidth?: number;
};

const SSR_VIEWPORT_WIDTH = 1440;

function initialViewportWidth(explicitWidth?: number) {
  if (explicitWidth !== undefined) return explicitWidth;
  // SSR fallback only. window.innerWidth here would diverge snap points on hydrate.
  return SSR_VIEWPORT_WIDTH;
}

export function useWorkspaceLayout(options: UseWorkspaceLayoutOptions = {}) {
  // Capture persistence config once so a resize cannot overwrite an in-progress drag.
  const [persistenceOptions] = useState(() => ({
    initialState: options.initialState,
    key: options.persistenceKey,
    persist: options.persist,
    snapConfig: options.snapConfig,
    viewportWidth: options.viewportWidth,
  }));
  const [viewportWidth, setViewportWidth] = useState(() =>
    initialViewportWidth(options.viewportWidth),
  );
  const measuredViewportWidth = options.viewportWidth ?? viewportWidth;
  const snapConfig = options.snapConfig;
  const snapPoints = useMemo(
    () => getRoutePaneSnapPoints(measuredViewportWidth, snapConfig),
    [measuredViewportWidth, snapConfig],
  );
  const [state, dispatch] = useReducer(
    workspaceLayoutReducer,
    options.initialState ?? {},
    (initial) => createWorkspaceLayoutState(initial, snapPoints),
  );
  const [storageHydrated, setStorageHydrated] = useState(
    persistenceOptions.persist === false,
  );

  useEffect(() => {
    if (options.viewportWidth !== undefined) return;
    const updateViewport = () => {
      const nextViewportWidth = window.innerWidth;
      setViewportWidth(nextViewportWidth);
      dispatch({
        type: "fit-route-pane-to-snap-points",
        snapPoints: getRoutePaneSnapPoints(nextViewportWidth, snapConfig),
      });
    };
    queueMicrotask(updateViewport);
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, [options.viewportWidth, snapConfig]);

  useEffect(() => {
    if (persistenceOptions.persist === false) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const persisted = readPersistedWorkspaceLayout(
        undefined,
        persistenceOptions.key,
      );
      const initialMode = persistenceOptions.initialState?.routePaneMode;
      const state =
        initialMode && persisted?.routePaneMode !== initialMode
          ? {
              ...persisted,
              routePaneMode: initialMode,
              routePaneWidth:
                persistenceOptions.initialState?.routePaneWidth ??
                getRoutePaneSnapPoints(
                  persistenceOptions.viewportWidth ?? window.innerWidth,
                  persistenceOptions.snapConfig,
                )[initialMode],
            }
          : persisted;
      dispatch({
        type: "hydrate",
        state,
        snapPoints: getRoutePaneSnapPoints(
          persistenceOptions.viewportWidth ?? window.innerWidth,
          persistenceOptions.snapConfig,
        ),
      });
      setStorageHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [persistenceOptions]);

  useEffect(() => {
    if (!storageHydrated || persistenceOptions.persist === false) return;
    writePersistedWorkspaceLayout(state, undefined, persistenceOptions.key);
  }, [persistenceOptions, state, storageHydrated]);

  const snapRoutePane = useCallback(
    (mode?: RoutePaneMode) =>
      dispatch({ type: "snap-route-pane", mode, snapPoints }),
    [snapPoints],
  );
  const setActiveTool = useCallback(
    (tool: WorkspaceTool | null) => dispatch({ type: "set-active-tool", tool }),
    [],
  );
  const toggleTool = useCallback(
    (tool: WorkspaceTool) => dispatch({ type: "toggle-tool", tool }),
    [],
  );
  const setUnassignedExpanded = useCallback(
    (expanded: boolean) =>
      dispatch({ type: "set-unassigned-expanded", expanded }),
    [],
  );

  const cssVariables = useMemo(
    () => workspaceLayoutCssVariables(state, { snapPoints }),
    [snapPoints, state],
  );

  return {
    state,
    dispatch,
    snapPoints,
    cssVariables,
    snapRoutePane,
    setActiveTool,
    toggleTool,
    setUnassignedExpanded,
  };
}
