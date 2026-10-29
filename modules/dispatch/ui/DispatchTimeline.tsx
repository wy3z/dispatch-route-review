"use client";

import { groupBy } from "../../../shared/collections";
import { groupIssuesByVisit } from "../model/review";
import { useMemo, useRef } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { compareRouteRegions, routeRegion } from "../model/regions";
import { formatMiles } from "../../../shared/coordinates";
import { formatDuration, formatTime } from "../../../shared/formatting";
import { withAlpha } from "@/modules/engineers/domain";
import {
  dispatchTimelineBounds,
  hasTravelConflictIssue,
  minutesOnReviewDate,
  timelineLabel,
  timelineStyle,
} from "../model/timeline";
import type { EngineerRoute, RoadRoute, RouteIssue } from "@/modules/routing/contracts";

export type DispatchTimelineSuggestion = {
  id: string;
  demandId: string;
  routeId: string;
  anchorVisitId: string;
  label: string;
  distanceKm: number;
};

type Props = {
  date: string;
  routes: EngineerRoute[];
  canonicalRoutes: EngineerRoute[];
  roadRoutes: RoadRoute[];
  issues: RouteIssue[];
  selectedRouteId: string;
  selectedVisitId: string | null;
  focusedSuggestion?: {
    demandId: string;
    routeId: string;
    anchorVisitId: string;
    label: string;
  } | null;
  suggestions?: DispatchTimelineSuggestion[];
  onRouteSelect: (routeId: string) => void;
  onRouteHover: (routeId: string | null) => void;
  onVisitSelect: (visitId: string, routeId: string) => void;
  onVisitOpen: (visitId: string) => void;
  tooltipVisitId?: string | null;
  onVisitTooltipShow?: (
    element: HTMLElement,
    route: EngineerRoute,
    stop: EngineerRoute["stops"][number],
  ) => void;
  onVisitTooltipHide?: () => void;
  tooltipDemandId?: string | null;
  onSuggestionTooltipShow?: (
    element: HTMLElement,
    demandId: string,
  ) => void;
  onSuggestionTooltipHide?: () => void;
  onSuggestionOpen?: (demandId: string) => void;
  onSuggestionSelect?: (
    demandId: string,
    routeId: string,
    anchorVisitId: string,
  ) => void;
};

