import { readyToBookConfiguration } from "../operational-ids";
import { projectPlanningDemandSnapshot } from "./model";
import type { PlanningDemandItem, PlanningDemandSnapshot } from "./model";
import { isIsoCalendarDate, londonCalendarDate } from "../../../shared/calendar";

/** Overlay fields only. No notes, addresses, country, engineer, or planning internals. */
export type ReadyToBookItem = {
  id: PlanningDemandItem["id"];
  autotaskUrl: string | null;
  ticketId: PlanningDemandItem["ticketId"];
  ticketNumber: PlanningDemandItem["ticketNumber"];
  title: PlanningDemandItem["title"];
  companyLabel: PlanningDemandItem["companyLabel"];
  siteLabel: PlanningDemandItem["siteLabel"];
  city: PlanningDemandItem["city"];
  postcode: PlanningDemandItem["postcode"];
  latitude: PlanningDemandItem["latitude"];
  longitude: PlanningDemandItem["longitude"];
  durationMinutes: PlanningDemandItem["durationMinutes"];
  durationSource: PlanningDemandItem["durationSource"];
  region: PlanningDemandItem["routeRegion"];
  exclusionReason: PlanningDemandItem["exclusionReason"];
  exclusionDetail: PlanningDemandItem["exclusionDetail"];
};

export type ReadyToBookCounts = {
  total: number;
  mapped: number;
  unmapped: number;
  excluded: number;
};

export type ReadyToBookSnapshot = {
  source: "postgres-planning-demand-cache";
  planningDate: string;
  generatedAt: string;
  scope: ReturnType<typeof readyToBookConfiguration> & {
    queueLabel: string;
    statusLabel: string;
  };
  warnings: string[];
  counts: ReadyToBookCounts;
  items: ReadyToBookItem[];
};

function isWeekday(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

/** London today or a future weekday. Reject other dates before cache projection. */
export function isReadyToBookDateEligible(date: string, now = new Date()) {
  return (
    isIsoCalendarDate(date) &&
    isWeekday(date) &&
    date >= londonCalendarDate(now)
  );
}

function projectItem(item: PlanningDemandItem): ReadyToBookItem {
  return {
    id: item.id,
    autotaskUrl: item.autotaskUrl ?? null,
    ticketId: item.ticketId,
    ticketNumber: item.ticketNumber,
    title: item.title,
    companyLabel: item.companyLabel,
    siteLabel: item.siteLabel,
    city: item.city,
    postcode: item.postcode,
    latitude: item.latitude,
    longitude: item.longitude,
    durationMinutes: item.durationMinutes,
    durationSource: item.durationSource,
    region: item.routeRegion,
    exclusionReason: item.exclusionReason,
    exclusionDetail: item.exclusionDetail,
  };
}

function readyToBookItems(
  snapshot: PlanningDemandSnapshot,
  scope: ReturnType<typeof readyToBookConfiguration>,
) {
  return snapshot.items.filter(
    (item) =>
      item.queueId === scope.queueId &&
      item.statusId === scope.statusId,
  );
}

function readyToBookScopeWarnings(
  snapshot: PlanningDemandSnapshot,
  selectedItems: PlanningDemandItem[],
  scope: ReturnType<typeof readyToBookConfiguration>,
) {
  if (snapshot.items.length === 0) return [];
  const missingIds = snapshot.items.filter(
    (item) =>
      !Number.isSafeInteger(item.queueId) ||
      item.queueId <= 0 ||
      !Number.isSafeInteger(item.statusId) ||
      item.statusId <= 0,
  ).length;
  if (missingIds > 0) {
    return [
      `${missingIds} shared planning-demand item${missingIds === 1 ? " is" : "s are"} missing immutable queue/status IDs. Refresh the demand cache before relying on the ready-to-book scope.`,
    ];
  }
  if (selectedItems.length === 0) {
    return [
      `Shared planning demand contains ${snapshot.items.length} item${snapshot.items.length === 1 ? "" : "s"}, but none match required queue ID ${scope.queueId} and status ID ${scope.statusId}.`,
    ];
  }
  return [];
}

function hasCoordinates(item: ReadyToBookItem) {
  return (
    typeof item.latitude === "number" &&
    Number.isFinite(item.latitude) &&
    typeof item.longitude === "number" &&
    Number.isFinite(item.longitude)
  );
}

/** Project the immutable queue/status scope. Does not mutate the cache payload. */
export function projectReadyToBook(
  snapshot: PlanningDemandSnapshot,
  planningDate = snapshot.scopeDate,
  scope = readyToBookConfiguration(),
  webUrl: string | null = null,
): ReadyToBookSnapshot {
  const selectedItems = readyToBookItems(projectPlanningDemandSnapshot(snapshot, webUrl), scope);
  const items = selectedItems.map(projectItem);
  const mapped = items.filter(hasCoordinates).length;
  const excluded = items.filter((item) => item.exclusionReason !== null).length;

  return {
    source: "postgres-planning-demand-cache",
    planningDate,
    generatedAt: snapshot.generatedAt,
    scope: { ...scope, queueLabel: "Ready to book", statusLabel: "Unassigned request" },
    warnings: [
      ...snapshot.warnings,
      ...readyToBookScopeWarnings(snapshot, selectedItems, scope),
    ],
    counts: {
      total: items.length,
      mapped,
      unmapped: items.length - mapped,
      excluded,
    },
    items,
  };
}
