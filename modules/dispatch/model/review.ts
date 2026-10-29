import { groupBy } from "../../../shared/collections";
import {
  addIsoCalendarDays,
  isIsoCalendarDate,
  londonCalendarDate,
} from "../../../shared/calendar";
import {
  compareRouteRegions,
  routeFilterRegions,
  routeRegion,
  filterRegionForDemand,
} from "./regions";
import type { RouteFilterRegion } from "./regions";
import type { MapSuggestionContext } from "@/modules/map/contracts";
import type { PlanningDemandItem, ScheduledVisit } from "@/modules/work/contracts";
import { getResourceColour } from "@/modules/engineers/domain";
import type {
  RouteSuggestion,
  EngineerRoute,
  RoadRoute,
  RouteIssue,
  RouteStop,
} from "@/modules/routing/contracts";
import { routeTimingForLeg } from "@/modules/routing/domain";
import type { EngineerRosterEntry } from "@/modules/engineers/contracts";

export function resolveRequestedReviewDate(
  requestedDate: string | null,
  fallbackDate = londonCalendarDate(),
) {
  return requestedDate && isIsoCalendarDate(requestedDate)
    ? requestedDate
    : fallbackDate;
}

export function thirdPartyScheduledVisitCount(
  visits: readonly ScheduledVisit[],
) {
  return visits.filter((visit) => visit.ownerType === "third-party").length;
}

export function adjacentReviewDate(
  date: string,
  direction: "next" | "previous",
) {
  return addIsoCalendarDays(date, direction === "next" ? 1 : -1);
}

export function projectVisibleRoutes(
  canonicalRoutes: EngineerRoute[],
  filters: {
    showOpenVisits: boolean;
    showCompleteVisits: boolean;
    showThirdParty: boolean;
  },
) {
  return canonicalRoutes
    .filter(
      (route) =>
        filters.showThirdParty ||
        route.stops[0]?.ownerType !== "third-party",
    )
    .map((route) => ({
      ...route,
      // Keep canonical sequence and leg indexes. Do not join non-adjacent calls.
      stops: route.stops.filter((stop) =>
        stop.isComplete
          ? filters.showCompleteVisits
          : filters.showOpenVisits,
      ),
    }))
    .filter((route) => route.stops.length > 0);
}

/**
 * Keep the current selection visible without changing explicit filters.
 * A hidden visit is added back as a selected exception; other stops stay filtered.
 */
export function resolveReviewRoutes(input: {
  canonicalRoutes: EngineerRoute[];
  projectedRoutes: EngineerRoute[];
  visibleRoutes: EngineerRoute[];
  selectedRouteId: string;
  selectedVisitId: string | null;
}): { routes: EngineerRoute[]; focusedOutsideFilters: boolean } {
  const {
    canonicalRoutes,
    projectedRoutes,
    visibleRoutes,
    selectedRouteId,
    selectedVisitId,
  } = input;
  const canonicalRoute = selectedVisitId
    ? canonicalRoutes.find((route) =>
        route.stops.some((stop) => stop.id === selectedVisitId),
      )
    : selectedRouteId !== "all"
      ? canonicalRoutes.find((route) => route.id === selectedRouteId)
      : null;
  if (!canonicalRoute) {
    return { routes: visibleRoutes, focusedOutsideFilters: false };
  }

  const visibleRoute = visibleRoutes.find(
    (route) => route.id === canonicalRoute.id,
  );
  if (
    visibleRoute &&
    (!selectedVisitId ||
      visibleRoute.stops.some((stop) => stop.id === selectedVisitId))
  ) {
    return { routes: visibleRoutes, focusedOutsideFilters: false };
  }

  const projectedRoute = projectedRoutes.find(
    (route) => route.id === canonicalRoute.id,
  );
  let focusedRoute = projectedRoute ?? canonicalRoute;
  if (selectedVisitId) {
    const focusedStop = canonicalRoute.stops.find(
      (stop) => stop.id === selectedVisitId,
    );
    if (!focusedStop) {
      return { routes: visibleRoutes, focusedOutsideFilters: false };
    }
    const stopIds = new Set(
      (projectedRoute?.stops ?? []).map((stop) => stop.id),
    );
    stopIds.add(focusedStop.id);
    focusedRoute = {
      ...canonicalRoute,
      stops: canonicalRoute.stops.filter((stop) => stopIds.has(stop.id)),
    };
  }

  const routeAlreadyInScope = visibleRoutes.some(
    (route) => route.id === focusedRoute.id,
  );
  return {
    routes: routeAlreadyInScope
      ? visibleRoutes.map((route) =>
          route.id === focusedRoute.id ? focusedRoute : route,
        )
      : [...visibleRoutes, focusedRoute],
    focusedOutsideFilters: true,
  };
}

