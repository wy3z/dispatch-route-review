import type { PlanningDemandItem } from "@/modules/work/contracts";
import type {
  RouteSuggestionMethod,
  EngineerRoute,
  RoadRoute,
  RouteIssue,
  RouteStop,
} from "@/modules/routing/contracts";

export type MapSuggestionContext = {
  routeId: string;
  stopId: string;
  routeColour: string;
  resourceName: string;
  distanceKm: number;
  method: RouteSuggestionMethod;
  stopCompany: string;
  stopStartDateTime: string;
};

export type ReviewMapSelection =
  | { kind: "none" }
  | { kind: "route"; routeId: string }
  | { kind: "visit"; routeId: string; visitId: string }
  | { kind: "demand"; demandId: string; routeId: string | null; anchorVisitId: string | null };

export type ReviewMapScene = {
  booked: {
    routes: EngineerRoute[];
    routeById: ReadonlyMap<string, EngineerRoute>;
    visitById: ReadonlyMap<string, { routeId: string; visit: RouteStop }>;
  };
  roads: ReadonlyMap<string, RoadRoute>;
  /** Authoritative unbooked engineer homes; never booked geometry inputs. */
  homes: ReadonlyMap<string, EngineerRoute>;
  demand: ReadonlyMap<string, PlanningDemandItem>;
  /** Already resolved by the Review model, including hidden selected exceptions. */
  scope: {
    routes: EngineerRoute[];
    demandIds: readonly string[];
    includeOutOfCoverageInFit: boolean;
  };
  annotations: {
    issueSeverityByVisit: Record<string, RouteIssue["severity"]>;
    suggestedDemandIds: string[];
    suggestions: Record<string, MapSuggestionContext>;
  };
};

export type ReviewMapNavigation = {
  /** Monotonic explicit camera requests. */
  focusRequest: number;
  fitVisibleRequest: number;
  clearRequest: number;
  initialFitReady: boolean;
};

export type ReviewMapAction =
  | { type: "select-route"; routeId: string }
  | { type: "preview-route"; routeId: string | null }
  | { type: "select-visit"; visitId: string; routeId: string }
  | { type: "select-demand"; demandId: string }
  | { type: "clear-selection" }
  | { type: "open-visit"; visitId: string }
  | { type: "open-demand"; demandId: string }
  | { type: "popup-visibility"; open: boolean };

/** Renderers own lifecycle, sources, camera and interaction behind this seam. */
export type ReviewMapProps = {
  scene: ReviewMapScene;
  selection: ReviewMapSelection;
  previewRouteId: string | null;
  navigation: ReviewMapNavigation;
  onAction: (action: ReviewMapAction) => void;
};
