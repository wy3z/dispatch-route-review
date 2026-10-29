import type { EngineerRoute, RoadRoute, RouteStop } from "./contracts";

/** Booked schedule plus a static road estimate. Not live location, traffic, or actual arrival. */
export type StaticRoadTiming =
  | InboundStaticRoadTiming
  | ReturnStaticRoadTiming
  | UnavailableRoadTiming;

export type InboundStaticRoadTiming = {
  availability: "available";
  kind: "inbound";
  legIndex: number;
  durationMinutes: number;
  destinationStopId: string;
  /** The scheduled ServiceCall start, not an observed arrival. */
  bookedArrivalDateTime: string;
  /** Static duration subtracted from the booked arrival time. */
  estimatedTravelStartDateTime: string;
  source: "home" | "previous-booked-visit";
  previousStopId?: string;
  previousBookedEndDateTime?: string;
  /** Available only when the preceding booked visit supplies a departure bound. */
  earliestArrivalDateTime?: string;
  /** Booked arrival minus earliest static arrival; negative means a conflict. */
  marginMinutes?: number;
};

export type ReturnStaticRoadTiming = {
  availability: "available";
  kind: "return";
  legIndex: number;
  durationMinutes: number;
  sourceStopId: string;
  sourceBookedEndDateTime: string;
  estimatedTravelStartDateTime: string;
  /** Static estimate only; it is not an actual return-home time. */
  estimatedArrivalDateTime: string;
};

export type RouteTimingUnavailableReason =
  | "road-route-unavailable"
  | "road-duration-unavailable"
  | "inbound-destination-unavailable"
  | "return-boundary-unavailable"
  | "invalid-booked-time";

export type UnavailableRoadTiming = {
  availability: "unavailable";
  kind: "inbound" | "return" | "unknown";
  legIndex: number;
  reason: RouteTimingUnavailableReason;
};

function roadDurationMinutes(road: RoadRoute | undefined, legIndex: number) {
  const duration = road?.legDurationsMinutes?.[legIndex];
  return typeof duration === "number" && Number.isFinite(duration) && duration >= 0
    ? duration
    : null;
}

function offsetIso(value: string, minutes: number) {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds + minutes * 60_000).toISOString();
}

function minutesBetween(first: string, second: string) {
  const firstMilliseconds = new Date(first).getTime();
  const secondMilliseconds = new Date(second).getTime();
  if (!Number.isFinite(firstMilliseconds) || !Number.isFinite(secondMilliseconds)) {
    return null;
  }
  return Math.round((secondMilliseconds - firstMilliseconds) / 60_000);
}

function unavailable(
  kind: UnavailableRoadTiming["kind"],
  legIndex: number,
  reason: RouteTimingUnavailableReason,
): UnavailableRoadTiming {
  return { availability: "unavailable", kind, legIndex, reason };
}

/**
 * Honest timing for one canonical road leg.
 * Inbound is booked start minus static duration. Inter-visit legs also report
 * earliest arrival after the previous booked end. Home departure is not asserted.
 */
export function routeTimingForLeg(
  route: EngineerRoute,
  road: RoadRoute | undefined,
  legIndex: number,
): StaticRoadTiming {
  const isReturn = route.returnLegIndex === legIndex;
  const destinationIndex = route.stops.findIndex(
    (stop) => stop.inboundLegIndex === legIndex,
  );
  const kind: UnavailableRoadTiming["kind"] = isReturn
    ? "return"
    : destinationIndex >= 0
      ? "inbound"
      : "unknown";

  if (!road || road.error) {
    return unavailable(kind, legIndex, "road-route-unavailable");
  }
  const durationMinutes = roadDurationMinutes(road, legIndex);
  if (durationMinutes === null) {
    return unavailable(kind, legIndex, "road-duration-unavailable");
  }

  if (isReturn) {
    const source = route.stops.at(-1);
    if (!source) {
      return unavailable("return", legIndex, "return-boundary-unavailable");
    }
    const estimatedArrivalDateTime = offsetIso(source.endDateTime, durationMinutes);
    if (!estimatedArrivalDateTime) {
      return unavailable("return", legIndex, "invalid-booked-time");
    }
    return {
      availability: "available",
      kind: "return",
      legIndex,
      durationMinutes,
      sourceStopId: source.id,
      sourceBookedEndDateTime: source.endDateTime,
      estimatedTravelStartDateTime: source.endDateTime,
      estimatedArrivalDateTime,
    };
  }

  const destination = route.stops[destinationIndex];
  if (!destination) {
    return unavailable("unknown", legIndex, "inbound-destination-unavailable");
  }
  const estimatedTravelStartDateTime = offsetIso(
    destination.startDateTime,
    -durationMinutes,
  );
  if (!estimatedTravelStartDateTime) {
    return unavailable("inbound", legIndex, "invalid-booked-time");
  }

  const previous = route.stops[destinationIndex - 1];
  if (!previous) {
    return {
      availability: "available",
      kind: "inbound",
      legIndex,
      durationMinutes,
      destinationStopId: destination.id,
      bookedArrivalDateTime: destination.startDateTime,
      estimatedTravelStartDateTime,
      source: "home",
    };
  }

  const earliestArrivalDateTime = offsetIso(previous.endDateTime, durationMinutes);
  const marginMinutes = minutesBetween(
    earliestArrivalDateTime ?? "",
    destination.startDateTime,
  );
  if (!earliestArrivalDateTime || marginMinutes === null) {
    return unavailable("inbound", legIndex, "invalid-booked-time");
  }
  return {
    availability: "available",
    kind: "inbound",
    legIndex,
    durationMinutes,
    destinationStopId: destination.id,
    bookedArrivalDateTime: destination.startDateTime,
    estimatedTravelStartDateTime,
    source: "previous-booked-visit",
    previousStopId: previous.id,
    previousBookedEndDateTime: previous.endDateTime,
    earliestArrivalDateTime,
    marginMinutes,
  };
}

/** Convenience narrowing helper for marker/popup consumers. */
export function routeTimingForStop(
  route: EngineerRoute,
  road: RoadRoute | undefined,
  stop: Pick<RouteStop, "inboundLegIndex">,
) {
  return stop.inboundLegIndex === null
    ? unavailable("inbound", -1, "inbound-destination-unavailable")
    : routeTimingForLeg(route, road, stop.inboundLegIndex);
}