/** Which home legs a filtered strip may state. Never relabel a mid-route as Home. */
export function routeCardHomeLegs(
  route: EngineerRoute,
  canonicalRoute: EngineerRoute,
) {
  const firstVisible = route.stops[0];
  const lastVisible = route.stops.at(-1);
  const firstCanonicalRoutable = canonicalRoute.stops.find(
    (stop) => stop.inboundLegIndex !== null,
  );
  const lastCanonicalRoutable = canonicalRoute.stops.findLast(
    (stop) => stop.inboundLegIndex !== null,
  );
  const hasInternalBase = Boolean(
    route.base && route.stops[0]?.ownerType !== "third-party",
  );
  return {
    showStartHome: Boolean(
      hasInternalBase &&
        firstVisible &&
        firstVisible.id === firstCanonicalRoutable?.id,
    ),
    showReturnHome: Boolean(
      hasInternalBase &&
        canonicalRoute.returnLegIndex !== null &&
        lastVisible &&
        lastVisible.id === lastCanonicalRoutable?.id,
    ),
  };
}

export type RouteDayOverviewItem =
  | {
      type: "home";
      id: string;
      role: "start" | "return";
      baseLabel: string;
      time: string | null;
    }
  | {
      type: "travel";
      id: string;
      minutes: number | null;
      destination: "stop" | "home";
    }
  | {
      type: "stop";
      id: string;
      stop: RouteStop;
    };

function roadLegMinutes(road: RoadRoute | undefined, legIndex: number | null) {
  if (legIndex === null) return null;
  const duration = road?.legDurationsMinutes?.[legIndex];
  return typeof duration === "number" && Number.isFinite(duration) && duration >= 0
    ? duration
    : null;
}

/** Rail day rows: home boundaries, static travel, and visible stops. */
export function buildRouteDayOverview(args: {
  route: EngineerRoute;
  canonicalRoute: EngineerRoute;
  road?: RoadRoute;
}): RouteDayOverviewItem[] {
  const { route, canonicalRoute, road } = args;
  const homeLegs = routeCardHomeLegs(route, canonicalRoute);
  const items: RouteDayOverviewItem[] = [];
  const baseLabel = route.base?.base ?? "home";

  route.stops.forEach((stop, index) => {
    const showInbound = (index === 0 && homeLegs.showStartHome) || index > 0;
    if (index === 0 && homeLegs.showStartHome) {
      const inbound =
        stop.inboundLegIndex === null
          ? null
          : routeTimingForLeg(canonicalRoute, road, stop.inboundLegIndex);
      items.push({
        type: "home",
        id: `${route.id}:start`,
        role: "start",
        baseLabel,
        time:
          inbound?.availability === "available" && inbound.kind === "inbound"
            ? inbound.estimatedTravelStartDateTime
            : null,
      });
    }
    if (showInbound) {
      items.push({
        type: "travel",
        id: `${route.id}:travel:${stop.id}`,
        minutes: roadLegMinutes(road, stop.inboundLegIndex),
        destination: "stop",
      });
    }
    items.push({ type: "stop", id: stop.id, stop });
  });

  if (homeLegs.showReturnHome && canonicalRoute.returnLegIndex !== null) {
    const returning = routeTimingForLeg(
      canonicalRoute,
      road,
      canonicalRoute.returnLegIndex,
    );
    items.push({
      type: "travel",
      id: `${route.id}:travel:home`,
      minutes: roadLegMinutes(road, canonicalRoute.returnLegIndex),
      destination: "home",
    });
    items.push({
      type: "home",
      id: `${route.id}:return`,
      role: "return",
      baseLabel,
      time:
        returning.availability === "available" && returning.kind === "return"
          ? returning.estimatedArrivalDateTime
          : null,
    });
  }

  return items;
}

/** Full cards are for internal routes with a real road journey. Other work uses a compact row. */
export type ReviewDayStats = {
  coveragePercent: number | null;
  capacityMinutes: number | null;
  avgDriveMinutes: number | null;
};

function requiredBookedVisitCount(routes: readonly EngineerRoute[]) {
  return routes.reduce(
    (total, route) =>
      total +
      route.stops.filter((stop) => stop.ownerType === "internal").length,
    0,
  );
}

function interVisitTravelMinutes(
  routes: readonly EngineerRoute[],
  roadById: ReadonlyMap<string, RoadRoute>,
) {
  const minutes: number[] = [];
  for (const route of routes) {
    const road = roadById.get(route.id);
    route.stops.forEach((stop, index) => {
      if (index === 0 || stop.inboundLegIndex === null) return;
      const duration = road?.legDurationsMinutes?.[stop.inboundLegIndex];
      if (
        typeof duration === "number" &&
        Number.isFinite(duration) &&
        duration >= 0
      ) {
        minutes.push(duration);
      }
    });
  }
  return minutes;
}

