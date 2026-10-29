import type { CSSProperties } from "react";
import type { EngineerRoute, RoadRoute, RouteIssue } from "@/modules/routing/contracts";

const londonMinuteFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export type TimelineBounds = {
  start: number;
  end: number;
  hours: number[];
};

export type TimelineBlockOptions = {
  minimumDisplayMinutes?: number;
  maximumDisplayEnd?: number;
};

export function hasTravelConflictIssue(
  issues: ReadonlyArray<Pick<RouteIssue, "kind">>,
) {
  return issues.some(
    (issue) =>
      issue.kind === "insufficient-travel" ||
      issue.kind === "booking-overlap",
  );
}

/** Minutes from London local midnight on the selected review date. */
export function minutesOnReviewDate(value: string, reviewDate: string) {
  const parts = londonMinuteFormatter.formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localDay = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
  );
  const [year, month, day] = reviewDate.split("-").map(Number);
  const reviewDay = Date.UTC(year, month - 1, day);
  const dayOffset = Math.round((localDay - reviewDay) / 86_400_000);
  return (
    dayOffset * 24 * 60 +
    Number(byType.hour) * 60 +
    Number(byType.minute)
  );
}

export function timelineLabel(minutes: number) {
  const dayOffset = Math.floor(minutes / (24 * 60));
  const minuteOfDay = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour = Math.floor(minuteOfDay / 60);
  const label = `${String(hour).padStart(2, "0")}:00`;
  if (dayOffset < 0) return `${dayOffset}d ${label}`;
  return dayOffset > 0 ? `+${dayOffset}d ${label}` : label;
}

export function timelineStyle(
  startMinutes: number,
  durationMinutes: number,
  bounds: Pick<TimelineBounds, "start" | "end">,
  {
    minimumDisplayMinutes = 0,
    maximumDisplayEnd = Number.POSITIVE_INFINITY,
  }: TimelineBlockOptions = {},
): CSSProperties {
  const timelineDuration = bounds.end - bounds.start;
  const start = Math.max(bounds.start, startMinutes);
  const naturalEnd = Math.min(bounds.end, startMinutes + durationMinutes);
  const expandedEnd = Math.min(
    bounds.end,
    maximumDisplayEnd,
    start + minimumDisplayMinutes,
  );
  const end = Math.max(naturalEnd, expandedEnd);
  return {
    left: `${((start - bounds.start) / timelineDuration) * 100}%`,
    width: `${Math.max(0.35, ((end - start) / timelineDuration) * 100)}%`,
  };
}

export function dispatchTimelineBounds(
  date: string,
  routes: EngineerRoute[],
  roadRoutes: RoadRoute[],
): TimelineBounds {
  const roadById = new Map(roadRoutes.map((route) => [route.id, route]));
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;

  routes.forEach((route) => {
    const road = roadById.get(route.id);
    route.stops.forEach((stop) => {
      const visitStart = minutesOnReviewDate(stop.startDateTime, date);
      const visitEnd = minutesOnReviewDate(stop.endDateTime, date);
      const travel =
        stop.inboundLegIndex !== null
          ? road?.legDurationsMinutes?.[stop.inboundLegIndex] ?? 0
          : 0;
      start = Math.min(start, visitStart - travel);
      end = Math.max(end, visitEnd);
    });
    const lastMapped = [...route.stops]
      .reverse()
      .find((stop) => stop.latitude !== null && stop.longitude !== null);
    const returnMinutes =
      route.returnLegIndex !== null
        ? road?.legDurationsMinutes?.[route.returnLegIndex] ?? 0
        : 0;
    if (lastMapped && returnMinutes) {
      end = Math.max(
        end,
        minutesOnReviewDate(lastMapped.endDateTime, date) + returnMinutes,
      );
    }
  });

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    start = 8 * 60;
    end = 18 * 60;
  }
  if (end - start < 4 * 60) {
    const midpoint = (start + end) / 2;
    start = midpoint - 2 * 60;
    end = midpoint + 2 * 60;
  }
  const roundedStart = Math.floor(start / 60) * 60;
  const roundedEnd = Math.max(roundedStart + 4 * 60, Math.ceil(end / 60) * 60);
  const tickMinutes = roundedEnd - roundedStart > 12 * 60 ? 120 : 60;
  const hours = Array.from(
    { length: Math.floor((roundedEnd - roundedStart) / tickMinutes) + 1 },
    (_, index) => roundedStart + index * tickMinutes,
  );
  if (hours.at(-1) !== roundedEnd) hours.push(roundedEnd);
  return { start: roundedStart, end: roundedEnd, hours };
}
