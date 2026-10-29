"use client";

import { DispatchTimeline } from "./DispatchTimeline";
import { RouteRailTimeline } from "./RouteRailTimeline";

import { useReviewKeyboard } from "../state/use-review-keyboard";
import { useReviewModel } from "../state/use-review-model";
import { Suspense, useCallback, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MapLegend, ReviewMap } from "@/modules/map/client";
import { reviewMapSelection } from "@/modules/map/domain";
import type { ReviewMapAction } from "@/modules/map/contracts";
import { ServiceCallDetail } from "./ServiceCallDetail";
import { DemandTicketDetail } from "./DemandTicketDetail";
import { AppHeader } from "../../../shared/ui/AppHeader";
import { DispatchDatePicker } from "./DispatchDatePicker";
import { DispatchReviewPanel } from "./DispatchReviewPanel";
import { EngineerRouteRail } from "./EngineerRouteRail";
import { RouteScopeControls } from "./RouteScopeControls";
import { RouteSummaryCards } from "./RouteSummaryCards";
import { useDispatchReviewData } from "../state/use-dispatch-review-data";
import { useEngineerRoster } from "@/modules/engineers/client";
import { useDispatchReviewController } from "../state/use-dispatch-review-controller";
import type { DispatchReviewMapTool } from "../state/use-dispatch-review-controller";
import { RailJobTooltip, RailOverviewTooltip, railTooltipPosition } from "./RailTooltips";
import type { RailOverviewTooltipState } from "./RailTooltips";
import {
  WorkspaceMotionProvider,
  useWorkspaceMotionTransition,
  workspaceDockPanelMotion,
} from "./workspace/workspace-motion";
import { routeFilterRegions } from "../model/regions";
import type { RouteFilterRegion } from "../model/regions";
import { routeTimingForStop } from "@/modules/routing/domain";
import type { EngineerRoute, RouteIssue } from "@/modules/routing/contracts";

