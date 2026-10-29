"use client";

import { useMemo } from "react";
import { indexReviewMapBookings, planningMarkersForLayers } from "@/modules/map/domain";
import type { useDispatchReviewController } from "./use-dispatch-review-controller";
import { useRoadRouteReview } from "@/modules/routing/client";
import { engineerWorkingMinutesForDate } from "@/modules/engineers/domain";
import { routeFilterRegions, filterRegionForDemand } from "../model/regions";
import { buildEngineerRoutes, findRouteSuggestions } from "@/modules/routing/domain";
import type {
  PlanningDemandItem,
  ScheduleSnapshot,
  PlanningDemandSnapshot,
} from "@/modules/work/contracts";
import {
  buildUnbookedEngineerRoutes,
  groupReviewRoutes,
  groupIssuesByVisit,
  isPrimaryRouteSummary,
  issueCountsForRoutes,
  issueSeveritiesByVisit,
  projectVisibleRoutes,
  resolveReviewRoutes,
  reviewDayStats,
  reviewRegionCounts,
  sortReviewRoutes,
  suggestionContextsForRoutes,
  thirdPartyScheduledVisitCount,
} from "../model/review";
import { scheduledVisitStatusCounts } from "@/modules/work/domain";
import type { RouteSuggestionContext } from "@/modules/routing/contracts";
import type { EngineerRosterEntry } from "@/modules/engineers/contracts";

type Options = {
  controller: ReturnType<typeof useDispatchReviewController>;
  snapshot: ScheduleSnapshot | null;
  engineers: EngineerRosterEntry[];
  readyToBookSnapshot: PlanningDemandSnapshot | null;
  readyToBookLoading: boolean;
  suggestionContext: RouteSuggestionContext | undefined;
};