function requiredRoadTravelMinutes(
  routes: readonly EngineerRoute[],
  roadById: ReadonlyMap<string, RoadRoute>,
) {
  let total = 0;

  for (const route of routes) {
    const internalStops = route.stops.filter(
      (stop) => stop.ownerType === "internal",
    );
    if (internalStops.length === 0) continue;
    if (!route.base || route.returnLegIndex === null) return null;

    const requiredLegIndexes: number[] = [];
    for (const stop of internalStops) {
      if (stop.inboundLegIndex === null) return null;
      requiredLegIndexes.push(stop.inboundLegIndex);
    }
    requiredLegIndexes.push(route.returnLegIndex);

    const road = roadById.get(route.id);
    if (!road || road.error) return null;
    for (const legIndex of requiredLegIndexes) {
      if (road.legErrors?.[legIndex]) return null;
      const duration = road.legDurationsMinutes?.[legIndex];
      if (
        typeof duration !== "number" ||
        !Number.isFinite(duration) ||
        duration < 0
      ) {
        return null;
      }
      total += duration;
    }
  }

  return total;
}

/** Day stats for the selected scope. Suggestions are not required work. */
export function reviewDayStats(input: {
  routes: readonly EngineerRoute[];
  roadRoutes: readonly RoadRoute[];
  unassignedRequiredCount: number | null;
  engineerCapacityMinutes: number;
}): ReviewDayStats {
  const roadById = new Map(input.roadRoutes.map((road) => [road.id, road]));
  const bookedVisits = requiredBookedVisitCount(input.routes);
  const unassigned = input.unassignedRequiredCount;
  const totalRequired =
    unassigned === null ? null : bookedVisits + unassigned;
  const coveragePercent =
    totalRequired === null || totalRequired === 0
      ? null
      : Math.round((bookedVisits / totalRequired) * 100);

  const bookedWorkMinutes = input.routes.reduce(
    (total, route) =>
      total +
      route.stops
        .filter((stop) => stop.ownerType === "internal")
        .reduce((sum, stop) => sum + stop.durationMinutes, 0),
    0,
  );
  const travelMinutes = requiredRoadTravelMinutes(
    input.routes,
    roadById,
  );
  const capacityMinutes =
    input.engineerCapacityMinutes <= 0 || travelMinutes === null
      ? null
      : Math.max(
          0,
          input.engineerCapacityMinutes -
            bookedWorkMinutes -
            travelMinutes,
        );

  const drives = interVisitTravelMinutes(input.routes, roadById);
  const avgDriveMinutes =
    drives.length === 0
      ? null
      : Math.round(
          drives.reduce((total, minutes) => total + minutes, 0) / drives.length,
        );

  return { coveragePercent, capacityMinutes, avgDriveMinutes };
}

export function isPrimaryRouteSummary(route: EngineerRoute) {
  return Boolean(
    route.resourceId !== null &&
      route.base &&
      route.stops[0]?.ownerType === "internal" &&
      route.coordinates.length >= 2 &&
      route.stops.some(
        (stop) =>
          !stop.isOutOfRange &&
          stop.latitude !== null &&
          stop.longitude !== null,
      ),
  );
}

export type ReviewRegionCount = {
  booked: number;
  engineers: number;
  unbooked: number;
};

/** Region control facts across booked routes, active roster and requested demand. */
export function reviewRegionCounts(input: {
  canonicalRoutes: readonly EngineerRoute[];
  engineers: readonly EngineerRosterEntry[];
  demandItems: readonly PlanningDemandItem[];
}) {
  const counts = new Map<RouteFilterRegion, ReviewRegionCount>(
    routeFilterRegions.map((region) => [
      region,
      { booked: 0, engineers: 0, unbooked: 0 },
    ]),
  );
  const bookedResourceIds = new Set<number>();
  input.canonicalRoutes.forEach((route) => {
    const region = route.base?.region;
    const entry = region ? counts.get(region) : undefined;
    if (entry) {
      entry.booked += 1;
      entry.engineers += 1;
    }
    if (route.resourceId !== null) bookedResourceIds.add(route.resourceId);
  });
  input.engineers.forEach((engineer) => {
    if (
      !engineer.active ||
      engineer.resourceId === null ||
      bookedResourceIds.has(engineer.resourceId)
    ) return;
    const entry = counts.get(engineer.region);
    if (entry) entry.engineers += 1;
  });
  input.demandItems.forEach((item) => {
    if (item.requestType !== "requested") return;
    const region = filterRegionForDemand(item);
    const entry = region ? counts.get(region) : undefined;
    if (entry) entry.unbooked += 1;
  });
  return counts;
}