export function DispatchTimeline({
  date,
  routes,
  canonicalRoutes,
  roadRoutes,
  issues,
  selectedRouteId,
  selectedVisitId,
  focusedSuggestion = null,
  suggestions = [],
  onRouteSelect,
  onRouteHover,
  onVisitSelect,
  onVisitOpen,
  tooltipVisitId = null,
  onVisitTooltipShow,
  onVisitTooltipHide,
  tooltipDemandId = null,
  onSuggestionTooltipShow,
  onSuggestionTooltipHide,
  onSuggestionSelect,
  onSuggestionOpen,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const roadById = useMemo(
    () => new Map(roadRoutes.map((route) => [route.id, route])),
    [roadRoutes],
  );
  const canonicalById = useMemo(
    () => new Map(canonicalRoutes.map((route) => [route.id, route])),
    [canonicalRoutes],
  );
  const timeline = useMemo(
    () => {
      const visibleRouteIds = new Set(routes.map((route) => route.id));
      return dispatchTimelineBounds(
        date,
        canonicalRoutes.filter((route) => visibleRouteIds.has(route.id)),
        roadRoutes,
      );
    },
    [canonicalRoutes, date, roadRoutes, routes],
  );
  const issuesByRoute = useMemo(() => groupBy(issues, (issue) => issue.routeId), [issues]);
  const issuesByVisit = useMemo(() => groupIssuesByVisit(issues), [issues]);
  const suggestionsByAnchor = useMemo(
    () => groupBy(suggestions, (suggestion) => suggestion.anchorVisitId), [suggestions],
  );
  const suggestionsByRoute = useMemo(
    () => groupBy(suggestions, (suggestion) => suggestion.routeId), [suggestions],
  );
  const groups = useMemo(() => {
    const grouped = groupBy(routes, routeRegion);
    return [...grouped.entries()]
      .sort(([first], [second]) => compareRouteRegions(first, second))
      .map(([region, regionRoutes]) => ({
        region,
        routes: [...regionRoutes].sort((first, second) =>
          first.resourceName.localeCompare(second.resourceName, "en-GB"),
        ),
      }));
  }, [routes]);
  const minWidth = 220 + Math.max(760, (timeline.hours.length - 1) * 126);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const element = scrollRef.current;
    if (!element) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
      moved: false,
    };
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const element = scrollRef.current;
    if (!drag || !element || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      element.dataset.dragging = "true";
      element.setPointerCapture(event.pointerId);
    }
    element.scrollLeft = drag.scrollLeft - deltaX;
    element.scrollTop = drag.scrollTop - deltaY;
    event.preventDefault();
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const element = scrollRef.current;
    if (!drag || !element || drag.pointerId !== event.pointerId) return;
    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
    delete element.dataset.dragging;
    dragRef.current = null;
    if (drag.moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  };

  if (!routes.length) {
    return (
      <div className="review-timeline-empty" role="status">
        <strong>No booked routes match this review scope</strong>
        <span>Adjust the route filters or choose another date.</span>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="review-timeline-scroll"
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = false;
      }}
    >
      <div className="review-timeline-grid" style={{ minWidth }}>
        <div className="review-timeline-corner">Engineers</div>
        <div
          className="review-timeline-hours"
          style={{ gridTemplateColumns: `repeat(${timeline.hours.length}, 1fr)` }}
        >
          {timeline.hours.map((hour) => (
            <span key={hour}>{timelineLabel(hour)}</span>
          ))}
        </div>
        {groups.map(({ region, routes: regionRoutes }) => (
          <section className="review-timeline-region" key={region}>
            <h2>
              <span className="review-timeline-region-heading-copy">
                <strong>{region}</strong>
                <span>
                  {regionRoutes.length} engineer{regionRoutes.length === 1 ? "" : "s"}
                </span>
              </span>
            </h2>
            {regionRoutes.map((route) => {
              const road = roadById.get(route.id);
              const canonicalRoute = canonicalById.get(route.id) ?? route;
              const routeIssues = issuesByRoute.get(route.id) ?? [];
              const lastMappedStop = [...canonicalRoute.stops]
                .reverse()
                .find(
                  (stop) =>
                    stop.latitude !== null && stop.longitude !== null,
                );
              const returnTravel =
                canonicalRoute.returnLegIndex !== null
                  ? road?.legDurationsMinutes?.[canonicalRoute.returnLegIndex] ?? 0
                  : 0;
              const critical = routeIssues.filter(
                (issue) => issue.severity === "critical",
              ).length;
              const routeSuggestions = suggestionsByRoute.get(route.id) ?? [];
              const selected =
                selectedRouteId === route.id ||
                route.stops.some((stop) => stop.id === selectedVisitId) ||
                focusedSuggestion?.routeId === route.id;
              return (
                <div
                  className={`review-timeline-row${selected ? " selected" : ""}${critical ? " has-critical" : routeIssues.length ? " has-warning" : ""}`}
                  key={route.id}
                  style={{
                    "--route-colour": route.colour,
                    "--route-tint": withAlpha(route.colour, 0.1),
                  } as CSSProperties}
                >
                  <button
                    type="button"
                    className="review-timeline-engineer"
                    aria-pressed={selectedRouteId === route.id}
                    onClick={() => onRouteSelect(route.id)}
                    onPointerEnter={() => onRouteHover(route.id)}
                    onPointerLeave={() => onRouteHover(null)}
                    onFocus={() => onRouteHover(route.id)}
                    onBlur={() => onRouteHover(null)}
                  >
                    <i style={{ background: route.colour }} />
                    <span>
                      <strong>{route.resourceName}</strong>
                      <small>
                        {route.stops.length
                          ? `${route.stops.length} visit${route.stops.length === 1 ? "" : "s"} · ${formatDuration(road?.totalDurationMinutes ?? 0)} travel`
                          : `No bookings${route.base?.base ? ` · ${route.base.base}` : ""}`}
                      </small>
                    </span>
                    {critical || routeIssues.length || routeSuggestions.length ? (
                      <span className="review-timeline-engineer-flags">
                        {critical ? (
                          <b>{critical} issue{critical === 1 ? "" : "s"}</b>
                        ) : routeIssues.length ? (
                          <b>{routeIssues.length} review</b>
                        ) : null}
                        {routeSuggestions.length ? (
                          <b className="suggestion">
                            {routeSuggestions.length} suggestion{routeSuggestions.length === 1 ? "" : "s"}
                          </b>
                        ) : null}
                      </span>
                    ) : null}
                  </button>
                  <div className="review-timeline-track">
                    {timeline.hours.slice(0, -1).map((hour) => (
                      <i
                        className="review-timeline-hour-line"
                        key={hour}
                        style={{ left: `${((hour - timeline.start) / (timeline.end - timeline.start)) * 100}%` }}
                      />
                    ))}
                    {route.stops.map((stop, index) => {
                      const start = minutesOnReviewDate(stop.startDateTime, date);
                      const travel =
                        stop.inboundLegIndex !== null
                          ? road?.legDurationsMinutes?.[stop.inboundLegIndex] ?? 0
                          : 0;
                      const nextStop = route.stops[index + 1];
                      const nextTravel =
                        nextStop?.inboundLegIndex !== null &&
                        nextStop?.inboundLegIndex !== undefined
                          ? road?.legDurationsMinutes?.[nextStop.inboundLegIndex] ?? 0
                          : 0;
                      const nextOccupiedStart = nextStop
                        ? minutesOnReviewDate(nextStop.startDateTime, date) - nextTravel
                        : undefined;
                      const visitIssues = issuesByVisit.get(stop.id) ?? [];
                      const visitSeverity = visitIssues.some(
                        (issue) => issue.severity === "critical",
                      )
                        ? "critical"
                        : visitIssues.some((issue) => issue.severity === "warning")
                          ? "warning"
                          : visitIssues.length
                            ? "data"
                            : "";
                      const stopSelected = selectedVisitId === stop.id;
                      const anchorSuggestions = suggestionsByAnchor.get(stop.id) ?? [];
                      const isSuggestionAnchor = anchorSuggestions.length > 0;
                      const displayedSuggestion =
                        anchorSuggestions.find(
                          (candidate) =>
                            candidate.demandId === focusedSuggestion?.demandId,
                        ) ?? anchorSuggestions[0];
                      const travelConflict = hasTravelConflictIssue(visitIssues);
                      const travelIssue = visitIssues.find(
                        (issue) =>
                          issue.kind === "insufficient-travel" ||
                          issue.kind === "booking-overlap",
                      );
                      return (
                        <div key={stop.id}>
                          {travel > 0 ? (
                            <span
                              className={`review-timeline-travel${travelConflict ? " conflict" : ""}${stop.isComplete ? " complete" : ""}`}
                              style={timelineStyle(start - travel, travel, timeline)}
                              title={`${travel} minutes estimated road travel${travelIssue ? `; ${travelIssue.title}` : ""}`}
                            >
                              {travel >= 18 ? `${travel}m` : ""}
                            </span>
                          ) : null}
                          <button
                            type="button"
                            data-detail-visit-id={stop.id}
                            className={`review-timeline-visit${stop.isComplete ? " complete" : ""}${stopSelected ? " selected" : ""}${visitSeverity ? ` ${visitSeverity}` : ""}${isSuggestionAnchor ? " suggestion-anchor" : ""}`}
                            style={{
                              ...timelineStyle(start, stop.durationMinutes, timeline, {
                                minimumDisplayMinutes: 45,
                                maximumDisplayEnd:
                                  nextOccupiedStart === undefined
                                    ? undefined
                                    : Math.max(start, nextOccupiedStart - 2),
                              }),
                              "--route-colour": route.colour,
                            } as CSSProperties}
                            aria-pressed={stopSelected}
                            aria-describedby={
                              tooltipVisitId === stop.id
                                ? "route-rail-job-tooltip"
                                : undefined
                            }
                            aria-label={`${formatTime(stop.startDateTime)} to ${formatTime(stop.endDateTime)}, ${stop.companyName}, ${route.resourceName}. Click to locate; double-click or press Enter for ticket details.`}
                            onClick={() => onVisitSelect(stop.id, route.id)}
                            onDoubleClick={() => onVisitOpen(stop.id)}
                            onPointerEnter={(event) =>
                              onVisitTooltipShow?.(event.currentTarget, route, stop)
                            }
                            onPointerLeave={onVisitTooltipHide}
                            onFocus={(event) =>
                              onVisitTooltipShow?.(event.currentTarget, route, stop)
                            }
                            onBlur={onVisitTooltipHide}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter") return;
                              event.preventDefault();
                              onVisitSelect(stop.id, route.id);
                              onVisitOpen(stop.id);
                            }}
                          >
                            <strong>{formatTime(stop.startDateTime)}–{formatTime(stop.endDateTime)}</strong>
                            <span>{stop.companyName}</span>
                            {visitSeverity ? (
                              <em
                                className="review-timeline-visit-status"
                                aria-hidden="true"
                              >
                                {visitSeverity === "data" ? "i" : "!"}
                              </em>
                            ) : null}
                          </button>
                          {displayedSuggestion ? (
                            <button
                              type="button"
                              data-detail-demand-id={displayedSuggestion.demandId}
                              className={`review-timeline-suggestion-note${displayedSuggestion.demandId === focusedSuggestion?.demandId ? " selected" : ""}`}
                              style={timelineStyle(
                                start + stop.durationMinutes + 4,
                                60,
                                timeline,
                                { minimumDisplayMinutes: 72 },
                              )}
                              aria-describedby={
                                tooltipDemandId === displayedSuggestion.demandId
                                  ? "route-rail-overview-tooltip"
                                  : undefined
                              }
                              aria-label={`Show nearby request ${displayedSuggestion.label}, ${formatMiles(displayedSuggestion.distanceKm)} from this visit. Click to locate; double-click or press Enter for ticket details.`}
                              onClick={() =>
                                onSuggestionSelect?.(
                                  displayedSuggestion.demandId,
                                  displayedSuggestion.routeId,
                                  displayedSuggestion.anchorVisitId,
                                )
                              }
                              onDoubleClick={() =>
                                onSuggestionOpen?.(displayedSuggestion.demandId)
                              }
                              onPointerEnter={(event) =>
                                onSuggestionTooltipShow?.(
                                  event.currentTarget,
                                  displayedSuggestion.demandId,
                                )
                              }
                              onPointerLeave={onSuggestionTooltipHide}
                              onFocus={(event) =>
                                onSuggestionTooltipShow?.(
                                  event.currentTarget,
                                  displayedSuggestion.demandId,
                                )
                              }
                              onBlur={onSuggestionTooltipHide}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                onSuggestionSelect?.(
                                  displayedSuggestion.demandId,
                                  displayedSuggestion.routeId,
                                  displayedSuggestion.anchorVisitId,
                                );
                                onSuggestionOpen?.(displayedSuggestion.demandId);
                              }}
                            >
                              <b>{displayedSuggestion.label}</b>
                              <small>
                                {formatMiles(displayedSuggestion.distanceKm)} · proximity only
                                {anchorSuggestions.length > 1
                                  ? ` · +${anchorSuggestions.length - 1} nearby`
                                  : ""}
                              </small>
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                    {lastMappedStop && returnTravel > 0 ? (
                      <span
                        className="review-timeline-travel return-home"
                        style={timelineStyle(
                          minutesOnReviewDate(lastMappedStop.endDateTime, date),
                          returnTravel,
                          timeline,
                        )}
                        title={`${returnTravel} minutes estimated return travel to ${canonicalRoute.base?.base ?? "home base"}`}
                      >
                        {returnTravel >= 18 ? `↩ ${returnTravel}m` : "↩"}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
