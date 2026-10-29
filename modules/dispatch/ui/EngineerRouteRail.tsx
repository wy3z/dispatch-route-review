"use client";

import type {
  RouteSuggestionContext,
  RouteSuggestion,
  EngineerRoute,
  RoadRoute,
} from "@/modules/routing/contracts";
import { AnimatePresence, motion } from "motion/react";
import type { Transition } from "motion/react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { buildRouteDayOverview } from "../model/review";
import type { ReviewDayStats } from "../model/review";
import type { RouteRegion } from "../model/regions";
import type { PlanningDemandItem } from "@/modules/work/contracts";
import { formatDuration, formatTime } from "../../../shared/formatting";
import { getContrastingTextColour, withAlpha } from "@/modules/engineers/domain";
import { routeInitials } from "@/modules/work/presentation";
import { RoutePaneResizeHandle } from "./workspace/RoutePaneResizeHandle";
import type { RoutePaneMode, RoutePaneSnapPoints } from "./workspace/workspace-layout";
import type { RailJobTooltipState, RailOverviewTooltipState } from "./RailTooltips";
import { UnassignedDemandList } from "./UnassignedDemandList";

type RouteHealth = { total: number; critical: number };
type ResizeResult = { width: number; mode: RoutePaneMode };

export type EngineerRouteRailProps = {
  visible: boolean;
  timeline: ReactNode;
  railRef: RefObject<HTMLElement | null>;
  routesOpen: boolean;
  timelineOpen: boolean;
  routePaneMode: RoutePaneMode;
  routePaneWidth: number;
  routePaneSnapPoints: RoutePaneSnapPoints;
  mapRailVisible: boolean;
  transition: Transition;
  onResize: (result: ResizeResult) => void;
  onResizeEnd: (result: ResizeResult) => void;
  onCycleRoutePane: () => void;

  scheduleLoaded: boolean;
  demandLoading: boolean;
  reviewStats: ReviewDayStats;
  demandItems: PlanningDemandItem[];

  canonicalRoutes: EngineerRoute[];
  roadRoutes: RoadRoute[];
  selectedRouteId: string;
  selectedVisitId: string | null;

  unassignedExpanded: boolean;
  focusedDemandId: string | null;
  suggestions: RouteSuggestion[];
  suggestionDemandIds: string[];
  suggestionRadiusKm: number;
  suggestionContext?: RouteSuggestionContext;
  railJobTooltip: RailJobTooltipState | null;
  railOverviewTooltip: RailOverviewTooltipState | null;
  onUnassignedExpandedChange: (expanded: boolean) => void;
  onDemandFocus: (demandId: string) => void;
  onDemandOpen: (demandId: string) => void;
  onSuggestionRadiusChange: (radiusKm: number) => void;
  onDemandTooltipShow: (
    element: HTMLElement,
    demand: PlanningDemandItem,
    hasSuggestion: boolean,
  ) => void;

  routeGroups: Array<{ region: RouteRegion; routes: EngineerRoute[] }>;
  collapsedRegions: ReadonlySet<RouteRegion>;
  issueCountsByRoute: ReadonlyMap<string, RouteHealth>;
  suggestionCountsByRoute: ReadonlyMap<string, number>;
  issueVisitIds: string[];
  onToggleRegion: (region: RouteRegion) => void;
  onRouteFocus: (route: EngineerRoute, visitId?: string) => void;
  onRouteHover: (routeId: string | null) => void;
  onRouteTooltipShow: (
    element: HTMLElement,
    route: EngineerRoute,
    opportunities: number,
  ) => void;
  onJobTooltipShow: (
    element: HTMLElement,
    route: EngineerRoute,
    stop: EngineerRoute["stops"][number],
  ) => void;
  onJobFocus: (
    element: HTMLElement,
    route: EngineerRoute,
    stop: EngineerRoute["stops"][number],
  ) => void;
  onOverviewTooltipHide: () => void;
  onJobTooltipHide: () => void;
};