/** Derive review projections without changing canonical routes or request identities. */
export function useReviewModel(
  { controller, snapshot, engineers, readyToBookSnapshot, readyToBookLoading, suggestionContext }: Options,
) {
  const {
    date,
    showThirdParty,
    showReadyToBook,
    suggestionRadiusKm,
    focusedDemandId,
    showOpenVisits,
    showCompleteVisits,
    selectedRouteId,
    engineerFilterRouteId,
    selectedVisitId,
    detailVisitId,
    detailDemandId,
    selectedRegions,
    engineerQuery,
    routeSort,
  } = controller;

  const scheduledVisits = useMemo(
    () => (snapshot?.date === date ? snapshot.visits : []),
    [date, snapshot],
  );

  const statusCounts = useMemo(
    () => scheduledVisitStatusCounts(scheduledVisits),
    [scheduledVisits],
  );

  const thirdPartyVisitCount = useMemo(
    () => thirdPartyScheduledVisitCount(scheduledVisits),
    [scheduledVisits],
  );

  const canonicalRoutes = useMemo(
    () => buildEngineerRoutes(scheduledVisits, engineers),
    [engineers, scheduledVisits],
  );

  // Issues use the canonical booked order. Filters must not re-sequence a route.
  const routes = useMemo(
    () =>
      projectVisibleRoutes(canonicalRoutes, {
        showOpenVisits,
        showCompleteVisits,
        showThirdParty,
      }),
    [canonicalRoutes, showCompleteVisits, showOpenVisits, showThirdParty],
  );

  const suggestionRoutes = useMemo(
    () =>
      canonicalRoutes.filter(
        (route) =>
          route.resourceId !== null &&
          (route.base !== null ||
            route.stops.some((stop) => stop.ownerType === "internal")),
      ),
    [canonicalRoutes],
  );

  const { roadRoutes, issues, loading: roadLoading } =
    useRoadRouteReview(canonicalRoutes);

  // Always list every region so the control does not change shape by date.
  const regionOptions = routeFilterRegions;

  // Booked = routes today. Unbooked = outstanding unassigned requests, including
  // EU/Ireland demand that has no covered base. Counted across every region.
  const regionCounts = useMemo(
    () => reviewRegionCounts({
      canonicalRoutes,
      engineers,
      demandItems: readyToBookSnapshot?.items ?? [],
    }),
    [canonicalRoutes, engineers, readyToBookSnapshot],
  );

  const allRegionsSelected = selectedRegions.size === routeFilterRegions.length;

  const regionSelectValue = allRegionsSelected
    ? "all"
    : selectedRegions.size === 1
      ? [...selectedRegions][0]
      : "multiple";

  const totalRegionCounts = useMemo(() => {
    let booked = 0;
    let unbooked = 0;
    for (const entry of regionCounts.values()) {
      booked += entry.booked;
      unbooked += entry.unbooked;
    }
    return { booked, unbooked };
  }, [regionCounts]);

  const regionRoutes = useMemo(
    () => routes.filter((route) => {
      const region = route.base?.region;
      return region ? selectedRegions.has(region) : allRegionsSelected;
    }),
    [allRegionsSelected, routes, selectedRegions],
  );

  const unbookedEngineerRoutes = useMemo(
    () => buildUnbookedEngineerRoutes({
      canonicalRoutes,
      engineers,
      selectedRegions,
    }),
    [canonicalRoutes, engineers, selectedRegions],
  );

  // The rail is the only engineer navigator. Filters scope regions and layers.
  const visibleRoutes = regionRoutes;

  const suggestionCandidateRoutes = useMemo(
    () =>
      [...suggestionRoutes, ...unbookedEngineerRoutes].filter((route) => {
        const region = route.base?.region;
        return region ? selectedRegions.has(region) : allRegionsSelected;
      }),
    [allRegionsSelected, selectedRegions, suggestionRoutes, unbookedEngineerRoutes],
  );

  const readyToBookItems = useMemo<PlanningDemandItem[]>(
    () =>
      (readyToBookSnapshot?.items ?? []).filter(
        (item) => {
          const region = filterRegionForDemand(item);
          return region !== null &&
            selectedRegions.has(region) &&
            item.requestType === "requested";
        },
      ),
    [readyToBookSnapshot, selectedRegions],
  );

  const suggestionItems = useMemo(
    () =>
      (readyToBookSnapshot?.items ?? []).filter((item) => {
        const region = filterRegionForDemand(item);
        return region !== null && selectedRegions.has(region);
      }),
    [readyToBookSnapshot, selectedRegions],
  );

  const routeSuggestions = useMemo(
    () =>
      findRouteSuggestions({
        items: suggestionItems,
        routes: suggestionCandidateRoutes,
        radiusKm: suggestionRadiusKm,
        context: suggestionContext,
      }),
    [suggestionCandidateRoutes, suggestionItems, suggestionRadiusKm, suggestionContext],
  );

  const suggestionDemandIds = useMemo(
    () => routeSuggestions.map((suggestion) => suggestion.demandId),
    [routeSuggestions],
  );

  const suggestionContexts = useMemo(
    () => suggestionContextsForRoutes(canonicalRoutes, routeSuggestions),
    [canonicalRoutes, routeSuggestions],
  );

  const mapDemandItems = useMemo(() => {
    return planningMarkersForLayers(readyToBookItems, {
      showDemand: showReadyToBook,
      showSuggestions: true,
      suggestionIds: suggestionDemandIds,
    });
  }, [readyToBookItems, showReadyToBook, suggestionDemandIds]);

  const mapFocusedDemandId =
    focusedDemandId && mapDemandItems.some((item) => item.id === focusedDemandId)
      ? focusedDemandId
      : null;

  const issueVisitIds = useMemo(
    () => issues.flatMap((issue) => issue.visitId ? [issue.visitId] : []),
    [issues],
  );

  const issueVisitSeverities = useMemo(
    () => issueSeveritiesByVisit(issues),
    [issues],
  );

  const demandById = useMemo(
    () => new Map((readyToBookSnapshot?.items ?? []).map((item) => [item.id, item])),
    [readyToBookSnapshot],
  );

  const filteredRoute = useMemo(
    () => regionRoutes.find((route) => route.id === engineerFilterRouteId) ?? null,
    [engineerFilterRouteId, regionRoutes],
  );

  const selectedRouteHasNoCalls =
    engineerFilterRouteId !== "all" && filteredRoute === null;

  const engineerOptions = useMemo(() => {
    const query =
      filteredRoute && engineerQuery === filteredRoute.resourceName
        ? ""
        : engineerQuery.trim().toLocaleLowerCase("en-GB");
    const matches = query
      ? regionRoutes.filter((route) =>
        route.resourceName.toLocaleLowerCase("en-GB").includes(query),
      )
      : regionRoutes;
    if (
      filteredRoute &&
      !matches.some((route) => route.id === filteredRoute.id)
    ) {
      return [filteredRoute, ...matches];
    }
    return matches;
  }, [engineerQuery, filteredRoute, regionRoutes]);

  const reviewRouteProjection = useMemo(
    () =>
      resolveReviewRoutes({
        canonicalRoutes,
        projectedRoutes: routes,
        visibleRoutes,
        selectedRouteId,
        selectedVisitId,
      }),
    [canonicalRoutes, routes, selectedRouteId, selectedVisitId, visibleRoutes],
  );

  const mapRoutes = reviewRouteProjection.routes;

  const timelineRoutes = useMemo(
    () => [...reviewRouteProjection.routes, ...unbookedEngineerRoutes],
    [reviewRouteProjection.routes, unbookedEngineerRoutes],
  );

  const timelineCanonicalRoutes = useMemo(
    () => [...canonicalRoutes, ...unbookedEngineerRoutes],
    [canonicalRoutes, unbookedEngineerRoutes],
  );

  const focusedOutsideFilters = reviewRouteProjection.focusedOutsideFilters;

  const roadById = useMemo(
    () => new Map(roadRoutes.map((route) => [route.id, route])),
    [roadRoutes],
  );

  const canonicalRouteById = useMemo(
    () => new Map(canonicalRoutes.map((route) => [route.id, route])),
    [canonicalRoutes],
  );

  const visitById = useMemo(
    () => new Map(scheduledVisits.map((visit) => [visit.id, visit])),
    [scheduledVisits],
  );

  const mapBookings = useMemo(() => indexReviewMapBookings(canonicalRoutes), [canonicalRoutes]);

  const mapHomes = useMemo(() => new Map(unbookedEngineerRoutes.map((route) => [route.id, route])), [unbookedEngineerRoutes]);

  const mapDemandIds = useMemo(() => mapDemandItems.map((item) => item.id), [mapDemandItems]);

  const mapScope = useMemo(() => ({
    routes: mapRoutes,
    demandIds: mapDemandIds,
    includeOutOfCoverageInFit: !allRegionsSelected,
  }), [mapRoutes, mapDemandIds, allRegionsSelected]);

  const mapScene = useMemo(() => ({
    booked: mapBookings,
    homes: mapHomes,
    roads: roadById,
    demand: demandById,
    scope: mapScope,
    annotations: {
      issueSeverityByVisit: issueVisitSeverities,
      suggestedDemandIds: suggestionDemandIds,
      suggestions: suggestionContexts,
    },
  }), [mapBookings, mapHomes, roadById, demandById, mapScope, issueVisitSeverities, suggestionDemandIds, suggestionContexts]);

  const focusedSuggestion = useMemo(() => {
    if (!focusedDemandId) return null;
    const suggestion = routeSuggestions.find(
      (candidate) => candidate.demandId === focusedDemandId,
    );
    const demand = demandById.get(focusedDemandId);
    if (!suggestion || !demand) return null;
    return {
      demandId: focusedDemandId,
      routeId: suggestion.routeId,
      anchorVisitId: suggestion.stopId,
      label: demand.companyLabel,
    };
  }, [demandById, focusedDemandId, routeSuggestions]);

  const timelineSuggestions = useMemo(
    () =>
      routeSuggestions.flatMap((suggestion) => {
        const demand = demandById.get(suggestion.demandId);
        if (!demand) return [];
        return [{
          id: suggestion.id,
          demandId: demand.id,
          routeId: suggestion.routeId,
          anchorVisitId: suggestion.stopId,
          label: demand.companyLabel,
          distanceKm: suggestion.distanceKm,
        }];
      }),
    [demandById, routeSuggestions],
  );

  const detailVisit = detailVisitId ? visitById.get(detailVisitId) ?? null : null;

  const detailDemand = detailDemandId ? demandById.get(detailDemandId) ?? null : null;

  const detailVisitRoute = detailVisit
    ? canonicalRoutes.find((route) =>
      route.stops.some((stop) => stop.id === detailVisit.id),
    ) ?? null
    : null;

  const criticalIssues = issues.filter(
    (issue) => issue.severity === "critical",
  ).length;

  const issueCountsByRoute = useMemo(
    () => issueCountsForRoutes(issues),
    [issues],
  );

  const routesNeedingAttention = issueCountsByRoute.size;

  const sortedVisibleRoutes = useMemo(
    () => sortReviewRoutes(visibleRoutes, routeSort, issueCountsByRoute),
    [issueCountsByRoute, routeSort, visibleRoutes],
  );

  const suggestionCountsByRoute = useMemo(() => {
    const counts = new Map<string, number>();
    routeSuggestions.forEach((suggestion) => {
      counts.set(
        suggestion.routeId,
        (counts.get(suggestion.routeId) ?? 0) + 1,
      );
    });
    return counts;
  }, [routeSuggestions]);

  const railRoutes = useMemo(() => {
    return [...sortedVisibleRoutes, ...unbookedEngineerRoutes].sort((first, second) => {
      const opportunityDifference =
        (suggestionCountsByRoute.get(second.id) ?? 0) -
        (suggestionCountsByRoute.get(first.id) ?? 0);
      return (
        opportunityDifference ||
        first.resourceName.localeCompare(second.resourceName, "en-GB")
      );
    });
  }, [sortedVisibleRoutes, suggestionCountsByRoute, unbookedEngineerRoutes]);

  const scopedReviewRoutes = useMemo(
    () => canonicalRoutes.filter((route) => {
      const region = route.base?.region;
      return region ? selectedRegions.has(region) : allRegionsSelected;
    }),
    [allRegionsSelected, canonicalRoutes, selectedRegions],
  );

  const reviewStats = useMemo(() => {
    const engineerCapacityMinutes = engineers
      .filter((engineer) => selectedRegions.has(engineer.region))
      .reduce(
        (total, engineer) =>
          total + engineerWorkingMinutesForDate(engineer, date),
        0,
      );
    return reviewDayStats({
      routes: scopedReviewRoutes,
      roadRoutes,
      unassignedRequiredCount: readyToBookLoading ? null : readyToBookItems.length,
      engineerCapacityMinutes,
    });
  }, [
    date,
    engineers,
    readyToBookItems.length,
    readyToBookLoading,
    roadRoutes,
    scopedReviewRoutes,
    selectedRegions,
  ]);

  const railRouteGroups = useMemo(
    () => groupReviewRoutes(railRoutes),
    [railRoutes],
  );

  const issuesByVisitId = useMemo(() => groupIssuesByVisit(issues), [issues]);

  const primarySummaryRoutes = useMemo(
    () => sortedVisibleRoutes.filter(isPrimaryRouteSummary),
    [sortedVisibleRoutes],
  );

  const compactSummaryRoutes = useMemo(
    () => sortedVisibleRoutes.filter((route) => !isPrimaryRouteSummary(route)),
    [sortedVisibleRoutes],
  );

  const routeSummaryGroups = useMemo(
    () => groupReviewRoutes(primarySummaryRoutes),
    [primarySummaryRoutes],
  );

  const mapLayerFiltersActive =
    !showOpenVisits ||
    !showCompleteVisits ||
    !showThirdParty ||
    !showReadyToBook;

  const reviewFiltersActive =
    !allRegionsSelected || mapLayerFiltersActive;

  const activeFilterCount = [
    !allRegionsSelected,
    !showOpenVisits,
    !showCompleteVisits,
    !showThirdParty,
    !showReadyToBook,
  ].filter(Boolean).length;
  return {
    statusCounts,
    thirdPartyVisitCount,
    canonicalRoutes,
    routes,
    roadRoutes,
    issues,
    roadLoading,
    regionOptions,
    regionCounts,
    allRegionsSelected,
    regionSelectValue,
    totalRegionCounts,
    regionRoutes,
    visibleRoutes,
    readyToBookItems,
    routeSuggestions,
    suggestionDemandIds,
    suggestionContexts,
    mapDemandItems,
    mapFocusedDemandId,
    issueVisitIds,
    demandById,
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
  };
}
