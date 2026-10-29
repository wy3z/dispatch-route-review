import type { CSSProperties } from "react";
import type { RouteRegion } from "../model/regions";
import { routeCardHomeLegs } from "../model/review";
import { formatDuration, formatTime } from "../../../shared/formatting";
import type { EngineerRoute, RoadRoute } from "@/modules/routing/contracts";
import { jobTypeLabel, routeInitials } from "@/modules/work/presentation";
import { AutotaskLink } from "@/modules/work/client";

type RouteSummaryGroup = {
  region: RouteRegion | null;
  routes: EngineerRoute[];
};

type RouteHealth = {
  total: number;
  critical: number;
};

type Props = {
  groups: RouteSummaryGroup[];
  compactRoutes: EngineerRoute[];
  roadById: ReadonlyMap<string, RoadRoute>;
  canonicalRouteById: ReadonlyMap<string, EngineerRoute>;
  issueCountsByRoute: ReadonlyMap<string, RouteHealth>;
  selectedRouteId: string;
  selectedVisitId: string | null;
  onRouteFocus: (route: EngineerRoute, visitId?: string) => void;
};

export function RouteSummaryCards({
  groups: routeSummaryGroups,
  compactRoutes: compactSummaryRoutes,
  roadById,
  canonicalRouteById,
  issueCountsByRoute,
  selectedRouteId,
  selectedVisitId,
  onRouteFocus,
}: Props) {
  return (
    <div className="route-summary-groups grouped">
      {routeSummaryGroups.map(({ region, routes: groupedRoutes }) => (
        <section className="route-summary-group" key={region ?? "all"}>
          {region && <h2 className="route-summary-region-heading">{region}</h2>}
          <div className="route-summary-grid">
            {groupedRoutes.map((route) => {
              const road = roadById.get(route.id);
              const isThirdParty =
                route.stops[0]?.ownerType === "third-party";
              const failedLegs =
                road?.legErrors?.filter(Boolean).length ?? 0;
              const unmappedStops = route.stops.filter(
                (stop) =>
                  stop.latitude === null || stop.longitude === null,
              ).length;
              const hasMappedStop = route.stops.some(
                (stop) =>
                  stop.latitude !== null && stop.longitude !== null,
              );
              const routeHealth = issueCountsByRoute.get(route.id) ?? {
                total: 0,
                critical: 0,
              };
              const canonicalRoute = canonicalRouteById.get(route.id) ?? route;
              const homeLegs = routeCardHomeLegs(route, canonicalRoute);
              const returnLegDuration =
                canonicalRoute.returnLegIndex === null
                  ? null
                  : road?.legDurationsMinutes?.[canonicalRoute.returnLegIndex] ?? null;
              return (
                <article
                  className={selectedRouteId === route.id ? "route-selected" : ""}
                  key={route.id}
                  style={{
                    "--route-colour": route.colour,
                    "--route-card-width": `${Math.min(680, Math.max(310, 270 + route.stops.length * 58))}px`,
                  } as CSSProperties}
                >
                  <header>
                    <button
                      type="button"
                      className="route-summary-route-focus"
                      aria-label={`Select ${route.resourceName}'s route`}
                      aria-pressed={selectedRouteId === route.id}
                      onClick={() => onRouteFocus(route)}
                    >
                      <i
                        className="route-summary-avatar"
                        style={{ background: route.colour }}
                      >
                        {routeInitials(route.resourceName)}
                      </i>
                      <div>
                        <strong>{route.resourceName}</strong>
                        <span>
                          {route.stops.length} visit{route.stops.length === 1 ? "" : "s"} ·{" "}
                          {road ? formatDuration(road.totalDurationMinutes ?? 0) : "route pending"}
                        </span>
                      </div>
                      <b className={routeHealth.critical ? "critical" : routeHealth.total ? "warning" : "good"}>
                        {routeHealth.critical
                          ? `${routeHealth.critical} issue${routeHealth.critical === 1 ? "" : "s"}`
                          : routeHealth.total
                            ? `${routeHealth.total} review`
                            : "Good"}
                      </b>
                    </button>
                  </header>
                  <div
                    className="route-card-sequence"
                    aria-label={`${route.resourceName} ${homeLegs.showStartHome && homeLegs.showReturnHome ? "home-to-home" : "filtered"} booked route sequence`}
                  >
                    {homeLegs.showStartHome ? (
                      <span
                        className="route-card-home"
                        role="img"
                        aria-label={`${route.resourceName} home base, ${route.base?.base}`}
                        title={route.base?.base}
                      >
                        ⌂
                      </span>
                    ) : null}
                    {route.stops.map((stop, stopIndex) => {
                      const legDuration =
                        stop.inboundLegIndex === null
                          ? null
                          : road?.legDurationsMinutes?.[stop.inboundLegIndex] ?? null;
                      const showInboundLeg = homeLegs.showStartHome || stopIndex > 0;
                      return (
                        <span className="route-card-step" key={stop.id}>
                          {showInboundLeg ? (
                            <span
                              className={`route-card-leg${legDuration === null ? " unavailable" : ""}`}
                              aria-label={
                                legDuration === null
                                  ? `Travel to stop ${stop.sequence} unavailable`
                                  : `${formatDuration(legDuration)} travel to stop ${stop.sequence}`
                              }
                            >
                              <small>{legDuration === null ? "—" : formatDuration(legDuration)}</small>
                            </span>
                          ) : null}
                          <button
                            type="button"
                            style={{ "--route-colour": route.colour } as CSSProperties}
                            className={`${stop.isComplete ? "complete" : ""}${selectedVisitId === stop.id ? " selected" : ""}`}
                            aria-label={`Show stop ${stop.sequence}, ${stop.companyName}`}
                            aria-pressed={selectedVisitId === stop.id}
                            onClick={() => onRouteFocus(route, stop.id)}
                          >
                            {stop.isComplete ? "✓" : stop.sequence}
                          </button>
                        </span>
                      );
                    })}
                    {homeLegs.showReturnHome ? (
                      <span className="route-card-return">
                        <span
                          className={`route-card-leg return${returnLegDuration === null ? " unavailable" : ""}`}
                          aria-label={
                            returnLegDuration === null
                              ? "Return travel home unavailable"
                              : `${formatDuration(returnLegDuration)} return travel home`
                          }
                        >
                          <small>{returnLegDuration === null ? "—" : formatDuration(returnLegDuration)}</small>
                        </span>
                        <span
                          className="route-card-home return"
                          role="img"
                          aria-label={`Return to ${route.resourceName} home base, ${route.base?.base}`}
                          title={`Return to ${route.base?.base}`}
                        >
                          ⌂
                        </span>
                      </span>
                    ) : null}
                  </div>
                  <div className="route-stops">
                    {route.stops.map((stop) => (
                      <div
                        className={`route-stop-row${stop.isComplete ? " complete" : ""}${selectedVisitId === stop.id ? " selected" : ""}${stop.isOutOfRange ? " out-of-range" : ""}`}
                        key={stop.id}
                        title={
                          stop.isOutOfRange
                            ? `Engineer: ${route.resourceName} — outside routing range, travel not calculated`
                            : `Engineer: ${route.resourceName}`
                        }
                      >
                        <button
                          className="route-stop-focus"
                          aria-label={`Show ${stop.ticketNumber || stop.companyName} on map`}
                          aria-pressed={selectedVisitId === stop.id}
                          title="Show on map"
                          onClick={() => onRouteFocus(route, stop.id)}
                        >
                          <span>{stop.isComplete ? "✓" : stop.sequence}</span>
                        </button>
                        <button
                          type="button"
                          className="route-stop-ticket"
                          aria-label={`Show ${stop.ticketNumber || stop.companyName} on map`}
                          aria-pressed={selectedVisitId === stop.id}
                          onClick={() => onRouteFocus(route, stop.id)}
                        >
                          <strong>{formatTime(stop.startDateTime)} · {stop.companyName}</strong>
                          <small>{stop.ticketNumber || `SC ${stop.serviceCallId}`} · {stop.city || stop.postcode}</small>
                          <span className={`route-stop-meta job-type-${stop.jobType ?? "other"}`}>
                            {jobTypeLabel(stop.jobType, stop.queueLabel)} · {formatDuration(stop.durationMinutes)} · {stop.isComplete ? "Complete" : "Open"}
                          </span>
                          {stop.isOutOfRange && (
                            <span className="route-stop-out-of-range">
                              Outside routing range · travel not calculated
                            </span>
                          )}
                        </button>
                        {stop.autotaskUrl && (
                          <AutotaskLink
                            className="route-stop-autotask"
                            href={stop.autotaskUrl}
                            label={`Open ${stop.ticketNumber || "ticket"} in Autotask`}
                          >
                            <span
                              className="autotask-favicon"
                              aria-hidden="true"
                            />
                          </AutotaskLink>
                        )}
                      </div>
                    ))}
                  </div>
                  <footer>
                    <span>
                      {isThirdParty
                        ? "Not routed"
                        : !hasMappedStop
                          ? "Locations unavailable"
                          : unmappedStops
                            ? `${unmappedStops} location${unmappedStops === 1 ? "" : "s"} unavailable`
                            : failedLegs
                              ? `${failedLegs} road leg${failedLegs === 1 ? "" : "s"} unavailable`
                              : road?.error
                                ? "Route unavailable"
                                : road
                                  ? formatDuration(road.totalDurationMinutes ?? 0)
                                  : "Route pending"}
                    </span>
                    <button type="button" onClick={() => onRouteFocus(route)}>
                      View route
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
        </section>
      ))}
      {compactSummaryRoutes.length ? (
        <details className="route-summary-secondary">
          <summary>
            <span>Other booked work</span>
            <small>
              {compactSummaryRoutes.length} unrouted or third-party route{compactSummaryRoutes.length === 1 ? "" : "s"}
            </small>
            <b>Show</b>
          </summary>
          <div className="route-summary-secondary-list">
            {compactSummaryRoutes.map((route) => {
              const isThirdParty = route.stops[0]?.ownerType === "third-party";
              const hasMappedStop = route.stops.some(
                (stop) => stop.latitude !== null && stop.longitude !== null,
              );
              const reason = isThirdParty
                ? "Third-party attendance"
                : route.resourceId === null
                  ? "No recognised engineer"
                  : !hasMappedStop
                    ? "Location unavailable"
                    : route.stops.every((stop) => stop.isOutOfRange)
                      ? "Outside routing range"
                      : "Road route unavailable";
              const routeHealth = issueCountsByRoute.get(route.id)?.total ?? 0;
              return (
                <button
                  type="button"
                  key={route.id}
                  className={selectedRouteId === route.id ? "selected" : ""}
                  aria-pressed={selectedRouteId === route.id}
                  onClick={() => onRouteFocus(route)}
                >
                  <i style={{ background: route.colour }}>
                    {routeInitials(route.resourceName)}
                  </i>
                  <span>
                    <strong>{route.resourceName}</strong>
                    <small>{reason} · {route.stops.length} visit{route.stops.length === 1 ? "" : "s"}</small>
                  </span>
                  {routeHealth ? <b>{routeHealth} review</b> : null}
                </button>
              );
            })}
          </div>
        </details>
      ) : null}
    </div>
  );
}
