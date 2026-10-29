import { stopDistanceFromBaseKm } from "./route-builder";
import { formatMiles } from "../../shared/coordinates";
import type { EngineerRoute, RoadRoute, RouteIssue } from "./contracts";
import type { ScheduledVisit } from "@/modules/work/contracts";

export const MINIMUM_AUDITED_TRAVEL_MINUTES = 10;

function minutesBetween(first: string, second: string) {
  return Math.round(
    (new Date(second).getTime() - new Date(first).getTime()) / 60000,
  );
}

function locationIssue(
  stop: Pick<ScheduledVisit, "address" | "city" | "postcode">,
) {
  if (!stop.postcode && !stop.address && !stop.city) {
    return {
      title: "Location has no usable address",
      reason: "Add an address or postcode to the Autotask company location.",
    };
  }
  const isUkPostcode =
    /^(?:GIR ?0AA|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})$/i.test(
      stop.postcode.trim(),
    );
  return isUkPostcode
    ? {
        title: "UK postcode could not be mapped",
        reason: "The postcode was not recognised by the UK postcode service.",
      }
    : {
        title: "European location could not be mapped",
        reason: "Check the address, city, postcode and country in Autotask.",
      };
}

export function findRouteIssues(
  routes: EngineerRoute[],
  roadRoutes: RoadRoute[],
) {
  const roadMap = new Map(roadRoutes.map((route) => [route.id, route]));
  const issues: RouteIssue[] = [];

  routes.forEach((route) => {
    const road = roadMap.get(route.id);
    const isInternalRoute = route.stops[0]?.ownerType === "internal";
    if (
      isInternalRoute &&
      route.coordinates.length >= 2 &&
      (!road || road.error)
    ) {
      issues.push({
        id: `${route.id}-road-route`,
        kind: "road-route-unavailable",
        severity: "data",
        routeId: route.id,
        resourceId: route.resourceId,
        resourceName: route.resourceName,
        visitId: null,
        title: "Road route unavailable",
        detail:
          road?.error ||
          "The road-routing service did not return a route for this engineer.",
      });
    } else if (isInternalRoute && road?.legErrors?.some(Boolean)) {
      road.legErrors.forEach((error, legIndex) => {
        if (!error) return;
        const destination = route.stops.find(
          (stop) => stop.inboundLegIndex === legIndex,
        );
        const source = route.stops.find(
          (stop) => stop.inboundLegIndex === legIndex - 1,
        );
        const isReturn = route.returnLegIndex === legIndex;
        const from = source?.companyName || route.base?.base || "Start";
        const to = isReturn
          ? route.base?.base || "home"
          : destination?.companyName || "next visit";
        issues.push({
          id: `${route.id}-road-leg-${legIndex}`,
          kind: "road-leg-unavailable",
          severity: "data",
          routeId: route.id,
          resourceId: route.resourceId,
          resourceName: route.resourceName,
          visitId: destination?.id ?? null,
          title: "Road leg unavailable",
          detail: `${from} → ${to}: ${error}`,
        });
      });
    }
    if (isInternalRoute && !route.base && route.resourceId) {
      issues.push({
        id: `${route.id}-base`,
        kind: "missing-base",
        severity: "data",
        routeId: route.id,
        resourceId: route.resourceId,
        resourceName: route.resourceName,
        visitId: null,
        title: "Engineer start location unavailable",
        detail: "Job-to-job travel is shown, but home-to-first-job travel cannot be checked.",
      });
    }

    route.stops.forEach((stop) => {
      if (stop.ticketId === null) {
        issues.push({
          id: `${stop.id}-ticket-link`,
          kind: "missing-ticket-link",
          severity: "data",
          routeId: route.id,
          resourceId: route.resourceId,
          resourceName: route.resourceName,
          visitId: stop.id,
          title: "Scheduled call has no ticket link",
          detail: `Service call ${stop.serviceCallId} is scheduled in Autotask but has no linked ticket. It is shown using service-call data and needs its ticket link corrected in Autotask.`,
        });
      }
      if (stop.latitude === null || stop.longitude === null) {
        const location = locationIssue(stop);
        issues.push({
          id: `${stop.id}-location`,
          kind: "missing-location",
          severity: "data",
          routeId: route.id,
          resourceId: route.resourceId,
          resourceName: route.resourceName,
          visitId: stop.id,
          title: location.title,
          detail: `${stop.ticketNumber || `Service call ${stop.serviceCallId}`} · ${stop.companyName} · ${stop.postcode || stop.city || "No postcode"} · ${location.reason}`,
        });
      }
      if (stop.isOutOfRange) {
        const km = stopDistanceFromBaseKm(route.base, stop);
        issues.push({
          id: `${stop.id}-out-of-range`,
          kind: "out-of-range",
          severity: "warning",
          routeId: route.id,
          resourceId: route.resourceId,
          resourceName: route.resourceName,
          visitId: stop.id,
          title: "Booked outside the engineer's routing range",
          detail: `${stop.ticketNumber || `Service call ${stop.serviceCallId}`} · ${stop.companyName} · ${stop.city || stop.postcode || "Unknown location"} is about ${km === null ? "far" : formatMiles(km, 0)} from ${route.base?.base ?? "the engineer's base"}. The visit is shown, but travel to and from it is not calculated.`,
        });
      }
      if (stop.ownerType === "unassigned") {
        issues.push({
          id: `${stop.id}-resource`,
          kind: "unassigned",
          severity: "critical",
          routeId: route.id,
          resourceId: null,
          resourceName: "No assigned engineer",
          visitId: stop.id,
          title: stop.ignoredResourceCount
            ? "No recognised engineer"
            : "Scheduled call has no engineer",
          detail: stop.ignoredResourceCount
            ? `${stop.ticketNumber || `Service call ${stop.serviceCallId}`} has ${stop.ignoredResourceCount} linked resource${stop.ignoredResourceCount === 1 ? "" : "s"}, but none match the engineer reference list.`
            : `${stop.ticketNumber || `Service call ${stop.serviceCallId}`} is booked without a service-call resource.`,
        });
      }
    });

    if (!isInternalRoute) return;

    for (let index = 1; index < route.stops.length; index += 1) {
      const previous = route.stops[index - 1];
      const current = route.stops[index];
      // Same ticket, two Autotask service calls: one job window, not two visits.
      if (
        previous.ticketId !== null &&
        previous.ticketId === current.ticketId
      ) {
        continue;
      }
      const available = minutesBetween(previous.endDateTime, current.startDateTime);
      if (available < 0) {
        issues.push({
          id: `${route.id}-${current.id}-overlap`,
          kind: "booking-overlap",
          severity: "critical",
          routeId: route.id,
          resourceId: route.resourceId,
          resourceName: route.resourceName,
          visitId: current.id,
          title: "Booked visits overlap",
          detail: `${previous.ticketNumber || previous.companyName} overlaps ${current.ticketNumber || current.companyName} by ${Math.abs(available)} minutes.`,
        });
        continue;
      }

      if (
        previous.latitude === null ||
        previous.longitude === null ||
        current.latitude === null ||
        current.longitude === null ||
        current.inboundLegIndex === null
      ) {
        continue;
      }
      const required =
        road?.legDurationsMinutes?.[current.inboundLegIndex];
      if (
        typeof required !== "number" ||
        required < MINIMUM_AUDITED_TRAVEL_MINUTES
      ) {
        continue;
      }
      if (required > available) {
        issues.push({
          id: `${route.id}-${current.id}-travel`,
          kind: "insufficient-travel",
          severity: "critical",
          routeId: route.id,
          resourceId: route.resourceId,
          resourceName: route.resourceName,
          visitId: current.id,
          title: "Insufficient travel time",
          detail: `${required} minutes by road, but only ${available} minutes are booked between visits.`,
        });
      } else if (available - required < 15) {
        issues.push({
          id: `${route.id}-${current.id}-tight`,
          kind: "tight-travel",
          severity: "warning",
          routeId: route.id,
          resourceId: route.resourceId,
          resourceName: route.resourceName,
          visitId: current.id,
          title: "Tight travel margin",
          detail: `${required} minutes by road with ${Math.max(0, available - required)} minutes contingency.`,
        });
      }
    }
  });

  return issues;
}
