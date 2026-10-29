import { engineerRegions } from "@/modules/engineers/domain";
import type { EngineerRegion } from "@/modules/engineers/contracts";
import type { EngineerRoute } from "@/modules/routing/contracts";
import type { PlanningDemandItem } from "@/modules/work/contracts";

const trailingRouteRegions = ["Third-party", "Unassigned"] as const;

export type RouteRegion = EngineerRegion | (typeof trailingRouteRegions)[number];

/** Filter regions, always listed so the control does not change shape by date.
 *  EU is filter-only: no engineer base, so it can hold demand but never a route. */
export const routeFilterRegions = [
  "North",
  "Midlands",
  "South",
  "EU",
  "Ireland",
] as const;

export type RouteFilterRegion = (typeof routeFilterRegions)[number];

export function routeRegion(route: Pick<EngineerRoute, "base" | "stops">): RouteRegion {
  if (route.stops[0]?.ownerType === "third-party") return "Third-party";
  return route.base?.region ?? "Unassigned";
}

export function compareRouteRegions(first: RouteRegion, second: RouteRegion) {
  const regionOrder = [...engineerRegions, ...trailingRouteRegions];
  return regionOrder.indexOf(first) - regionOrder.indexOf(second);
}

/** Filter region for demand. Uses territory so uncovered EU/Irish work stays visible. */
export function filterRegionForDemand(
  item: Pick<PlanningDemandItem, "territoryGroup" | "routeRegion">,
): RouteFilterRegion | null {
  switch (item.territoryGroup) {
    case "North":
    case "Midlands":
    case "South":
    case "Ireland":
      return item.territoryGroup;
    case "Northern Europe":
    case "Eastern Europe":
    case "Southern Europe":
    case "Western Europe":
      return "EU";
    default:
      // "Other" covers unrecognised territories; fall back to the route region
      // when coverage resolution managed to place the site.
      return item.routeRegion ?? null;
  }
}