/** Active engineers without booked routes, represented as marker-only home routes. */
export function buildUnbookedEngineerRoutes(input: {
  canonicalRoutes: readonly EngineerRoute[];
  engineers: readonly EngineerRosterEntry[];
  selectedRegions: ReadonlySet<RouteFilterRegion>;
}): EngineerRoute[] {
  const bookedResourceIds = new Set(
    input.canonicalRoutes.flatMap((route) =>
      route.resourceId === null ? [] : [route.resourceId],
    ),
  );
  return input.engineers
    .filter(
      (engineer) =>
        engineer.active &&
        engineer.resourceId !== null &&
        !bookedResourceIds.has(engineer.resourceId) &&
        input.selectedRegions.has(engineer.region),
    )
    .map((engineer) => ({
      id: `unbooked-engineer-${engineer.resourceId}`,
      resourceId: engineer.resourceId,
      resourceName: engineer.name,
      base: engineer,
      colourIndex: engineer.colourIndex,
      colour: getResourceColour(engineer),
      stops: [],
      coordinates: [[engineer.latitude, engineer.longitude]],
      returnLegIndex: null,
    }));
}

export function suggestionContextsForRoutes(
  canonicalRoutes: readonly EngineerRoute[],
  suggestions: readonly RouteSuggestion[],
): Record<string, MapSuggestionContext> {
  const routeColourById = new Map(
    canonicalRoutes.map((route) => [route.id, route.colour]),
  );
  return Object.fromEntries(
    suggestions.map((suggestion) => [
      suggestion.demandId,
      {
        routeId: suggestion.routeId,
        stopId: suggestion.stopId,
        routeColour: routeColourById.get(suggestion.routeId) ?? "#7c4dcc",
        resourceName: suggestion.resourceName,
        distanceKm: suggestion.distanceKm,
        method: suggestion.method,
        stopCompany: suggestion.stopCompany,
        stopStartDateTime: suggestion.stopStartDateTime,
      },
    ]),
  );
}

export function issueSeveritiesByVisit(
  issues: readonly RouteIssue[],
): Record<string, RouteIssue["severity"]> {
  const priority = { data: 0, warning: 1, critical: 2 } as const;
  return issues.reduce<Record<string, RouteIssue["severity"]>>(
    (severities, issue) => {
      if (!issue.visitId) return severities;
      const current = severities[issue.visitId];
      if (!current || priority[issue.severity] > priority[current]) {
        severities[issue.visitId] = issue.severity;
      }
      return severities;
    },
    {},
  );
}

export type RouteIssueCount = { total: number; critical: number };

export function issueCountsForRoutes(issues: readonly RouteIssue[]) {
  const counts = new Map<string, RouteIssueCount>();
  issues.forEach((issue) => {
    const current = counts.get(issue.routeId) ?? { total: 0, critical: 0 };
    counts.set(issue.routeId, {
      total: current.total + 1,
      critical: current.critical + (issue.severity === "critical" ? 1 : 0),
    });
  });
  return counts;
}

export function sortReviewRoutes(
  routes: readonly EngineerRoute[],
  sort: "issues" | "name" | "first-job",
  issueCounts: ReadonlyMap<string, RouteIssueCount>,
) {
  const routeStart = (route: EngineerRoute) =>
    new Date(route.stops[0]?.startDateTime ?? 0).getTime();
  return [...routes].sort((first, second) => {
    if (sort === "first-job") {
      const startDifference = routeStart(first) - routeStart(second);
      if (startDifference) return startDifference;
    }
    if (sort === "issues") {
      const firstIssues = issueCounts.get(first.id) ?? { total: 0, critical: 0 };
      const secondIssues = issueCounts.get(second.id) ?? { total: 0, critical: 0 };
      if (secondIssues.critical !== firstIssues.critical) {
        return secondIssues.critical - firstIssues.critical;
      }
      if (secondIssues.total !== firstIssues.total) {
        return secondIssues.total - firstIssues.total;
      }
    }
    return first.resourceName.localeCompare(second.resourceName, "en-GB");
  });
}

export function groupReviewRoutes(routes: readonly EngineerRoute[]) {
  const grouped = groupBy(
    routes.filter((route) => routeRegion(route) !== "Unassigned"),
    routeRegion,
  );
  return [...grouped.entries()]
    .sort(([first], [second]) => compareRouteRegions(first, second))
    .map(([region, groupedRoutes]) => ({ region, routes: groupedRoutes }));
}

export function groupIssuesByVisit(issues: readonly RouteIssue[]) {
  const grouped = new Map<string, RouteIssue[]>();
  for (const issue of issues) {
    if (!issue.visitId) continue;
    const bucket = grouped.get(issue.visitId);
    if (bucket) bucket.push(issue);
    else grouped.set(issue.visitId, [issue]);
  }
  return grouped;
}
