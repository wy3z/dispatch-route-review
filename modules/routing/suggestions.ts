import { engineerWorkingMinutesForDate } from "@/modules/engineers/domain";
import { haversineKm } from "../../shared/coordinates";
import type { PlanningDemandItem } from "@/modules/work/contracts";
import { formatTime } from "../../shared/formatting";
import type { EngineerRosterEntry } from "@/modules/engineers/contracts";
import type { EngineerRoute } from "./contracts";

export type RouteSuggestionMethod =
  | "nearest-upcoming-stop"
  | "nearest-home-base";

export type RouteSuggestionDateMode = "historical" | "today" | "future";

export type RouteSuggestionContext = {
  selectedDate: string;
  backlogDate: string;
  mode: RouteSuggestionDateMode;
};

export type RouteSuggestion = {
  id: string;
  method: RouteSuggestionMethod;
  demandId: string;
  routeId: string;
  resourceId: number;
  resourceName: string;
  stopId: string;
  stopCompany: string;
  stopStartDateTime: string;
  distanceKm: number;
};

export function resolveRouteSuggestionContext(args: {
  selectedDate: string;
  backlogDate: string;
}): RouteSuggestionContext {
  const mode: RouteSuggestionDateMode =
    args.selectedDate < args.backlogDate
      ? "historical"
      : args.selectedDate > args.backlogDate
        ? "future"
        : "today";
  return {
    selectedDate: args.selectedDate,
    backlogDate: args.backlogDate,
    mode,
  };
}

function rosterEntryForRoute(route: EngineerRoute) {
  const base = route.base as Partial<EngineerRosterEntry> | null;
  if (
    !base ||
    base.resourceId !== route.resourceId ||
    typeof base.active !== "boolean" ||
    !Array.isArray(base.workingDays) ||
    typeof base.workdayStart !== "string" ||
    typeof base.workdayEnd !== "string"
  ) {
    return null;
  }
  return base as EngineerRosterEntry;
}

function isCertificationDemand(item: PlanningDemandItem) {
  return [item.companyLabel, item.siteLabel, item.title]
    .join(" ")
    .toLocaleLowerCase("en-GB")
    .includes("certification");
}

export function suggestionNearLabel(
  suggestion: Pick<
    RouteSuggestion,
    "method" | "stopCompany" | "stopStartDateTime"
  >,
) {
  if (suggestion.method === "nearest-home-base") {
    return `home at ${suggestion.stopCompany}`;
  }
  return `${suggestion.stopCompany} at ${formatTime(suggestion.stopStartDateTime)}`;
}

function considerSuggestion(
  nearest: RouteSuggestion | null,
  candidate: RouteSuggestion,
  radiusKm: number,
) {
  if (
    candidate.distanceKm > radiusKm ||
    (nearest && candidate.distanceKm >= nearest.distanceKm)
  ) {
    return nearest;
  }
  return candidate;
}

export function findRouteSuggestions(args: {
  items: PlanningDemandItem[];
  routes: EngineerRoute[];
  radiusKm?: number;
  now?: Date;
  context?: RouteSuggestionContext;
}): RouteSuggestion[] {
  const radiusKm = Math.max(1, args.radiusKm ?? 10);
  const explicitContext =
    args.context;
  if (explicitContext?.mode === "historical") return [];
  const nowMs =
    !explicitContext || explicitContext.mode === "today"
      ? (args.now ?? new Date()).getTime()
      : null;
  const suggestions: RouteSuggestion[] = [];

  for (const item of args.items) {
    if (
      item.requestType !== "requested" ||
      item.readiness !== "eligible" ||
      item.exclusionReason !== null ||
      isCertificationDemand(item) ||
      item.latitude === null ||
      item.longitude === null
    ) {
      continue;
    }
    let nearest: RouteSuggestion | null = null;
    for (const route of args.routes) {
      if (route.resourceId === null) continue;
      if (explicitContext) {
        const engineer = rosterEntryForRoute(route);
        if (
          !engineer ||
          engineerWorkingMinutesForDate(
            engineer,
            explicitContext.selectedDate,
          ) === 0
        ) {
          continue;
        }
      }
      for (const stop of route.stops) {
        if (
          stop.ownerType !== "internal" ||
          stop.isComplete ||
          stop.latitude === null ||
          stop.longitude === null ||
          (nowMs !== null && Date.parse(stop.endDateTime) <= nowMs)
        ) {
          continue;
        }
        nearest = considerSuggestion(
          nearest,
          {
            id: `${item.id}:${route.id}:${stop.id}`,
            method: "nearest-upcoming-stop",
            demandId: item.id,
            routeId: route.id,
            resourceId: route.resourceId,
            resourceName: route.resourceName,
            stopId: stop.id,
            stopCompany: stop.companyName,
            stopStartDateTime: stop.startDateTime,
            distanceKm: haversineKm(
              item.latitude,
              item.longitude,
              stop.latitude,
              stop.longitude,
            ),
          },
          radiusKm,
        );
      }
      if (route.base) {
        nearest = considerSuggestion(
          nearest,
          {
            id: `${item.id}:${route.id}:home`,
            method: "nearest-home-base",
            demandId: item.id,
            routeId: route.id,
            resourceId: route.resourceId,
            resourceName: route.resourceName,
            stopId: `home:${route.id}`,
            stopCompany: route.base.base,
            stopStartDateTime: "",
            distanceKm: haversineKm(
              item.latitude,
              item.longitude,
              route.base.latitude,
              route.base.longitude,
            ),
          },
          radiusKm,
        );
      }
    }
    if (nearest) suggestions.push(nearest);
  }
  return suggestions.sort((first, second) => first.distanceKm - second.distanceKm);
}
