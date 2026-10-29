import {
  findEngineerBase,
  getResourceColour,
  getResourceColourIndex,
} from "@/modules/engineers/domain";
import { haversineKm } from "../../shared/coordinates";
import type { EngineerBase } from "@/modules/engineers/contracts";
import type { EngineerRoute } from "./contracts";
import type { ScheduledVisit } from "@/modules/work/contracts";

/** Furthest a booked stop can sit from base and still be a UK/Ireland day.
 *  Observed internal work tops out at 477 km; overseas jobs start around 1,400 km. */
export const MAX_ROUTABLE_STOP_KM = 700;

export function stopDistanceFromBaseKm(
  base: { latitude: number; longitude: number } | null,
  stop: Pick<ScheduledVisit, "latitude" | "longitude">,
): number | null {
  if (!base || stop.latitude === null || stop.longitude === null) return null;
  return haversineKm(base.latitude, base.longitude, stop.latitude, stop.longitude);
}

/** Out-of-range stops stay visible but must not draw travel or expand map bounds. */
export function isOutOfRangeStop(
  base: { latitude: number; longitude: number } | null,
  stop: Pick<ScheduledVisit, "latitude" | "longitude">,
): boolean {
  const km = stopDistanceFromBaseKm(base, stop);
  return km !== null && km > MAX_ROUTABLE_STOP_KM;
}

function routeColour(
  routeOwnerKey: string,
  resourceId: number | null,
  ownerType: ScheduledVisit["ownerType"],
  colourIndex?: number | null,
) {
  if (ownerType === "unassigned") return "#64748B";
  return getResourceColour({ routeOwnerKey, resourceId, colourIndex });
}

export function buildEngineerRoutes(
  visits: ScheduledVisit[],
  engineers: readonly EngineerBase[],
) {
  const groups = new Map<string, ScheduledVisit[]>();
  visits.forEach((visit) => {
    const key = visit.routeOwnerKey;
    groups.set(key, [...(groups.get(key) ?? []), visit]);
  });

  return [...groups.entries()]
    .map(([id, groupedVisits]): EngineerRoute => {
      const name = groupedVisits[0]?.resourceName || "No assigned engineer";
      const resourceId = groupedVisits[0]?.resourceId ?? null;
      const base = findEngineerBase(engineers, resourceId, name);
      const ownerType = groupedVisits[0]?.ownerType ?? "unassigned";
      const colourIndex =
        ownerType === "unassigned"
          ? null
          : base?.colourIndex ??
            getResourceColourIndex({ routeOwnerKey: id, resourceId });
      const isNonRoutable = ownerType !== "internal";
      const dated = [...groupedVisits].sort(
        (first, second) =>
          new Date(first.startDateTime).getTime() -
          new Date(second.startDateTime).getTime(),
      );
      const ordered = dated;
      const coordinates: Array<[number, number]> = [];
      const inboundLegByVisit = new Map<string, number | null>();
      const outOfRangeVisitIds = new Set<string>();
      if (base) coordinates.push([base.latitude, base.longitude]);
      let routeContinuityKnown = !isNonRoutable;
      ordered.forEach((visit) => {
        if (
          isNonRoutable ||
          visit.latitude === null ||
          visit.longitude === null
        ) {
          inboundLegByVisit.set(visit.id, null);
          routeContinuityKnown = false;
          return;
        }
        if (isOutOfRangeStop(base, visit)) {
          outOfRangeVisitIds.add(visit.id);
          inboundLegByVisit.set(visit.id, null);
          routeContinuityKnown = false;
          return;
        }
        if (!routeContinuityKnown) {
          inboundLegByVisit.set(visit.id, null);
          return;
        }
        inboundLegByVisit.set(
          visit.id,
          coordinates.length ? coordinates.length - 1 : null,
        );
        coordinates.push([visit.latitude, visit.longitude]);
      });
      let returnLegIndex: number | null = null;
      if (base && coordinates.length > 1 && routeContinuityKnown) {
        returnLegIndex = coordinates.length - 1;
        coordinates.push([base.latitude, base.longitude]);
      }
      return {
        id,
        resourceId,
        resourceName: name,
        base,
        colourIndex,
        colour: routeColour(id, resourceId, ownerType, colourIndex),
        stops: ordered.map((visit, stopIndex) => ({
          ...visit,
          sequence: stopIndex + 1,
          inboundLegIndex: inboundLegByVisit.get(visit.id) ?? null,
          isOutOfRange: outOfRangeVisitIds.has(visit.id),
        })),
        coordinates,
        returnLegIndex,
      };
    })
    .sort((first, second) => first.resourceName.localeCompare(second.resourceName));
}
