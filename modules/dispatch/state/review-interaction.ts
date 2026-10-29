import { routeFilterRegions } from "../model/regions";
import type { RouteFilterRegion } from "../model/regions";

export type DispatchReviewRouteSort = "issues" | "name" | "first-job";

export type DispatchReviewInteractionState = {
  date: string;
  showThirdParty: boolean;
  showReadyToBook: boolean;
  suggestionRadiusKm: number;
  focusedDemandId: string | null;
  showOpenVisits: boolean;
  showCompleteVisits: boolean;
  selectedRouteId: string;
  hoveredRouteId: string | null;
  routeFocusToken: number;
  visibleMarkerFitToken: number;
  selectionClearToken: number;
  engineerFilterRouteId: string;
  selectedVisitId: string | null;
  detailVisitId: string | null;
  detailDemandId: string | null;
  selectedRegions: Set<RouteFilterRegion>;
  engineerQuery: string;
  engineerPickerOpen: boolean;
  routeSort: DispatchReviewRouteSort;
};

export type DispatchReviewInteractionAction =
  | { type: "clear-selection" }
  | { type: "fit-visible" }
  | { type: "focus-route"; routeId: string; visitId?: string | null }
  | { type: "focus-map-demand"; demandId: string; routeId: string | null }
  | { type: "focus-rail-demand"; demandId: string; routeId: string | null; anchorVisitId: string | null }
  | { type: "focus-timeline-suggestion"; demandId: string; routeId: string; anchorVisitId: string | null }
  | { type: "show-unassigned" }
  | { type: "show-nearby-suggestions" }
  | { type: "preserve-loaded-visit"; visitIds: ReadonlySet<string> }
  | { type: "toggle-open-visits"; selectedVisitIsComplete: boolean | null | undefined }
  | { type: "toggle-complete-visits"; selectedVisitIsComplete: boolean | null | undefined }
  | { type: "toggle-third-party" }
  | { type: "toggle-ready-to-book" }
  | { type: "set-suggestion-radius"; radiusKm: number }
  | { type: "set-hovered-route"; routeId: string | null }
  | { type: "set-regions"; regions: Set<RouteFilterRegion> }
  | { type: "toggle-region"; region: RouteFilterRegion }
  | { type: "set-engineer-query"; query: string }
  | { type: "clear-engineer-query" }
  | { type: "select-engineer-filter"; routeId: string; resourceName: string }
  | { type: "set-engineer-picker-open"; open: boolean }
  | { type: "set-route-sort"; sort: DispatchReviewRouteSort }
  | { type: "open-visit-details"; visitId: string | null }
  | { type: "open-demand-details"; demandId: string | null }
  | { type: "change-date"; date: string }
  | { type: "reset-review-filters" };

export function initialDispatchReviewInteractionState(
  date: string,
): DispatchReviewInteractionState {
  return {
    date,
    showThirdParty: true,
    showReadyToBook: true,
    suggestionRadiusKm: 10,
    focusedDemandId: null,
    showOpenVisits: true,
    showCompleteVisits: true,
    selectedRouteId: "all",
    hoveredRouteId: null,
    routeFocusToken: 0,
    visibleMarkerFitToken: 0,
    selectionClearToken: 0,
    engineerFilterRouteId: "all",
    selectedVisitId: null,
    detailVisitId: null,
    detailDemandId: null,
    selectedRegions: new Set(routeFilterRegions),
    engineerQuery: "",
    engineerPickerOpen: false,
    routeSort: "issues",
  };
}

function clearSelection(state: DispatchReviewInteractionState) {
  return {
    ...state,
    selectedRouteId: "all",
    selectedVisitId: null,
    focusedDemandId: null,
  };
}

function clearSelectionAndEngineerFilter(state: DispatchReviewInteractionState) {
  return {
    ...clearSelection(state),
    engineerFilterRouteId: "all",
    engineerQuery: "",
  };
}