function DispatchReviewContent({
  canAccessAdmin,
  canManageEngineers,
}: {
  canAccessAdmin: boolean;
  canManageEngineers: boolean;
}) {
  const controller = useDispatchReviewController();
  const {
    workspaceLayout,
    activeMapTool,
    timelineOpen,
    updateMapTool,
    setPanelOpen,
    setFiltersOpen,
    toggleIssuesOverlay,
    clearReviewSelection,
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
    focusRoutesRail,
    resetReviewFilters,
    cycleRoutePaneMode,
    changeDate,
    updateRoutePaneFromResize,
    finishRoutePaneResize,
    date,
    mapRailVisible,
    setMapRailVisible,
    routesOpen,
    showThirdParty,
    showReadyToBook,
    suggestionRadiusKm,
    focusedDemandId,
    showOpenVisits,
    showCompleteVisits,
    selectedRouteId,
    hoveredRouteId,
    routeFocusToken,
    visibleMarkerFitToken,
    railJobTooltip,
    railOverviewTooltip,
    mapPopupOpen,
    selectionClearToken,
    engineerFilterRouteId,
    selectedVisitId,
    keyboardControlsActive,
    setKeyboardControlsActive,
    shortcutsOpen,
    setShortcutsOpen,
    selectedRegions,
    engineerQuery,
    engineerPickerOpen,
    collapsedRouteRegions,
    routeSort,
  } = controller;
  const {
    state: workspaceLayoutState,
    snapPoints: routePaneSnapPoints,
    cssVariables: workspaceLayoutCssVariables,
    setActiveTool,
  } = workspaceLayout;
  const routePaneMode = workspaceLayoutState.routePaneMode;
  const routePaneWidth = workspaceLayoutState.routePaneWidth;
  const workspacePanelTransition = useWorkspaceMotionTransition();
  const pageRef = useRef<HTMLElement>(null);
  const mapToolsRef = useRef<HTMLDivElement>(null);
  const reviewPanelRef = useRef<HTMLElement>(null);
  const keyboardNavigationRef = useRef(false);
  const reverseRailExpansionRef = useRef<HTMLButtonElement | null>(null);
  const changeDateRef = useRef<(nextDate: string) => void>(() => undefined);
  const mapToolTriggerRefs = useRef<
    Partial<Record<DispatchReviewMapTool, HTMLButtonElement>>
  >({});
  const panelOpen = activeMapTool === "notifications";
  const filtersOpen = activeMapTool === "filters";

  useEffect(() => {
    const markKeyboardNavigation = () => {
      keyboardNavigationRef.current = true;
      setKeyboardControlsActive(true);
    };
    const markPointerNavigation = () => {
      keyboardNavigationRef.current = false;
      setKeyboardControlsActive(false);
    };
    window.addEventListener("keydown", markKeyboardNavigation, true);
    window.addEventListener("pointerdown", markPointerNavigation, true);
    return () => {
      window.removeEventListener("keydown", markKeyboardNavigation, true);
      window.removeEventListener("pointerdown", markPointerNavigation, true);
    };
  }, [setKeyboardControlsActive]);

  const routeRailRef = useRef<HTMLElement>(null);
  const {
    snapshot,
    loading,
    loadError,
    demandSnapshot: readyToBookSnapshot,
    suggestionContext,
    demandLoading: readyToBookLoading,
    demandWarming: readyToBookWarming,
    demandError: readyToBookError,
  } = useDispatchReviewData({
    date,
    onScheduleLoaded: preserveLoadedVisitSelection,
  });
  const {
    engineers,
    loading: engineerRosterLoading,
    error: engineerRosterError,
  } = useEngineerRoster();

  useEffect(() => {
    const media = window.matchMedia("(min-width: 901px)");
    const sync = () => setMapRailVisible(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [setMapRailVisible]);
  const model = useReviewModel({controller, snapshot, engineers, readyToBookSnapshot, readyToBookLoading, suggestionContext});
  const {
    statusCounts,
    thirdPartyVisitCount,
    canonicalRoutes,
    roadRoutes,
    issues,
    roadLoading,
    regionOptions,
    regionCounts,
    allRegionsSelected,
    regionSelectValue,
    totalRegionCounts,
    regionRoutes,
    readyToBookItems,
    demandById,
    routeSuggestions,
    suggestionDemandIds,
    suggestionContexts,
    mapDemandItems,
    mapFocusedDemandId,
    issueVisitIds,
    selectedRouteHasNoCalls,
    engineerOptions,
    timelineRoutes,
    timelineCanonicalRoutes,
    focusedOutsideFilters,
    roadById,
    canonicalRouteById,
    visitById,
    mapScene,
    focusedSuggestion,
    timelineSuggestions,
    detailVisit,
    detailDemand,
    detailVisitRoute,
    criticalIssues,
    issueCountsByRoute,
    routesNeedingAttention,
    sortedVisibleRoutes,
    suggestionCountsByRoute,
    reviewStats,
    railRouteGroups,
    issuesByVisitId,
    compactSummaryRoutes,
    routeSummaryGroups,
    reviewFiltersActive,
    activeFilterCount,
  } = model;
  const openRailJobTooltip = useCallback((
    element: HTMLElement,
    route: EngineerRoute,
    stop: EngineerRoute["stops"][number],
  ) => {
    if (mapPopupOpen) return;
    const canonicalRoute = canonicalRouteById.get(route.id) ?? route;
    const canonicalStop = canonicalRoute.stops.find((candidate) => candidate.id === stop.id) ?? stop;
    showRailJobTooltip({
      route: canonicalRoute,
      stop: canonicalStop,
      timing: routeTimingForStop(canonicalRoute, roadById.get(canonicalRoute.id), canonicalStop),
      issues: issuesByVisitId.get(stop.id) ?? [],
      ...railTooltipPosition(element.getBoundingClientRect(), routeRailRef.current?.getBoundingClientRect(), {
        width: window.innerWidth, height: window.innerHeight,
      }),
    });
  }, [canonicalRouteById, issuesByVisitId, mapPopupOpen, roadById, showRailJobTooltip]);

  const openRailOverviewTooltip = useCallback((
    element: HTMLElement,
    overview: Omit<RailOverviewTooltipState, "left" | "top">,
  ) => {
    if (mapPopupOpen) return;
    showRailOverviewTooltip({
      ...overview,
      ...railTooltipPosition(element.getBoundingClientRect(), routeRailRef.current?.getBoundingClientRect(), {
        width: window.innerWidth, height: window.innerHeight,
      }),
    });
  }, [mapPopupOpen, showRailOverviewTooltip]);

  useEffect(() => {
    if (!railJobTooltip && !railOverviewTooltip) return;
    window.addEventListener("resize", clearRailTooltips);
    window.addEventListener("scroll", clearRailTooltips, true);
    return () => {
      window.removeEventListener("resize", clearRailTooltips);
      window.removeEventListener("scroll", clearRailTooltips, true);
    };
  }, [clearRailTooltips, railJobTooltip, railOverviewTooltip]);
  useReviewKeyboard({controller, model, routeRailRef, reverseRailExpansionRef, changeDateRef});

  useEffect(() => {
    if (!activeMapTool) return;
    function closeMapToolsOnOutsidePress(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !mapToolsRef.current?.contains(event.target) &&
        !reviewPanelRef.current?.contains(event.target)
      ) {
        setActiveTool(null);
      }
    }
    document.addEventListener("pointerdown", closeMapToolsOnOutsidePress);
    return () => {
      document.removeEventListener("pointerdown", closeMapToolsOnOutsidePress);
    };
  }, [activeMapTool, setActiveTool]);

  const focusIssue = useCallback((issue: RouteIssue) => {
    focusRoute(issue.routeId, issue.visitId);
  }, [focusRoute]);

  const focusRouteCard = useCallback((route: EngineerRoute, visitId: string | null = null) => {
    focusRoute(route.id, visitId);
  }, [focusRoute]);

  useEffect(() => {
    changeDateRef.current = changeDate;
  }, [changeDate]);

  const handleMapAction = useCallback((action: ReviewMapAction) => {
    switch (action.type) {
      case "select-route": return focusRoute(action.routeId);
      case "preview-route": return previewRoute(action.routeId);
      case "select-visit": return focusRoute(action.routeId, action.visitId);
      case "select-demand": {
        const nearbyRouteId = suggestionContexts[action.demandId]?.routeId;
        return focusMapDemand(action.demandId, nearbyRouteId ?? null);
      }
      case "clear-selection": return clearReviewSelection();
      case "open-visit": return openVisitDetails(action.visitId);
      case "open-demand": return openDemandDetails(action.demandId);
      case "popup-visibility":
        setMapPopupVisibility(action.open);
    }
  }, [clearReviewSelection, focusMapDemand, focusRoute, openDemandDetails, openVisitDetails, previewRoute, setMapPopupVisibility, suggestionContexts]);

  return (
    <WorkspaceMotionProvider>
    <main
      ref={pageRef}
      className="dispatch-review-page workspace-map"
      style={workspaceLayoutCssVariables}
      data-route-pane-mode={routePaneMode}
      data-unassigned-expanded={workspaceLayoutState.unassignedExpanded}
      data-keyboard-navigation={keyboardControlsActive || undefined}
    >
      <AppHeader
        active="dispatch"
        canAccessDispatch
        canAccessAdmin={canAccessAdmin}
        canManageEngineers={canManageEngineers}
        keyboardShortcutsOpen={shortcutsOpen}
        onKeyboardShortcutsChange={setShortcutsOpen}
        cacheGeneratedAt={snapshot?.generatedAt ?? null}
      />

      {loadError && (
        <section className="error-banner">
          <strong>The schedule cache could not be loaded.</strong>
          <span>{loadError}</span>
        </section>
      )}
      {!engineerRosterLoading && engineerRosterError ? (
        <section className="error-banner">
          <strong>The engineer roster could not be loaded.</strong>
          <span>{engineerRosterError}</span>
        </section>
      ) : null}

      <section className={`route-overview${activeMapTool ? " tools-open" : ""}`}>
        <article className={`metric-action-card${routesNeedingAttention ? " metric-alert" : ""}`}>
          <button
            type="button"
            className="route-overview-metric"
            aria-label={`Open ${routesNeedingAttention} route issues`}
            onClick={() => {
              setPanelOpen(true);
            }}
          >
            <span>Routes needing attention</span>
            <strong>{roadLoading ? "…" : snapshot ? routesNeedingAttention : "—"}</strong>
            <small className="metric-context">of {canonicalRoutes.length} booked routes</small>
          </button>
        </article>
        <article className={`metric-action-card${criticalIssues ? " metric-alert" : ""}`}>
          <button
            type="button"
            className="route-overview-metric"
            aria-label={`Open ${criticalIssues} critical issues`}
            onClick={() => {
              setPanelOpen(true);
            }}
          >
            <span>Critical conflicts</span>
            <strong>{roadLoading ? "…" : snapshot ? criticalIssues : "—"}</strong>
            <small className="metric-context">{issues.length - criticalIssues} warnings / data gaps</small>
          </button>
        </article>
        <article className="metric-action-card">
          <button
            type="button"
            className="route-overview-metric"
            aria-label={`Show ${readyToBookItems.length} unassigned requests on the map`}
            onClick={() => {
              showUnassigned();
            }}
          >
            <span>Unassigned</span>
            <strong>{readyToBookLoading ? "…" : readyToBookItems.length}</strong>
            <small className="metric-context">cached unassigned requests</small>
          </button>
        </article>
        <article className="metric-opportunity metric-action-card">
          <button
            type="button"
            className="route-overview-metric"
            aria-label={`Show ${routeSuggestions.length} nearby suggestions in Unassigned`}
            onClick={() => {
              showNearbySuggestions();
            }}
          >
            <span>Nearby suggestions</span>
            <strong>{readyToBookLoading ? "…" : routeSuggestions.length}</strong>
            <small className="metric-context">straight-line proximity hints</small>
          </button>
        </article>
        <div className="route-overview-controls">
          <div className="dispatch-map-tools" ref={mapToolsRef}>
          <div
            className="dispatch-map-tools-tabs map-glass-surface map-glass-anchor"
            role="toolbar"
            aria-label="Map tools"
            data-map-shortcut-scope="map-tools"
          >
          <button
            type="button"
            id="map-tool-date"
            className="route-overview-date-button"
            data-map-tool="date"
            ref={(element) => {
              if (element) mapToolTriggerRefs.current.date = element;
            }}
            aria-label={`Date, ${date}`}
            aria-keyshortcuts="c"
            aria-expanded={activeMapTool === "date"}
            aria-controls="map-tools-panel"
            onClick={() => updateMapTool("date", (current) => !current)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5.5 2.8v2.6M14.5 2.8v2.6M3.3 7.1h13.4M4.5 4.2h11a1.7 1.7 0 0 1 1.7 1.7v9.4a1.7 1.7 0 0 1-1.7 1.7h-11a1.7 1.7 0 0 1-1.7-1.7V5.9a1.7 1.7 0 0 1 1.7-1.7Z" />
            </svg>
            <span>{date.split("-").reverse().join("/")}</span>
          </button>
          <button
            type="button"
            className="dispatch-routes-trigger"
            aria-label="Focus engineer timeline"
            aria-keyshortcuts="t"
            aria-expanded={mapRailVisible || routesOpen}
            onClick={() => {
              if (!focusRoutesRail()) return;
              window.requestAnimationFrame(() =>
                routeRailRef.current
                  ?.querySelector<HTMLButtonElement>("button:not([disabled])")
                  ?.focus(),
              );
            }}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 5h12M4 10h12M4 15h12" />
            </svg>
            <span>Routes</span>
          </button>
          <div className="dispatch-filter-menu">
            <button
              ref={(element) => {
                if (element) mapToolTriggerRefs.current.filters = element;
              }}
              id="map-tool-filters"
              className="dispatch-filter-trigger"
              type="button"
              data-map-tool="filters"
              aria-label="Map filters"
              aria-expanded={filtersOpen}
              aria-controls="map-tools-panel"
              aria-keyshortcuts="f"
              onClick={() => setFiltersOpen((current) => !current)}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M3 4h14l-5.4 6.2v4.5l-3.2 1.6v-6.1L3 4Z" />
              </svg>
              <span>Filters</span>
              {activeFilterCount ? <b>{activeFilterCount}</b> : null}
            </button>
            <AnimatePresence>
            {filtersOpen ? (
              <motion.div
                {...workspaceDockPanelMotion}
                transition={workspacePanelTransition}
                className="dispatch-filter-popover dispatch-map-tools-panel map-glass-surface"
                id="map-tools-panel"
                aria-label="Map filters"
                aria-labelledby="map-tool-filters"
                data-map-shortcut-scope="filters"
                data-map-tool-content="filters"
              >
                <header>
                  <div>
                    <strong>Map filters</strong>
                  </div>
                  <button
                    className="dispatch-filter-reset"
                    type="button"
                    disabled={!reviewFiltersActive}
                    aria-label="Reset map filters"
                    onClick={resetReviewFilters}
                  >
                    Reset
                  </button>
                </header>
                <RouteScopeControls
                  regions={regionOptions}
                  selectedRegions={selectedRegions}
                  counts={regionCounts}
                  onToggle={toggleRouteRegion}
                />
                <fieldset
                  className="dispatch-filter-layers"
                  data-keyboard-group="layers"
                >
                  <legend>Visible map layers</legend>
                  <button
                    type="button"
                    data-filter-item
                    aria-pressed={showOpenVisits}
                    onClick={() => {
                      toggleOpenVisits(
                        selectedVisitId
                          ? visitById.get(selectedVisitId)?.isComplete ?? null
                          : null,
                      );
                    }}
                  >
                    <i className="filter-dot open" /> Open <b>{statusCounts.open}</b>
                  </button>
                  <button
                    type="button"
                    data-filter-item
                    aria-pressed={showCompleteVisits}
                    onClick={() => {
                      toggleCompleteVisits(
                        selectedVisitId
                          ? visitById.get(selectedVisitId)?.isComplete ?? null
                          : null,
                      );
                    }}
                  >
                    <i className="filter-dot complete" /> Complete <b>{statusCounts.complete}</b>
                  </button>
                  <button
                    type="button"
                    data-filter-item
                    aria-pressed={showThirdParty}
                    onClick={() => {
                      toggleThirdParty();
                    }}
                  >
                    <i className="filter-dot third-party" /> Third party <b>{thirdPartyVisitCount}</b>
                  </button>
                  <button
                    type="button"
                    data-filter-item
                    aria-pressed={showReadyToBook}
                    onClick={toggleReadyToBook}
                  >
                    <i className="filter-dot demand" /> Unassigned <b>{readyToBookItems.length || "—"}</b>
                  </button>
                </fieldset>
              </motion.div>
            ) : null}
            </AnimatePresence>
          </div>
          <div className="dispatch-review-menu">
            <button
              ref={(element) => {
                if (element) mapToolTriggerRefs.current.notifications = element;
              }}
              id="map-tool-notifications"
              className="dispatch-review-trigger"
              type="button"
              data-map-tool="notifications"
              aria-label={`Issues, ${issues.length}`}
              title="Issues are review prompts based on cached times, location data and static road travel—not confirmed problems."
              aria-expanded={panelOpen}
              aria-controls="map-tools-panel"
              aria-keyshortcuts="i"
              onClick={toggleIssuesOverlay}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10 3.2 17.4 16H2.6L10 3.2ZM10 8.2v3.4M10 14.2h.01" />
              </svg>
              <span>Issues</span>
              <i className={`review-count total${issues.length ? " has-issues" : ""}`}>
                {issues.length}
              </i>
            </button>
          </div>
          </div>
          <AnimatePresence>
          {activeMapTool === "date" ? (
            <motion.section
              {...workspaceDockPanelMotion}
              transition={workspacePanelTransition}
              className="dispatch-map-tools-panel dispatch-date-tools-panel map-glass-surface"
              id="map-tools-panel"
              aria-labelledby="map-tool-date"
              data-map-tool-content="date"
            >
              <DispatchDatePicker
                date={date}
                onChange={changeDate}
                onDismiss={() => {
                  setActiveTool(null);
                  window.requestAnimationFrame(() =>
                    mapToolTriggerRefs.current.date?.focus(),
                  );
                }}
              />
            </motion.section>
          ) : null}
          </AnimatePresence>
          </div>
        </div>
      </section>

      <section className="workspace dispatch-review-workspace view-map">
        <AnimatePresence>
        {panelOpen ? (
          <DispatchReviewPanel
            panelRef={reviewPanelRef}
            transition={workspacePanelTransition}
            issues={issues}
            visitById={visitById}
            selectedVisitId={selectedVisitId}
            bookedLoading={loading}
            scheduleLoaded={Boolean(snapshot)}
            onClose={() => {
              setPanelOpen(false);
              window.requestAnimationFrame(() =>
                mapToolTriggerRefs.current.notifications?.focus(),
              );
            }}
            onIssueFocus={focusIssue}
          />
        ) : null}
        </AnimatePresence>

        <section className="panel map-panel dispatch-review-map-surface">
          {!snapshot && !loading && mapDemandItems.length === 0 ? (
            <div className="map-empty">
              <strong>No route data is available.</strong>
              <span>Try another date or wait for the background refresh to complete.</span>
            </div>
          ) : (
            <>
              <div className="dispatch-map-stage">
              <div
                className="ready-to-book-status"
                id="ready-to-book-status"
                role="status"
              >
                {showReadyToBook && readyToBookLoading && (
                  <span>Loading unassigned requests…</span>
                )}
                {showReadyToBook && !readyToBookLoading && readyToBookWarming && (
                  <span>
                    The unassigned-work cache is warming. Try the layer again shortly.
                  </span>
                )}
                {showReadyToBook && !readyToBookLoading && !readyToBookWarming && readyToBookError && (
                  <span className="ready-to-book-error">{readyToBookError}</span>
                )}
              </div>
              <ReviewMap
                legend={<MapLegend showDemand={Boolean(readyToBookSnapshot)} hasExcludedDemand={readyToBookItems.some((item) => item.exclusionReason !== null)} />}
                scene={mapScene}
                selection={reviewMapSelection({ selectedRouteId, selectedVisitId, focusedDemandId: mapFocusedDemandId })}
                previewRouteId={hoveredRouteId}
                navigation={{
                  focusRequest: routeFocusToken,
                  fitVisibleRequest: visibleMarkerFitToken,
                  clearRequest: selectionClearToken,
                  initialFitReady: !loading && !readyToBookLoading,
                }}
                onAction={handleMapAction}
              />
              <EngineerRouteRail
                timeline={
                  <RouteRailTimeline
                    routePaneMode={routePaneMode}
                    snapshotGeneratedAt={snapshot?.generatedAt ?? null}
                    onCycleRoutePane={cycleRoutePaneMode}
                  >
                    <DispatchTimeline
                      date={date}
                      routes={timelineRoutes}
                      canonicalRoutes={timelineCanonicalRoutes}
                      roadRoutes={roadRoutes}
                      issues={issues}
                      selectedRouteId={selectedRouteId}
                      selectedVisitId={selectedVisitId}
                      focusedSuggestion={focusedSuggestion}
                      suggestions={timelineSuggestions}
                      onRouteSelect={focusRoute}
                      onRouteHover={previewRoute}
                      onVisitSelect={(visitId, routeId) => focusRoute(routeId, visitId)}
                      onVisitOpen={openVisitDetails}
                      onSuggestionSelect={focusTimelineSuggestion}
                      onSuggestionOpen={openDemandDetails}
                      tooltipVisitId={railJobTooltip?.stop.id ?? null}
                      onVisitTooltipShow={openRailJobTooltip}
                      onVisitTooltipHide={hideRailJobTooltip}
                      tooltipDemandId={railOverviewTooltip?.kind === "unassigned" ? railOverviewTooltip.demand?.id ?? null : null}
                      onSuggestionTooltipShow={(element, demandId) => {
                        const demand = demandById.get(demandId);
                        if (demand) openRailOverviewTooltip(element, { kind: "unassigned", demand, hasSuggestion: true });
                      }}
                      onSuggestionTooltipHide={hideRailOverviewTooltip}
                    />
                  </RouteRailTimeline>
                }
                visible={mapRailVisible || routesOpen || timelineOpen}
                railRef={routeRailRef}
                routesOpen={routesOpen}
                timelineOpen={timelineOpen}
                routePaneMode={routePaneMode}
                routePaneWidth={routePaneWidth}
                routePaneSnapPoints={routePaneSnapPoints}
                mapRailVisible={mapRailVisible}
                transition={workspacePanelTransition}
                onResize={updateRoutePaneFromResize}
                onResizeEnd={finishRoutePaneResize}
                onCycleRoutePane={cycleRoutePaneMode}
                scheduleLoaded={Boolean(snapshot)}
                demandLoading={readyToBookLoading}
                reviewStats={reviewStats}
                demandItems={readyToBookItems}
                canonicalRoutes={timelineCanonicalRoutes}
                roadRoutes={roadRoutes}
                selectedRouteId={selectedRouteId}
                selectedVisitId={selectedVisitId}
                unassignedExpanded={workspaceLayoutState.unassignedExpanded}
                focusedDemandId={focusedDemandId}
                suggestions={routeSuggestions}
                suggestionDemandIds={suggestionDemandIds}
                suggestionRadiusKm={suggestionRadiusKm}
                suggestionContext={suggestionContext}
                railJobTooltip={railJobTooltip}
                railOverviewTooltip={railOverviewTooltip}
                onUnassignedExpandedChange={workspaceLayout.setUnassignedExpanded}
                onDemandFocus={(demandId) => {
                  const suggestion = suggestionContexts[demandId];
                  focusRailDemand(
                    demandId,
                    suggestion
                      ? { routeId: suggestion.routeId, anchorVisitId: suggestion.stopId }
                      : null,
                  );
                }}
                onDemandOpen={openDemandDetails}
                onSuggestionRadiusChange={setSuggestionRadius}
                onDemandTooltipShow={(element, demand, hasSuggestion) =>
                  openRailOverviewTooltip(element, {
                    kind: "unassigned",
                    demand,
                    hasSuggestion,
                  })
                }
                routeGroups={railRouteGroups}
                collapsedRegions={collapsedRouteRegions}
                issueCountsByRoute={issueCountsByRoute}
                suggestionCountsByRoute={suggestionCountsByRoute}
                issueVisitIds={issueVisitIds}
                onToggleRegion={toggleCollapsedRouteRegion}
                onRouteFocus={focusRouteCard}
                onRouteHover={previewRoute}
                onRouteTooltipShow={(element, route, opportunities) =>
                  openRailOverviewTooltip(element, {
                    kind: "engineer",
                    route: canonicalRouteById.get(route.id) ?? route,
                    travelMinutes: roadById.get(route.id)?.totalDurationMinutes ?? null,
                    issues: issues.filter((issue) => issue.routeId === route.id),
                    opportunities,
                  })
                }
                onJobTooltipShow={openRailJobTooltip}
                onJobFocus={(element, route, stop) => {
                  openRailJobTooltip(element, route, stop);
                  if (keyboardNavigationRef.current) {
                    focusRouteCard(route, stop.id);
                  }
                }}
                onOverviewTooltipHide={hideRailOverviewTooltip}
                onJobTooltipHide={hideRailJobTooltip}

              />
              </div>
            </>
          )}

          <div className="route-summary-toolbar">
            <label className="region-filter">
              <span>Region</span>
              <select
                aria-label="Engineer region"
                className={allRegionsSelected ? "showing-all" : undefined}
                value={regionSelectValue}
                onChange={(event) => {
                  const value = event.target.value;
                  selectRegions(
                    value === "all"
                      ? new Set(routeFilterRegions)
                      : new Set([value as RouteFilterRegion]),
                  );
                }}
              >
                {regionSelectValue === "multiple" ? (
                  <option value="multiple" disabled>Multiple regions</option>
                ) : null}
                <option value="all">
                  All regions ({totalRegionCounts.booked} booked ·{" "}
                  {totalRegionCounts.unbooked} unbooked)
                </option>
                {regionOptions.map((region) => {
                  const counts = regionCounts.get(region);
                  return (
                    <option key={region} value={region}>
                      {region} ({counts?.booked ?? 0} booked ·{" "}
                      {counts?.unbooked ?? 0} unbooked)
                    </option>
                  );
                })}
              </select>
            </label>
            <div
              className="engineer-combobox"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setEngineerPickerOpen(false);
                }
              }}
            >
              <label>
                <span>Engineer route</span>
                <div className="engineer-combobox-field">
                  <input
                    role="combobox"
                    aria-label="Engineer route"
                    aria-expanded={engineerPickerOpen}
                    aria-controls="engineer-route-options"
                    aria-autocomplete="list"
                    type="search"
                    value={engineerQuery}
                    placeholder={
                      showThirdParty
                        ? `All route groups (${regionRoutes.length})`
                        : `All engineers (${regionRoutes.length})`
                    }
                    onFocus={(event) => {
                      setEngineerPickerOpen(true);
                      event.currentTarget.select();
                    }}
                    onChange={(event) => {
                      updateEngineerQuery(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setEngineerPickerOpen(false);
                        event.currentTarget.blur();
                      }
                      if (
                        event.key === "Enter" &&
                        engineerOptions.length === 1
                      ) {
                        const route = engineerOptions[0];
                        selectEngineerFilter(route.id, route.resourceName);
                      }
                    }}
                  />
                  {engineerQuery && (
                    <button
                      aria-label="Clear engineer filter"
                      onClick={() => {
                        clearEngineerQuery();
                      }}
                    >
                      ×
                    </button>
                  )}
                  <i aria-hidden="true">⌄</i>
                </div>
              </label>
              {selectedRouteHasNoCalls && (
                <span className="engineer-selected-empty" role="status">
                  No booked visits for {engineerQuery || "this engineer"} in this view
                </span>
              )}
              {engineerPickerOpen && (
                <div
                  className="engineer-options"
                  id="engineer-route-options"
                  role="listbox"
                >
                  <button
                    className={engineerFilterRouteId === "all" ? "selected" : ""}
                    role="option"
                    aria-selected={engineerFilterRouteId === "all"}
                    onClick={() => {
                      selectEngineerFilter("all");
                    }}
                  >
                    <span>
                      {showThirdParty ? "All route groups" : "All engineers"}
                    </span>
                    <b>{regionRoutes.length}</b>
                  </button>
                  {engineerOptions.map((route) => {
                    const complete = route.stops.filter(
                      (stop) => stop.isComplete,
                    ).length;
                    return (
                      <button
                        className={
                          engineerFilterRouteId === route.id ? "selected" : ""
                        }
                        key={route.id}
                        role="option"
                        aria-selected={engineerFilterRouteId === route.id}
                        onClick={() => {
                          selectEngineerFilter(route.id, route.resourceName);
                        }}
                      >
                        <i style={{ background: route.colour }} />
                        <span>{route.resourceName}</span>
                        <b>{complete}/{route.stops.length}</b>
                      </button>
                    );
                  })}
                  {!engineerOptions.length && (
                    <span className="engineer-options-empty">
                      No matching engineers
                    </span>
                  )}
                </div>
              )}
            </div>
            <label className="route-sort">
              <span>Sort routes</span>
              <select
                aria-label="Route summary sort order"
                value={routeSort}
                onChange={(event) =>
                  setRouteSort(event.target.value as "issues" | "name" | "first-job")
                }
              >
                <option value="issues">Most issues</option>
                <option value="name">A–Z</option>
                <option value="first-job">First job time</option>
              </select>
            </label>
          </div>
          {focusedOutsideFilters && (
            <p className="focus-outside-hint" role="status">
              Showing focused job outside current filters
            </p>
          )}
          {snapshot && !loading && sortedVisibleRoutes.length === 0 && (
            <div className="route-summary-empty" role="status">
              {selectedRegions.size === 1 && selectedRegions.has("EU") ? (
                <>
                  <strong>No engineer routes in the EU</strong>
                  <span>
                    Continental Europe has no covered engineer base, so it never
                    holds a booked route. Any EU demand is shown on the map as
                    Unassigned markers only.
                  </span>
                </>
              ) : (snapshot.visits?.length ?? 0) === 0 ? (
                <>
                  <strong>No booked visits are available for this date</strong>
                  <span>Try another date or wait for the background refresh to add schedule data.</span>
                </>
              ) : (
                <>
                  <strong>No booked routes match the current filters</strong>
                  <span>Show all booked visit types and clear the route focus to continue.</span>
                  <button
                    type="button"
                    onClick={resetReviewFilters}
                  >
                    Show all booked routes
                  </button>
                </>
              )}
            </div>
          )}
          <RouteSummaryCards
            groups={routeSummaryGroups}
            compactRoutes={compactSummaryRoutes}
            roadById={roadById}
            canonicalRouteById={canonicalRouteById}
            issueCountsByRoute={issueCountsByRoute}
            selectedRouteId={selectedRouteId}
            selectedVisitId={selectedVisitId}
            onRouteFocus={focusRouteCard}
          />
          <div className="map-footnote">
            <span>Road lines reconstruct the booked order using static routing; they are not GPS history.</span>
            <strong>Completed roads retain their route colour as quiet dashes.</strong>
          </div>
        </section>
      </section>
      {detailVisit && detailVisitRoute ? (
        <ServiceCallDetail
          visit={detailVisit}
          engineerColour={detailVisitRoute.colour}
          onClose={() => openVisitDetails(null)}
        />
      ) : null}
      {detailDemand ? (
        <DemandTicketDetail
          demand={detailDemand}
          onClose={() => openDemandDetails(null)}
        />
      ) : null}
      {!mapPopupOpen && railJobTooltip ? <RailJobTooltip tooltip={railJobTooltip} /> : null}
      {!mapPopupOpen && railOverviewTooltip ? <RailOverviewTooltip tooltip={railOverviewTooltip} /> : null}
    </main>
    </WorkspaceMotionProvider>
  );
}

export default function DispatchReviewClient({
  canAccessAdmin,
  canManageEngineers,
}: {
  canAccessAdmin: boolean;
  canManageEngineers: boolean;
}) {
  return (
    <Suspense fallback={<main className="page"><p>Loading booked visits…</p></main>}>
      <DispatchReviewContent
        canAccessAdmin={canAccessAdmin}
        canManageEngineers={canManageEngineers}
      />
    </Suspense>
  );
}
