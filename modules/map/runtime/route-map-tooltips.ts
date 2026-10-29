import { formatMiles } from "../../../shared/coordinates";
import { formatTime } from "../../../shared/formatting";
import { routeTimingForLeg } from "@/modules/routing/domain";
import type { StaticRoadTiming, EngineerRoute, RoadRoute } from "@/modules/routing/contracts";

function stopLabel(stop: EngineerRoute["stops"][number] | undefined) {
  if (!stop) return "Next visit";
  const place = stop.companyName || stop.locationName || "Service call";
  return stop.city && !place.toLowerCase().includes(stop.city.toLowerCase())
    ? `${place} ${stop.city}`
    : place;
}

export function routeLegTooltip(
  route: EngineerRoute,
  road: RoadRoute,
  legIndex: number,
) {
  const destination = route.stops.find(
    (stop) => stop.inboundLegIndex === legIndex,
  );
  const source = route.stops.find(
    (stop) => stop.inboundLegIndex === legIndex - 1,
  );
  const isReturn = route.returnLegIndex === legIndex;
  const from = source ? stopLabel(source) : "Home";
  const to = isReturn ? "Home" : stopLabel(destination);
  const duration = road.legDurationsMinutes?.[legIndex];
  const distance = road.legDistancesKm?.[legIndex];
  const journey = [
    duration === null || duration === undefined ? null : `${duration} min`,
    distance === null || distance === undefined
      ? null
      : formatMiles(distance),
  ]
    .filter(Boolean)
    .join(" · ");

  const content = document.createElement("span");
  content.className = "route-leg-tooltip-copy";
  const engineer = document.createElement("strong");
  engineer.textContent = route.resourceName;
  const endpoints = document.createElement("span");
  endpoints.textContent = `${from} → ${to}`;
  content.append(engineer, endpoints);
  if (journey) {
    const travel = document.createElement("small");
    travel.textContent = journey;
    content.append(travel);
  }
  appendStaticTiming(content, routeTimingForLeg(route, road, legIndex));
  return content;
}

export function routeOrderFallbackTooltip(route: EngineerRoute) {
  const content = document.createElement("span");
  content.className = "route-leg-tooltip-copy";
  const engineer = document.createElement("strong");
  engineer.textContent = route.resourceName;
  const context = document.createElement("span");
  context.textContent = route.returnLegIndex === null
    ? "Booked order segment · straight-line map fallback"
    : "Booked order · straight-line map fallback";
  const caveat = document.createElement("small");
  caveat.textContent =
    "Road geometry unavailable · not live GPS or travel timing";
  content.append(engineer, context, caveat);
  return content;
}

function staticTimingLines(timing: StaticRoadTiming) {
  if (timing.availability === "unavailable") {
    return ["Road timing unavailable · not live GPS"];
  }
  if (timing.kind === "return") {
    return [
      `Static road estimate ${formatTime(timing.estimatedTravelStartDateTime)}–${formatTime(timing.estimatedArrivalDateTime)} · not live GPS`,
      `Estimated return ${formatTime(timing.estimatedArrivalDateTime)}`,
    ];
  }
  const lines = [
    `Static road estimate ${formatTime(timing.estimatedTravelStartDateTime)}–${formatTime(timing.bookedArrivalDateTime)} · not live GPS`,
    `Booked arrival ${formatTime(timing.bookedArrivalDateTime)}`,
  ];
  if (timing.earliestArrivalDateTime) {
    lines.push(
      `Earliest static arrival ${formatTime(timing.earliestArrivalDateTime)}${typeof timing.marginMinutes === "number" ? ` · ${timing.marginMinutes >= 0 ? `${timing.marginMinutes} min margin` : `${Math.abs(timing.marginMinutes)} min short`}` : ""}`,
    );
  }
  return lines;
}

function appendStaticTiming(container: HTMLElement, timing: StaticRoadTiming) {
  staticTimingLines(timing).forEach((line, index) => {
    const element = document.createElement("small");
    element.className = index === 0 ? "map-time-primary" : "map-time-context";
    element.textContent = line;
    container.append(element);
  });
}

export function baseTimingTooltip(
  route: EngineerRoute,
  road: RoadRoute | undefined,
) {
  const content = document.createElement("span");
  content.className = "route-icon-tooltip-copy route-home-tooltip-copy";
  const label = document.createElement("small");
  label.className = "route-icon-tooltip-reference";
  label.textContent = "Home base";
  const engineer = document.createElement("strong");
  engineer.textContent = route.resourceName;
  const home = document.createElement("small");
  home.className = "route-icon-tooltip-meta";
  home.textContent = route.base?.base ?? "Unknown";
  content.append(label, engineer, home);

  const timingDetails: string[] = [];
  const firstRoutable = route.stops.find(
    (stop) => stop.inboundLegIndex !== null,
  );
  const firstLegIndex = firstRoutable?.inboundLegIndex;
  if (firstLegIndex !== null && firstLegIndex !== undefined) {
    const firstTiming = routeTimingForLeg(route, road, firstLegIndex);
    if (
      firstTiming.availability === "available" &&
      firstTiming.kind === "inbound"
    ) {
      timingDetails.push(
        `Static leave ${formatTime(firstTiming.estimatedTravelStartDateTime)}`,
      );
    }
  }
  if (route.returnLegIndex !== null) {
    const returnTiming = routeTimingForLeg(route, road, route.returnLegIndex);
    if (
      returnTiming.availability === "available" &&
      returnTiming.kind === "return"
    ) {
      timingDetails.push(
        `Return ${formatTime(returnTiming.estimatedArrivalDateTime)}`,
      );
    }
  }
  if (timingDetails.length) {
    const timing = document.createElement("small");
    timing.className = "route-icon-tooltip-secondary";
    timing.textContent = timingDetails.join(" · ");
    content.append(timing);
  }
  return content;
}