export function EngineerRouteRail({
  visible,
  timeline,
  railRef,
  routesOpen,
  timelineOpen,
  routePaneMode,
  routePaneWidth,
  routePaneSnapPoints,
  mapRailVisible,
  transition,
  onResize,
  onResizeEnd,
  onCycleRoutePane,
  scheduleLoaded,
  demandLoading,
  reviewStats,
  demandItems,
  canonicalRoutes,
  roadRoutes,
  selectedRouteId,
  selectedVisitId,
  unassignedExpanded,
  focusedDemandId,
  suggestions,
  suggestionDemandIds,
  suggestionRadiusKm,
  suggestionContext,
  railJobTooltip,
  railOverviewTooltip,
  onUnassignedExpandedChange,
  onDemandFocus,
  onDemandOpen,
  onSuggestionRadiusChange,
  onDemandTooltipShow,
  routeGroups,
  collapsedRegions,
  issueCountsByRoute,
  suggestionCountsByRoute,
  issueVisitIds,
  onToggleRegion,
  onRouteFocus,
  onRouteHover,
  onRouteTooltipShow,
  onJobTooltipShow,
  onJobFocus,
  onOverviewTooltipHide,
  onJobTooltipHide,
}: EngineerRouteRailProps) {
  const issueVisitIdSet = new Set(issueVisitIds);
  const roadById = new Map(roadRoutes.map((entry) => [entry.id, entry]));
  const canonicalById = new Map(
    canonicalRoutes.map((entry) => [entry.id, entry]),
  );
  const allSectionsCollapsed =
    !unassignedExpanded &&
    routeGroups.every(({ region }) => collapsedRegions.has(region));
  const routeHeaderCharacters = Math.max(
    0,
    ...routeGroups.map(({ region }) => region.length),
  );

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.aside
          ref={railRef}
          layout="size"
          initial={{ opacity: 0, x: -24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 }}
          transition={transition}
          className={`dispatch-map-route-rail map-glass-surface${routesOpen || timelineOpen ? " mobile-open" : ""}${timelineOpen ? " timeline-open" : ""}${routePaneMode === "fullscreen" ? " fullscreen-open" : ""}`}
          style={{
            "--route-rail-header-characters": routeHeaderCharacters,
          } as CSSProperties}
          aria-label={timelineOpen ? "Engineer route timeline" : "Engineer route hierarchy"}
          aria-keyshortcuts="R Shift+R"
          data-map-shortcut-scope="routes"
        >
          <RoutePaneResizeHandle
            width={routePaneWidth}
            mode={routePaneMode}
            snapPoints={routePaneSnapPoints}
            onResize={onResize}
            onResizeEnd={onResizeEnd}
            disabled={!mapRailVisible}
          />
          <header className="route-rail-stats" aria-label="Route overview">
            <h2 className="sr-only">
              {timelineOpen ? "Route timeline" : "Engineer routes"}
            </h2>
            <dl>
              <div>
                <dt>Coverage</dt>
                <dd>
                  {!scheduleLoaded
                    ? "—"
                    : demandLoading
                      ? "…"
                      : reviewStats.coveragePercent === null
                        ? "—"
                        : `${reviewStats.coveragePercent}%`}
                </dd>
              </div>
              <div>
                <dt>Capacity</dt>
                <dd>
                  {reviewStats.capacityMinutes === null
                    ? "—"
                    : formatDuration(reviewStats.capacityMinutes)}
                </dd>
              </div>
              <div>
                <dt>Avg Drive</dt>
                <dd>
                  {!scheduleLoaded || reviewStats.avgDriveMinutes === null
                    ? "—"
                    : formatDuration(reviewStats.avgDriveMinutes)}
                </dd>
              </div>
            </dl>
          </header>
          {timelineOpen ? (
            timeline
          ) : (
            <>
              <UnassignedDemandList
                items={demandItems}
                suggestions={suggestions}
                suggestionRadiusKm={suggestionRadiusKm}
                suggestionContext={suggestionContext}
                expanded={unassignedExpanded}
                focusedDemandId={focusedDemandId}
                tooltipDemandId={
                  railOverviewTooltip?.kind === "unassigned"
                    ? railOverviewTooltip.demand?.id ?? null
                    : null
                }
                onExpandedChange={onUnassignedExpandedChange}
                onFocus={onDemandFocus}
                onOpen={onDemandOpen}
                onSuggestionRadiusChange={onSuggestionRadiusChange}
                onTooltipShow={(element, demand) =>
                  onDemandTooltipShow(
                    element,
                    demand,
                    suggestionDemandIds.includes(demand.id),
                  )
                }
                onTooltipHide={onOverviewTooltipHide}
              />
              <div className="route-rail-list">
                {routeGroups.map(({ region, routes: groupedRoutes }) => {
                  const collapsed = collapsedRegions.has(region);
                  const regionId = `route-rail-region-${region.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
                  return (
                    <section className="route-rail-region" key={region}>
                      <h3>
                        <button
                          type="button"
                          data-rail-category-trigger
                          aria-expanded={!collapsed}
                          aria-controls={regionId}
                          onClick={() => onToggleRegion(region)}
                        >
                          <svg viewBox="0 0 20 20" aria-hidden="true">
                            <path d="m6.5 8 3.5 3.5L13.5 8" />
                          </svg>
                          <span>{region}</span>
                          <b>{groupedRoutes.length}</b>
                        </button>
                      </h3>
                      <AnimatePresence initial={false}>
                        {!collapsed ? (
                          <motion.div
                            id={regionId}
                            className="route-rail-region-routes"
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={transition}
                          >
                            {groupedRoutes.map((route) => {
                              const selected = selectedRouteId === route.id;
                              const routeHealth = issueCountsByRoute.get(route.id) ?? {
                                total: 0,
                                critical: 0,
                              };
                              const opportunities = suggestionCountsByRoute.get(route.id) ?? 0;
                              const road = roadById.get(route.id);
                              const travelMinutes = road?.totalDurationMinutes;
                              const railStopsId = `route-rail-stops-${route.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
                              const dayOverview = selected
                                ? buildRouteDayOverview({
                                    route,
                                    canonicalRoute: canonicalById.get(route.id) ?? route,
                                    road,
                                  })
                                : [];
                              return (
                                <article
                                  className={selected ? "selected" : ""}
                                  key={route.id}
                                  style={{
                                    "--route-colour": route.colour,
                                    "--route-tint": withAlpha(route.colour, 0.1),
                                  } as CSSProperties}
                                >
                                  <button
                                    type="button"
                                    className={`route-rail-route${route.stops.length === 0 ? " idle" : ""}`}
                                    aria-disabled={route.stops.length === 0 && !route.base || undefined}
                                    aria-describedby={
                                      railOverviewTooltip?.kind === "engineer" &&
                                      railOverviewTooltip.route?.id === route.id
                                        ? "route-rail-overview-tooltip"
                                        : undefined
                                    }
                                    aria-expanded={route.stops.length ? selected : undefined}
                                    aria-controls={route.stops.length ? railStopsId : undefined}
                                    aria-current={selected ? "true" : undefined}
                                    onClick={() => {
                                      if (route.stops.length || route.base) onRouteFocus(route);
                                    }}
                                    onPointerEnter={(event) => {
                                      onRouteHover(route.id);
                                      onRouteTooltipShow(event.currentTarget, route, opportunities);
                                    }}
                                    onPointerLeave={() => {
                                      onRouteHover(null);
                                      onOverviewTooltipHide();
                                    }}
                                    onFocus={(event) => {
                                      onRouteHover(route.id);
                                      onRouteTooltipShow(event.currentTarget, route, opportunities);
                                    }}
                                    onBlur={() => {
                                      onRouteHover(null);
                                      onOverviewTooltipHide();
                                    }}
                                  >
                                    <i style={{
                                      background: route.colour,
                                      color: getContrastingTextColour(route.colour),
                                    }}>
                                      {routeInitials(route.resourceName)}
                                    </i>
                                    <span>
                                      <strong>{route.resourceName}</strong>
                                      <small>
                                        {route.stops.length
                                          ? `${route.stops.length} visit${route.stops.length === 1 ? "" : "s"}${typeof travelMinutes === "number" ? ` · ${formatDuration(travelMinutes)}` : ""}`
                                          : "No bookings"}
                                        {opportunities ? ` · ${opportunities} nearby` : ""}
                                      </small>
                                    </span>
                                    <b className={route.stops.length === 0 ? "idle" : routeHealth.critical ? "critical" : routeHealth.total ? "warning" : "healthy"}>
                                      {route.stops.length === 0 ? "—" : routeHealth.critical ? "!" : routeHealth.total ? routeHealth.total : "✓"}
                                    </b>
                                  </button>
                                  {selected ? (
                                    <ol id={railStopsId} className="route-rail-day" aria-label={`${route.resourceName} ordered visits`}>
                                      {dayOverview.map((item) => {
                                        if (item.type === "home") {
                                          return (
                                            <li className={`route-rail-home ${item.role}`} key={item.id}>
                                              <strong>{item.role === "start" ? "Start" : "End"} · {item.baseLabel}</strong>
                                              <span>{item.time ? formatTime(item.time) : "—"}</span>
                                            </li>
                                          );
                                        }
                                        if (item.type === "travel") {
                                          return (
                                            <li className="route-rail-travel" key={item.id}>
                                              <span>
                                                {item.minutes === null ? "—" : formatDuration(item.minutes)}
                                                {item.destination === "home" ? " home" : " travel"}
                                              </span>
                                            </li>
                                          );
                                        }
                                        const stop = item.stop;
                                        return (
                                          <li key={stop.id}>
                                            <button
                                              type="button"
                                              data-detail-visit-id={stop.id}
                                              aria-pressed={selectedVisitId === stop.id}
                                              aria-describedby={
                                                railJobTooltip?.stop.id === stop.id
                                                  ? "route-rail-job-tooltip"
                                                  : undefined
                                              }
                                              className={`route-rail-job${selectedVisitId === stop.id ? " selected" : ""}`}
                                              onClick={() => onRouteFocus(route, stop.id)}
                                              onPointerEnter={(event) =>
                                                onJobTooltipShow(event.currentTarget, route, stop)
                                              }
                                              onPointerLeave={onJobTooltipHide}
                                              onFocus={(event) =>
                                                onJobFocus(event.currentTarget, route, stop)
                                              }
                                              onBlur={onJobTooltipHide}
                                            >
                                              <i>{stop.isComplete ? "✓" : stop.sequence}</i>
                                              <span>
                                                <strong>{stop.companyName}</strong>
                                                <small>{formatTime(stop.startDateTime)}–{formatTime(stop.endDateTime)}</small>
                                              </span>
                                              {issueVisitIdSet.has(stop.id) ? <b>!</b> : null}
                                              {stop.ownerType === "third-party" ? <em>3P</em> : null}
                                            </button>
                                          </li>
                                        );
                                      })}
                                    </ol>
                                  ) : null}
                                </article>
                              );
                            })}
                          </motion.div>
                        ) : null}
                      </AnimatePresence>
                    </section>
                  );
                })}
              </div>
              <footer className="route-rail-footer">
                <button
                  type="button"
                  className="route-rail-toggle-all"
                  aria-label={allSectionsCollapsed ? "Expand all rail sections" : "Collapse all rail sections"}
                  aria-keyshortcuts="e"
                  onClick={() => {
                    const expand = allSectionsCollapsed;
                    onUnassignedExpandedChange(expand);
                    routeGroups.forEach(({ region }) => {
                      if (collapsedRegions.has(region) === expand) {
                        onToggleRegion(region);
                      }
                    });
                  }}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    {allSectionsCollapsed ? (
                      <path d="m5 7 5 5 5-5" />
                    ) : (
                      <path d="m5 12 5-5 5 5" />
                    )}
                  </svg>
                  <span>{allSectionsCollapsed ? "Expand" : "Collapse"}</span>
                  <kbd>E</kbd>
                </button>
                <button
                  type="button"
                  className="route-rail-expand-timeline"
                  aria-label="Open route timeline"
                  aria-controls="route-rail-timeline"
                  aria-keyshortcuts="t"
                  onClick={onCycleRoutePane}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M3 4.5h14M6 8v8M10 6v10M14 10v6" />
                  </svg>
                  <span>Timeline</span>
                  <kbd>T</kbd>
                </button>
              </footer>
            </>
          )}
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
