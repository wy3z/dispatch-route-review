"use client";

import { createPortal } from "react-dom";
import { joinServiceCallAddress } from "./service-call-detail-helpers";
import { formatDuration, formatTime } from "../../../shared/formatting";
import type { PlanningDemandItem } from "@/modules/work/contracts";
import type { StaticRoadTiming, EngineerRoute, RouteIssue } from "@/modules/routing/contracts";
import { demandQueueLabel, jobTypeLabel } from "@/modules/work/presentation";

export type RailJobTooltipState = {
  route: EngineerRoute;
  stop: EngineerRoute["stops"][number];
  timing: StaticRoadTiming;
  issues: RouteIssue[];
  left: number;
  top: number;
};

export type RailOverviewTooltipState = {
  kind: "engineer" | "unassigned";
  route?: EngineerRoute;
  demand?: PlanningDemandItem;
  travelMinutes?: number | null;
  issues?: RouteIssue[];
  opportunities?: number;
  hasSuggestion?: boolean;
  left: number;
  top: number;
};

export function RailOverviewTooltip({
  tooltip,
}: {
  tooltip: RailOverviewTooltipState;
}) {
  const { left, top } = tooltip;
  if (tooltip.kind === "unassigned" && tooltip.demand) {
    const demand = tooltip.demand;
    const attention = [
      ...(demand.exclusionReason
        ? [
            demand.exclusionDetail ||
              "Site location is outside current engineer coverage.",
          ]
        : []),
      ...(demand.overdue ? ["Overdue"] : []),
      ...(demand.ageBand === "aged" ? ["Waiting over 24 hours"] : []),
    ];
    return createPortal(
      <aside
        id="route-rail-overview-tooltip"
        className="dispatch-service-tooltip route-rail-job-tooltip"
        role="tooltip"
        style={{ left, top }}
      >
        <div className="dispatch-service-tooltip-head">
          <strong>{demand.ticketNumber}</strong>
          <i
            className={
              demand.requestType === "third_party" ? "third-party" : "ready"
            }
          >
            {demand.statusLabel || "Unassigned request"}
          </i>
        </div>
        <b>{demand.companyLabel}</b>
        <span>{demand.title || "Unassigned request"}</span>
        <dl>
          <div><dt>Work type</dt><dd>{demandQueueLabel(demand)}</dd></div>
          <div><dt>Work duration</dt><dd>{formatDuration(demand.durationMinutes)} · {demand.durationSource === "assumed" ? "assumed" : "ticket estimate"}</dd></div>
          <div><dt>Location</dt><dd>{[demand.siteLabel, demand.city, demand.postcode].filter(Boolean).join(", ") || "Unavailable"}</dd></div>
          <div><dt>Schedule</dt><dd>Unassigned · no predicted time</dd></div>
          <div><dt>Suggestion</dt><dd>{tooltip.hasSuggestion ? "Nearby route available" : "No nearby route in current radius"}</dd></div>
        </dl>
        {attention.length ? (
          <p className={demand.overdue ? "critical" : "warning"}>
            <strong>Needs attention</strong>
            {attention.join(" · ")}
          </p>
        ) : null}
      </aside>,
      document.body,
    );
  }

  const route = tooltip.route;
  if (!route) return null;
  const first = route.stops[0];
  const last = route.stops.at(-1);
  const complete = route.stops.filter((stop) => stop.isComplete).length;
  const bookedMinutes = route.stops.reduce(
    (total, stop) => total + stop.durationMinutes,
    0,
  );
  const routeIssues = tooltip.issues ?? [];
  return createPortal(
    <aside
      id="route-rail-overview-tooltip"
      className="dispatch-service-tooltip route-rail-job-tooltip"
      role="tooltip"
      style={{ left, top }}
    >
      <div className="dispatch-service-tooltip-head">
        <strong>{route.resourceName}</strong>
        <i className={!routeIssues.length && route.stops.length ? "complete" : undefined}>
          {route.stops.length
            ? `${route.stops.length} ${route.stops.length === 1 ? "visit" : "visits"}`
            : "No bookings"}
        </i>
      </div>
      <b>{route.base?.region ?? "Third-party"}</b>
      <span>{route.base?.base ? `Based at ${route.base.base}` : "No covered engineer base"}</span>
      <dl>
        <div><dt>Day</dt><dd>{first && last ? `${formatTime(first.startDateTime)}–${formatTime(last.endDateTime)}` : "No scheduled work"}</dd></div>
        <div><dt>Booked work</dt><dd>{route.stops.length ? `${formatDuration(bookedMinutes)} · ${complete} complete, ${route.stops.length - complete} open` : "None"}</dd></div>
        <div><dt>Travel</dt><dd>{tooltip.travelMinutes === null || tooltip.travelMinutes === undefined ? "Unavailable · not live GPS" : `${formatDuration(tooltip.travelMinutes)} static estimate`}</dd></div>
        <div><dt>Suggestions</dt><dd>{tooltip.opportunities ? `${tooltip.opportunities} nearby ${tooltip.opportunities === 1 ? "suggestion" : "suggestions"}` : "None nearby"}</dd></div>
      </dl>
      {routeIssues.length ? (
        <p className={routeIssues.some((issue) => issue.severity === "critical") ? "critical" : "warning"}>
          <strong>{routeIssues.length} route {routeIssues.length === 1 ? "issue" : "issues"}</strong>
          {routeIssues.map((issue) => issue.title).join(" · ")}
        </p>
      ) : null}
    </aside>,
    document.body,
  );
}

