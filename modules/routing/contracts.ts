import type { ScheduledVisit } from "@/modules/work/contracts";
import type { EngineerBase } from "@/modules/engineers/contracts";

export type RouteStop = ScheduledVisit & {
  sequence: number;
  inboundLegIndex: number | null;
  /** Booked too far from the engineer's base to be a drivable leg (e.g. an
   *  overseas assignment). Shown in the route, excluded from travel geometry. */
  isOutOfRange: boolean;
};

export type EngineerRoute = {
  id: string;
  resourceId: number | null;
  resourceName: string;
  base: EngineerBase | null;
  /** The stored palette position; null means a deterministic legacy fallback. */
  colourIndex?: number | null;
  colour: string;
  stops: RouteStop[];
  coordinates: Array<[number, number]>;
  returnLegIndex: number | null;
};

export type RoadRoute = {
  id: string;
  geometry?: Array<[number, number]>;
  legGeometries?: Array<Array<[number, number]>>;
  legDurationsMinutes?: Array<number | null>;
  legDistancesKm?: Array<number | null>;
  legErrors?: Array<string | null>;
  totalDurationMinutes?: number;
  totalDistanceKm?: number;
  error?: string;
};

export type RouteIssue = {
  id: string;
  kind:
    | "road-route-unavailable"
    | "road-leg-unavailable"
    | "missing-base"
    | "missing-location"
    | "missing-ticket-link"
    | "out-of-range"
    | "unassigned"
    | "booking-overlap"
    | "insufficient-travel"
    | "tight-travel";
  severity: "critical" | "warning" | "data";
  routeId: string;
  resourceId: number | null;
  resourceName: string;
  visitId: string | null;
  title: string;
  detail: string;
};

export type { RouteSuggestion, RouteSuggestionContext, RouteSuggestionMethod } from "./suggestions";

export type { StaticRoadTiming } from "./timing";