/** Pure interaction transitions used by every Dispatch Review view. */
export function dispatchReviewInteractionReducer(
  state: DispatchReviewInteractionState,
  action: DispatchReviewInteractionAction,
): DispatchReviewInteractionState {
  switch (action.type) {
    case "clear-selection":
      return {
        ...clearSelection(state),
        selectionClearToken: state.selectionClearToken + 1,
      };
    case "fit-visible":
      return {
        ...clearSelection(state),
        selectionClearToken: state.selectionClearToken + 1,
        visibleMarkerFitToken: state.visibleMarkerFitToken + 1,
      };
    case "focus-route":
      return {
        ...state,
        selectedRouteId: action.routeId,
        selectedVisitId: action.visitId ?? null,
        focusedDemandId: null,
        routeFocusToken: state.routeFocusToken + 1,
      };
    case "focus-map-demand":
      return {
        ...state,
        focusedDemandId: action.demandId,
        selectedRouteId: action.routeId ?? "all",
        selectedVisitId: null,
        routeFocusToken: state.routeFocusToken + 1,
      };
    case "focus-rail-demand":
      return {
        ...state,
        showReadyToBook: true,
        focusedDemandId: action.demandId,
        selectedRouteId: action.routeId ?? "all",
        selectedVisitId: action.anchorVisitId,
        routeFocusToken: state.routeFocusToken + 1,
      };
    case "focus-timeline-suggestion":
      return {
        ...state,
        focusedDemandId: action.demandId,
        selectedRouteId: action.routeId,
        selectedVisitId: action.anchorVisitId,
        routeFocusToken: state.routeFocusToken + 1,
      };
    case "show-unassigned":
      return {
        ...clearSelection(state),
        showReadyToBook: true,
        routeFocusToken: state.routeFocusToken + 1,
      };
    case "show-nearby-suggestions":
      return { ...state, showReadyToBook: true };
    case "preserve-loaded-visit":
      return state.selectedVisitId && !action.visitIds.has(state.selectedVisitId)
        ? { ...state, selectedVisitId: null }
        : state;
    case "toggle-open-visits": {
      const showOpenVisits = !state.showOpenVisits;
      return {
        ...state,
        showOpenVisits,
        selectedVisitId:
          !showOpenVisits && action.selectedVisitIsComplete !== true
            ? null
            : state.selectedVisitId,
      };
    }
    case "toggle-complete-visits": {
      const showCompleteVisits = !state.showCompleteVisits;
      return {
        ...state,
        showCompleteVisits,
        selectedVisitId:
          !showCompleteVisits && action.selectedVisitIsComplete === true
            ? null
            : state.selectedVisitId,
      };
    }
    case "toggle-third-party":
      return {
        ...clearSelectionAndEngineerFilter(state),
        showThirdParty: !state.showThirdParty,
      };
    case "toggle-ready-to-book":
      return { ...state, showReadyToBook: !state.showReadyToBook };
    case "set-suggestion-radius":
      return { ...state, suggestionRadiusKm: action.radiusKm };
    case "set-hovered-route":
      return { ...state, hoveredRouteId: action.routeId };
    case "set-regions":
      return {
        ...clearSelectionAndEngineerFilter(state),
        selectedRegions: action.regions,
        engineerPickerOpen: false,
      };
    case "toggle-region": {
      const selectedRegions = new Set(state.selectedRegions);
      if (selectedRegions.has(action.region)) selectedRegions.delete(action.region);
      else selectedRegions.add(action.region);
      return {
        ...clearSelectionAndEngineerFilter(state),
        selectedRegions,
        engineerPickerOpen: false,
      };
    }
    case "set-engineer-query":
      return {
        ...state,
        engineerQuery: action.query,
        engineerFilterRouteId: "all",
        selectedVisitId: null,
        focusedDemandId: null,
        engineerPickerOpen: true,
      };
    case "clear-engineer-query":
      return {
        ...state,
        engineerQuery: "",
        engineerFilterRouteId: "all",
        selectedVisitId: null,
        focusedDemandId: null,
        engineerPickerOpen: true,
      };
    case "select-engineer-filter":
      return {
        ...clearSelection(state),
        engineerFilterRouteId: action.routeId,
        engineerQuery: action.resourceName,
        engineerPickerOpen: false,
      };
    case "set-engineer-picker-open":
      return { ...state, engineerPickerOpen: action.open };
    case "set-route-sort":
      return { ...state, routeSort: action.sort };
    case "open-visit-details":
      return { ...state, detailVisitId: action.visitId };
    case "open-demand-details":
      return { ...state, detailDemandId: action.demandId };
    case "change-date":
      if (action.date === state.date) return state;
      return {
        ...clearSelection(state),
        date: action.date,
        showOpenVisits: true,
        showCompleteVisits: true,
        engineerFilterRouteId: "all",
        detailVisitId: null,
        selectedRegions: new Set(routeFilterRegions),
        engineerQuery: "",
        engineerPickerOpen: false,
        selectionClearToken: state.selectionClearToken + 1,
      };
    case "reset-review-filters":
      return {
        ...state,
        selectedRegions: new Set(routeFilterRegions),
        engineerFilterRouteId: "all",
        engineerQuery: "",
        engineerPickerOpen: false,
        showOpenVisits: true,
        showCompleteVisits: true,
        showThirdParty: true,
        showReadyToBook: true,
      };
  }
}
