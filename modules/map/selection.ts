import type { ReviewMapSelection } from "./contracts";
import type { EngineerRoute } from "@/modules/routing/contracts";

export function reviewMapSelection(input: {
  selectedRouteId: string;
  selectedVisitId: string | null;
  focusedDemandId: string | null;
}): ReviewMapSelection {
  const routeId = input.selectedRouteId === "all" ? null : input.selectedRouteId;
  if (input.focusedDemandId) {
    return { kind: "demand", demandId: input.focusedDemandId, routeId, anchorVisitId: input.selectedVisitId };
  }
  if (routeId && input.selectedVisitId) {
    return { kind: "visit", routeId, visitId: input.selectedVisitId };
  }
  return routeId ? { kind: "route", routeId } : { kind: "none" };
}

/** Index canonical facts once per booked-data publication, never on selection. */
export function indexReviewMapBookings(routes: EngineerRoute[]) {
  return {
    routes,
    routeById: new Map(routes.map((route) => [route.id, route])),
    visitById: new Map(routes.flatMap((route) =>
      route.stops.map((visit) => [visit.id, { routeId: route.id, visit }] as const),
    )),
  };
}