export function RailJobTooltip({ tooltip }: { tooltip: RailJobTooltipState }) {
  const { route, stop, timing, issues, left, top } = tooltip;
  return createPortal(
    <aside
      id="route-rail-job-tooltip"
      className="dispatch-service-tooltip route-rail-job-tooltip"
      role="tooltip"
      style={{ left, top }}
    >
      <div className="dispatch-service-tooltip-head">
        <strong>{stop.ticketNumber || `Service call ${stop.serviceCallId}`}</strong>
        <i className={stop.isComplete ? "complete" : "attending"}>
          {stop.isComplete
            ? "Complete"
            : stop.ticketStatusLabel || "Attending"}
        </i>
      </div>
      <b>{stop.companyName}</b>
      <span>{stop.title || jobTypeLabel(stop.jobType, stop.queueLabel)}</span>
      <dl>
        <div><dt>Scheduled</dt><dd>{formatTime(stop.startDateTime)}–{formatTime(stop.endDateTime)} · {formatDuration(stop.durationMinutes)}</dd></div>
        <div><dt>Engineer</dt><dd>{route.resourceName}</dd></div>
        <div><dt>Location</dt><dd>{joinServiceCallAddress(stop) || stop.locationName || "Unavailable"}</dd></div>
        <div><dt>Work type</dt><dd>{jobTypeLabel(stop.jobType, stop.queueLabel)}</dd></div>
        <div>
          <dt>Road estimate</dt>
          <dd>
            {timing.availability === "unavailable"
              ? "Unavailable · not live GPS"
              : timing.kind === "inbound"
                ? `${formatTime(timing.estimatedTravelStartDateTime)}–${formatTime(timing.bookedArrivalDateTime)} · not live GPS`
                : `${formatTime(timing.estimatedTravelStartDateTime)}–${formatTime(timing.estimatedArrivalDateTime)} · not live GPS`}
          </dd>
        </div>
        {timing.availability === "available" && timing.kind === "inbound" && timing.earliestArrivalDateTime ? (
          <div>
            <dt>Earliest</dt>
            <dd
              className={
                typeof timing.marginMinutes !== "number"
                  ? undefined
                  : timing.marginMinutes < 0
                    ? "negative"
                    : timing.marginMinutes < 15
                      ? "warning"
                      : "positive"
              }
            >
              {formatTime(timing.earliestArrivalDateTime)}
              {typeof timing.marginMinutes === "number"
                ? ` · ${timing.marginMinutes < 0 ? `${Math.abs(timing.marginMinutes)} min short` : `${timing.marginMinutes} min margin`}`
                : ""}
            </dd>
          </div>
        ) : null}
      </dl>
      {issues.length ? (
        <p className={issues.some((issue) => issue.severity === "critical") ? "critical" : "warning"}>
          <strong>{issues.length} route {issues.length === 1 ? "issue" : "issues"}</strong>
          {issues.map((issue) => issue.title).join(" · ")}
        </p>
      ) : null}
    </aside>,
    document.body,
  );
}

export function railTooltipPosition(
  rect: Pick<DOMRect, "left" | "right" | "top">,
  rail: Pick<DOMRect, "right" | "width"> | undefined,
  viewport: { width: number; height: number },
) {
  const tooltipWidth = Math.min(420, viewport.width - 24);
  const preferredLeft = (rail?.width ?? 0) > 480
    ? rect.right + 12
    : Math.max(rect.right, rail?.right ?? rect.right) + 12;
  return {
    left: preferredLeft + tooltipWidth <= viewport.width - 12
      ? preferredLeft
      : Math.max(12, rect.left - tooltipWidth - 12),
    top: Math.max(12, Math.min(rect.top, viewport.height - 390)),
  };
}
