"use client";

import {
  dispatchReviewInteractionReducer,
  initialDispatchReviewInteractionState,
} from "./review-interaction";
import type { DispatchReviewRouteSort } from "./review-interaction";
import { useSearchParams } from "next/navigation";
import { useCallback, useReducer, useState } from "react";
import { engineerRegions } from "@/modules/engineers/domain";
import { routeRegion } from "../model/regions";
import type { RouteFilterRegion } from "../model/regions";
import { resolveRequestedReviewDate } from "../model/review";
import type { ScheduledVisit } from "@/modules/work/contracts";
import type { RailJobTooltipState, RailOverviewTooltipState } from "../ui/RailTooltips";
import { useWorkspaceLayout } from "../ui/workspace/use-workspace-layout";
import type { RoutePaneMode, WorkspaceTool } from "../ui/workspace/workspace-layout";

export type DispatchReviewMapTool = WorkspaceTool;
type BooleanStateUpdate = boolean | ((current: boolean) => boolean);
type RoutePaneResizeResult = { width: number; mode: RoutePaneMode };

/** Local controller for Dispatch Review URL, selection, filter and overlay state. */
export function useDispatchReviewController() {
  const searchParams = useSearchParams();
  const requestedDate = searchParams.get("date");
  const requestedView = searchParams.get("view");
  const [interaction, dispatchInteraction] = useReducer(
    dispatchReviewInteractionReducer,
    resolveRequestedReviewDate(requestedDate),
    initialDispatchReviewInteractionState,
  );
  const workspaceLayout = useWorkspaceLayout({
    initialState: {
      routePaneMode:
        requestedView === "timeline" || requestedView === "split"
          ? "timeline"
          : "routes",
      routePaneWidth:
        requestedView === "timeline" || requestedView === "split" ? 760 : 284,
    },
  });
  const {
    state: workspaceLayoutState,
    dispatch: dispatchWorkspaceLayout,
    snapPoints: routePaneSnapPoints,
    snapRoutePane,
    setActiveTool,
    setUnassignedExpanded,
  } = workspaceLayout;
  const [mapRailVisible, setMapRailVisible] = useState(false);
  const [routesOpen, setRoutesOpen] = useState(false);
  const [railJobTooltip, setRailJobTooltip] = useState<RailJobTooltipState | null>(null);
  const [railOverviewTooltip, setRailOverviewTooltip] = useState<RailOverviewTooltipState | null>(null);
  const [mapPopupOpen, setMapPopupOpen] = useState(false);
  const [keyboardControlsActive, setKeyboardControlsActive] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [collapsedRouteRegions, setCollapsedRouteRegions] = useState<
    Set<ReturnType<typeof routeRegion>>
  >(() => new Set([...engineerRegions, "Third-party", "Unassigned"]));
  const activeMapTool = workspaceLayoutState.activeTool;
  const timelineOpen = workspaceLayoutState.routePaneMode !== "routes";

  const replaceWorkspaceUrl = useCallback((nextDate: string, view: string) => {
    const nextParams = new URLSearchParams(window.location.search);
    nextParams.set("date", nextDate);
    nextParams.set("view", view);
    window.history.replaceState(null, "", `/?${nextParams.toString()}`);
  }, []);

  const updateMapTool = useCallback(
    (tool: DispatchReviewMapTool, update: BooleanStateUpdate) => {
      const isOpen = activeMapTool === tool;
      const shouldOpen = typeof update === "function" ? update(isOpen) : update;
      setActiveTool(shouldOpen ? tool : isOpen ? null : activeMapTool);
    },
    [activeMapTool, setActiveTool],
  );
  const setPanelOpen = useCallback(
    (update: BooleanStateUpdate) => updateMapTool("notifications", update),
    [updateMapTool],
  );
  const setFiltersOpen = useCallback(
    (update: BooleanStateUpdate) => updateMapTool("filters", update),
    [updateMapTool],
  );
  const toggleIssuesOverlay = useCallback(() => {
    setFiltersOpen(false);
    setPanelOpen((current) => !current);
  }, [setFiltersOpen, setPanelOpen]);
  const dismissMapTools = useCallback(() => {
    setActiveTool(null);
  }, [setActiveTool]);

  const clearReviewSelection = useCallback(() => dispatchInteraction({ type: "clear-selection" }), []);
  const fitVisibleMarkers = useCallback(() => dispatchInteraction({ type: "fit-visible" }), []);
  const focusRoute = useCallback((routeId: string, visitId: string | null = null) => {
    dispatchInteraction({ type: "focus-route", routeId, visitId });
  }, []);
  const focusMapDemand = useCallback((demandId: string, routeId: string | null) => {
    dispatchInteraction({ type: "focus-map-demand", demandId, routeId });
  }, []);
  const focusRailDemand = useCallback((
    demandId: string,
    context: { routeId: string; anchorVisitId: string } | null,
  ) => {
    dispatchInteraction({
      type: "focus-rail-demand",
      demandId,
      routeId: context?.routeId ?? null,
      anchorVisitId: context?.anchorVisitId ?? null,
    });
  }, []);
  const focusTimelineSuggestion = useCallback((
    demandId: string,
    routeId: string,
    anchorVisitId: string | null = null,
  ) => {
    dispatchInteraction({
      type: "focus-timeline-suggestion",
      demandId,
      routeId,
      anchorVisitId,
    });
  }, []);
  const showUnassigned = useCallback(() => dispatchInteraction({ type: "show-unassigned" }), []);
  const showNearbySuggestions = useCallback(() => {
    dispatchInteraction({ type: "show-nearby-suggestions" });
    setUnassignedExpanded(true);
    setPanelOpen(false);
  }, [setPanelOpen, setUnassignedExpanded]);
  const preserveLoadedVisitSelection = useCallback((nextSnapshot: Pick<{ visits: ScheduledVisit[] }, "visits">) => {
    dispatchInteraction({
      type: "preserve-loaded-visit",
      visitIds: new Set(nextSnapshot.visits.map((visit) => visit.id)),
    });
  }, []);
  const toggleOpenVisits = useCallback((selectedVisitIsComplete: boolean | null | undefined) => {
    dispatchInteraction({ type: "toggle-open-visits", selectedVisitIsComplete });
  }, []);
  const toggleCompleteVisits = useCallback((selectedVisitIsComplete: boolean | null | undefined) => {
    dispatchInteraction({ type: "toggle-complete-visits", selectedVisitIsComplete });
  }, []);
  const toggleThirdParty = useCallback(() => dispatchInteraction({ type: "toggle-third-party" }), []);
  const toggleReadyToBook = useCallback(() => dispatchInteraction({ type: "toggle-ready-to-book" }), []);
  const setSuggestionRadius = useCallback((radiusKm: number) => dispatchInteraction({ type: "set-suggestion-radius", radiusKm }), []);
  const previewRoute = useCallback((routeId: string | null) => dispatchInteraction({ type: "set-hovered-route", routeId }), []);
  const selectRegions = useCallback((regions: Set<RouteFilterRegion>) => dispatchInteraction({ type: "set-regions", regions }), []);
  const toggleRouteRegion = useCallback((region: RouteFilterRegion) => dispatchInteraction({ type: "toggle-region", region }), []);
  const updateEngineerQuery = useCallback((query: string) => dispatchInteraction({ type: "set-engineer-query", query }), []);
  const clearEngineerQuery = useCallback(() => dispatchInteraction({ type: "clear-engineer-query" }), []);
  const selectEngineerFilter = useCallback((routeId: string, resourceName = "") => dispatchInteraction({ type: "select-engineer-filter", routeId, resourceName }), []);
  const setEngineerPickerOpen = useCallback((open: boolean) => dispatchInteraction({ type: "set-engineer-picker-open", open }), []);
  const setRouteSort = useCallback((sort: DispatchReviewRouteSort) => dispatchInteraction({ type: "set-route-sort", sort }), []);
  const openVisitDetails = useCallback((visitId: string | null) => dispatchInteraction({ type: "open-visit-details", visitId }), []);
  const openDemandDetails = useCallback((demandId: string | null) => dispatchInteraction({ type: "open-demand-details", demandId }), []);
  const showRailJobTooltip = useCallback((tooltip: RailJobTooltipState) => {
    setRailOverviewTooltip(null);
    setRailJobTooltip(tooltip);
  }, []);
  const showRailOverviewTooltip = useCallback((tooltip: RailOverviewTooltipState) => {
    setRailJobTooltip(null);
    setRailOverviewTooltip(tooltip);
  }, []);
  const hideRailJobTooltip = useCallback(() => setRailJobTooltip(null), []);
  const hideRailOverviewTooltip = useCallback(() => setRailOverviewTooltip(null), []);
  const clearRailTooltips = useCallback(() => {
    setRailJobTooltip(null);
    setRailOverviewTooltip(null);
  }, []);
  const setMapPopupVisibility = useCallback((open: boolean) => {
    setMapPopupOpen(open);
    if (open) {
      setRailJobTooltip(null);
      setRailOverviewTooltip(null);
    }
  }, []);
  const toggleCollapsedRouteRegion = useCallback((region: ReturnType<typeof routeRegion>) => {
    setCollapsedRouteRegions((current) => {
      const next = new Set(current);
      if (next.has(region)) next.delete(region);
      else next.add(region);
      return next;
    });
  }, []);
  const resetReviewFilters = useCallback(() => dispatchInteraction({ type: "reset-review-filters" }), []);

  const setTimelineOpen = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setActiveTool(null);
        setRoutesOpen(true);
      } else {
        setRailJobTooltip(null);
        setRailOverviewTooltip(null);
      }
      snapRoutePane(nextOpen ? "timeline" : "routes");
      replaceWorkspaceUrl(interaction.date, nextOpen ? "timeline" : "map");
    },
    [interaction.date, replaceWorkspaceUrl, setActiveTool, snapRoutePane],
  );

  const cycleRoutePaneMode = useCallback(() => {
    const routePaneMode = workspaceLayoutState.routePaneMode;
    const nextMode: RoutePaneMode =
      routePaneMode === "routes" ? "timeline" : routePaneMode === "timeline" ? "fullscreen" : "routes";
    setActiveTool(null);
    setRoutesOpen(true);
    if (nextMode === "routes") {
      setRailJobTooltip(null);
      setRailOverviewTooltip(null);
    }
    snapRoutePane(nextMode);
    replaceWorkspaceUrl(interaction.date, nextMode === "routes" ? "map" : "timeline");
    return nextMode;
  }, [interaction.date, replaceWorkspaceUrl, setActiveTool, snapRoutePane, workspaceLayoutState.routePaneMode]);

  const changeDate = useCallback(
    (nextDate: string) => {
      if (nextDate === interaction.date) return;
      dispatchInteraction({ type: "change-date", date: nextDate });
      setFiltersOpen(false);
      replaceWorkspaceUrl(nextDate, timelineOpen ? "timeline" : "map");
    },
    [interaction.date, replaceWorkspaceUrl, setFiltersOpen, timelineOpen],
  );

  const openReviewOverlay = useCallback((update: BooleanStateUpdate) => {
    setTimelineOpen(false);
    setRoutesOpen(false);
    setPanelOpen(update);
  }, [setPanelOpen, setTimelineOpen]);

  const openFiltersOverlay = useCallback((update: BooleanStateUpdate) => {
    setTimelineOpen(false);
    setRoutesOpen(false);
    setFiltersOpen(update);
  }, [setFiltersOpen, setTimelineOpen]);

  const focusRoutesRail = useCallback(() => {
    setActiveTool(null);
    if (!mapRailVisible && routesOpen) {
      setRoutesOpen(false);
      return false;
    }
    setRoutesOpen(true);
    return true;
  }, [mapRailVisible, routesOpen, setActiveTool]);

  const showRailCategory = useCallback((
    nextIndex: number,
    regions: readonly ReturnType<typeof routeRegion>[],
  ) => {
    setUnassignedExpanded(nextIndex === 0);
    setCollapsedRouteRegions(new Set(regions.filter((_, index) => index + 1 !== nextIndex)));
    setRoutesOpen(true);
    setTimelineOpen(false);
  }, [setTimelineOpen, setUnassignedExpanded]);

  const toggleAllRailSections = useCallback((
    regions: readonly ReturnType<typeof routeRegion>[],
    allCollapsed: boolean,
  ) => {
    setUnassignedExpanded(allCollapsed);
    setCollapsedRouteRegions(allCollapsed ? new Set() : new Set(regions));
  }, [setUnassignedExpanded]);

  const updateRoutePaneFromResize = useCallback(
    (result: RoutePaneResizeResult) => {
      if (result.mode === "routes") clearRailTooltips();
      dispatchWorkspaceLayout({
        type: "set-route-pane",
        width: result.width,
        mode: result.mode,
        snapPoints: routePaneSnapPoints,
      });
    },
    [clearRailTooltips, dispatchWorkspaceLayout, routePaneSnapPoints],
  );

  const finishRoutePaneResize = useCallback(
    (result: RoutePaneResizeResult) => {
      updateRoutePaneFromResize(result);
      replaceWorkspaceUrl(interaction.date, result.mode === "routes" ? "map" : "timeline");
    },
    [interaction.date, replaceWorkspaceUrl, updateRoutePaneFromResize],
  );

  return {
    workspaceLayout,
    activeMapTool,
    timelineOpen,
    updateMapTool,
    setPanelOpen,
    setFiltersOpen,
    toggleIssuesOverlay,
    dismissMapTools,
    clearReviewSelection,
    fitVisibleMarkers,
    focusRoute,
    focusMapDemand,
    focusRailDemand,
    focusTimelineSuggestion,
    showUnassigned,
    showNearbySuggestions,
    preserveLoadedVisitSelection,
    toggleOpenVisits,
    toggleCompleteVisits,
    toggleThirdParty,
    toggleReadyToBook,
    setSuggestionRadius,
    previewRoute,
    selectRegions,
    toggleRouteRegion,
    updateEngineerQuery,
    clearEngineerQuery,
    selectEngineerFilter,
    setEngineerPickerOpen,
    setRouteSort,
    openVisitDetails,
    openDemandDetails,
    showRailJobTooltip,
    showRailOverviewTooltip,
    hideRailJobTooltip,
    hideRailOverviewTooltip,
    clearRailTooltips,
    setMapPopupVisibility,
    toggleCollapsedRouteRegion,
    openReviewOverlay,
    openFiltersOverlay,
    focusRoutesRail,
    showRailCategory,
    toggleAllRailSections,
    resetReviewFilters,
    setTimelineOpen,
    cycleRoutePaneMode,
    changeDate,
    updateRoutePaneFromResize,
    finishRoutePaneResize,
    ...interaction,
    mapRailVisible,
    setMapRailVisible,
    routesOpen,
    setRoutesOpen,
    railJobTooltip,
    railOverviewTooltip,
    mapPopupOpen,
    keyboardControlsActive,
    setKeyboardControlsActive,
    shortcutsOpen,
    setShortcutsOpen,
    collapsedRouteRegions,
  };
}
