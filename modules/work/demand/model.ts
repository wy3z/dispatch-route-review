import { autotaskTicketUrl } from "../links";
import type { EngineerRegion } from "@/modules/engineers/contracts";
import type { PlanningDemandExclusionReason } from "./coverage";
import type { OperationalIds } from "../operational-ids";
import { londonCalendarDate } from "../../../shared/calendar";

export type DemandWorkstream = "support" | "install" | "other";
export type DemandRequestType = "requested" | "access" | "third_party";
export type DemandAgeBand = "fresh" | "aged" | "unknown";
export type DemandReadiness = "eligible" | "blocked";
export type PlanningDemandDurationSource = "estimated" | "assumed";
export type { PlanningDemandExclusionReason } from "./coverage";

/** Used when Autotask does not supply a positive estimated-hours value. */
export const PLANNING_DEMAND_DEFAULT_DURATION_MINUTES = 60;
export type DemandTerritoryGroup =
  | "North"
  | "Midlands"
  | "South"
  | "Ireland"
  | "Northern Europe"
  | "Eastern Europe"
  | "Southern Europe"
  | "Western Europe"
  | "Other";
export type DemandDueBucket =
  | "today"
  | "this_week"
  | "next_week"
  | "week_after"
  | "within_12_months"
  | "tbc"
  | "none";

export type PlanningDemandItem = {
  id: string;
  ticketId: number;
  ticketNumber: string;
  title: string;
  /** Null suppresses links; absent worker values are resolved by the app. */
  autotaskUrl?: string | null;
  companyLabel: string;
  siteLabel: string;
  city: string;
  postcode: string;
  latitude: number | null;
  longitude: number | null;
  durationMinutes: number;
  durationSource: PlanningDemandDurationSource;
  routeRegion: EngineerRegion | null;
  logisticsTerritory: string | null;
  /** ISO-3166 alpha-2 of the site, carried so territory grouping never has to
   *  re-derive a country from an editable label. */
  countryCode: string | null;
  territoryGroup: DemandTerritoryGroup;
  queueId: number;
  queueLabel: string;
  statusId: number;
  statusLabel: string;
  workstream: DemandWorkstream;
  requestType: DemandRequestType;
  statusChangedAt: string | null;
  ageBand: DemandAgeBand;
  dueDate: string | null;
  dueBucket: DemandDueBucket;
  overdue: boolean;
  readiness: DemandReadiness;
  exclusionReason: PlanningDemandExclusionReason | null;
  exclusionDetail: string | null;
};

export type PlanningDemandSnapshot = {
  source: "postgres-planning-demand-cache" | "autotask-planning-demand";
  generatedAt: string;
  scopeDate: string;
  warnings: string[];
  counts: {
    total: number;
    mapped: number;
    unmapped: number;
    eligible: number;
    blocked: number;
    aged: number;
    overdue: number;
  };
  items: PlanningDemandItem[];
};

export type PlanningDemandCandidate = Omit<
  PlanningDemandItem,
  | "id"
  | "workstream"
  | "requestType"
  | "territoryGroup"
  | "ageBand"
  | "dueBucket"
  | "overdue"
  | "readiness"
>;

/** Convert Autotask estimated hours to the safe planning-demand duration. */
export function resolvePlanningDemandDuration(
  estimatedHours: unknown,
  defaultMinutes = PLANNING_DEMAND_DEFAULT_DURATION_MINUTES,
): {
  durationMinutes: number;
  durationSource: PlanningDemandDurationSource;
} {
  const hours = Number(estimatedHours);
  if (!Number.isFinite(hours) || hours <= 0) {
    return { durationMinutes: defaultMinutes, durationSource: "assumed" };
  }
  return {
    durationMinutes: Math.max(1, Math.round(hours * 60)),
    durationSource: "estimated",
  };
}

const northTerritories = new Set(
  [
    "North East",
    "North West",
    "Northern Ireland",
    "Scotland",
    "Yorkshire",
  ].map(normalise),
);
const midlandsTerritories = new Set(
  ["East Midlands", "Wales", "West Midlands"].map(normalise),
);
const southTerritories = new Set(
  ["East Anglia", "London", "South East", "South West"].map(normalise),
);

/** Republic of Ireland only. Northern Ireland stays in North. */
const irelandTerritories = new Set(
  ["Ireland", "Republic of Ireland", "Eire"].map(normalise),
);

/** Continental Europe by UN sub-region. Classification only; no engineer coverage. */
const northernEuropeTerritories = new Set(
  [
    "Denmark",
    "Estonia",
    "Finland",
    "Iceland",
    "Latvia",
    "Lithuania",
    "Norway",
    "Sweden",
  ].map(normalise),
);
const easternEuropeTerritories = new Set(
  [
    "Belarus",
    "Bulgaria",
    "Czechia",
    "Czech Republic",
    "Hungary",
    "Moldova",
    "Poland",
    "Romania",
    "Russia",
    "Slovakia",
    "Ukraine",
  ].map(normalise),
);
const southernEuropeTerritories = new Set(
  [
    "Albania",
    "Bosnia and Herzegovina",
    "Croatia",
    "Cyprus",
    "Greece",
    "Italy",
    "Malta",
    "Montenegro",
    "North Macedonia",
    "Portugal",
    "Serbia",
    "Slovenia",
    "Spain",
  ].map(normalise),
);
const westernEuropeTerritories = new Set(
  [
    "Austria",
    "Belgium",
    "France",
    "Germany",
    "Liechtenstein",
    "Luxembourg",
    "Monaco",
    "Netherlands",
    "Switzerland",
  ].map(normalise),
);

function normalise(value: unknown) {
  return String(value ?? "")
    .replace(/\s*&\s*/g, " & ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-GB");
}

function londonDate(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return londonCalendarDate(parsed);
}

function isoDayNumber(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function mondayOf(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const offset = (utc.getUTCDay() + 6) % 7;
  return isoDayNumber(
    new Date(Date.UTC(year, month - 1, day - offset))
      .toISOString()
      .slice(0, 10),
  );
}

function addYears(date: string, years: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year + years, month - 1, day))
    .toISOString()
    .slice(0, 10);
}

function dueBucket(dueDate: string | null, scopeDate: string): DemandDueBucket {
  if (!dueDate) return "none";
  const due = londonDate(dueDate) ?? (/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : null);
  if (!due) return "none";
  if (due === scopeDate) return "today";
  const dueDay = isoDayNumber(due);
  const currentDay = isoDayNumber(scopeDate);
  const currentMonday = mondayOf(scopeDate);
  if (dueDay > currentDay && dueDay <= currentMonday + 6) return "this_week";
  if (dueDay >= currentMonday + 7 && dueDay <= currentMonday + 13) return "next_week";
  if (dueDay >= currentMonday + 14 && dueDay <= currentMonday + 20) return "week_after";
  if (due <= addYears(scopeDate, 1)) return "within_12_months";
  return "tbc";
}

export function requestTypeForStatus(
  statusId: number,
  ids: OperationalIds,
): DemandRequestType | null {
  if (ids.requestedStatusIds.has(statusId)) return "requested";
  if (ids.accessStatusIds.has(statusId)) return "access";
  if (ids.thirdPartyRequestStatusIds.has(statusId)) return "third_party";
  return null;
}

export function workstreamForQueue(
  queueId: number,
  ids: OperationalIds,
): DemandWorkstream | null {
  if (ids.supportQueueIds.has(queueId)) return "support";
  if (ids.installQueueIds.has(queueId)) return "install";
  if (ids.surveyQueueIds.has(queueId)) return null;
  return queueId > 0 ? "other" : null;
}

/** Match on ISO-3166 country code. Territory labels are editable free text. */
const countryCodeGroups: Record<string, DemandTerritoryGroup> = {
  GB: "Other",
  IE: "Ireland",
  DK: "Northern Europe",
  EE: "Northern Europe",
  FI: "Northern Europe",
  IS: "Northern Europe",
  LV: "Northern Europe",
  LT: "Northern Europe",
  NO: "Northern Europe",
  SE: "Northern Europe",
  BY: "Eastern Europe",
  BG: "Eastern Europe",
  CZ: "Eastern Europe",
  HU: "Eastern Europe",
  MD: "Eastern Europe",
  PL: "Eastern Europe",
  RO: "Eastern Europe",
  RU: "Eastern Europe",
  SK: "Eastern Europe",
  UA: "Eastern Europe",
  AL: "Southern Europe",
  BA: "Southern Europe",
  HR: "Southern Europe",
  CY: "Southern Europe",
  GR: "Southern Europe",
  IT: "Southern Europe",
  MT: "Southern Europe",
  ME: "Southern Europe",
  MK: "Southern Europe",
  PT: "Southern Europe",
  RS: "Southern Europe",
  SI: "Southern Europe",
  ES: "Southern Europe",
  AT: "Western Europe",
  BE: "Western Europe",
  FR: "Western Europe",
  DE: "Western Europe",
  LI: "Western Europe",
  LU: "Western Europe",
  MC: "Western Europe",
  NL: "Western Europe",
  CH: "Western Europe",
};

export function territoryGroupForLabel(
  label: string | null,
  countryCode?: string | null,
): DemandTerritoryGroup {
  // A non-GB country code wins over a UK-looking territory label.
  const code = String(countryCode ?? "").trim().toUpperCase();
  if (code && code !== "GB") {
    return countryCodeGroups[code] ?? "Other";
  }

  const territory = normalise(label);
  if (irelandTerritories.has(territory)) return "Ireland";
  if (northernEuropeTerritories.has(territory)) return "Northern Europe";
  if (easternEuropeTerritories.has(territory)) return "Eastern Europe";
  if (southernEuropeTerritories.has(territory)) return "Southern Europe";
  if (westernEuropeTerritories.has(territory)) return "Western Europe";
  if (northTerritories.has(territory)) return "North";
  if (midlandsTerritories.has(territory)) return "Midlands";
  if (southTerritories.has(territory)) return "South";
  return "Other";
}

export function classifyPlanningDemandCandidate(
  candidate: PlanningDemandCandidate,
  scopeDate: string,
  generatedAt: string,
  ids: OperationalIds,
): PlanningDemandItem | null {
  const requestType = requestTypeForStatus(candidate.statusId, ids);
  const workstream = workstreamForQueue(candidate.queueId, ids);
  if (!requestType || !workstream) return null;
  const changed = candidate.statusChangedAt
    ? Date.parse(candidate.statusChangedAt)
    : Number.NaN;
  const generated = Date.parse(generatedAt);
  const ageBand: DemandAgeBand = Number.isFinite(changed) && Number.isFinite(generated)
    ? generated - changed > 24 * 60 * 60 * 1000
      ? "aged"
      : "fresh"
    : "unknown";
  const dueLocal = candidate.dueDate ? londonDate(candidate.dueDate) : null;
  return {
    ...candidate,
    id: `ticket:${candidate.ticketId}`,
    workstream,
    requestType,
    territoryGroup: territoryGroupForLabel(
      candidate.logisticsTerritory,
      candidate.countryCode,
    ),
    ageBand,
    dueBucket: dueBucket(candidate.dueDate, scopeDate),
    overdue: dueLocal !== null && dueLocal < scopeDate,
    readiness:
      candidate.exclusionReason === null
        ? "eligible"
        : "blocked",
  };
}

export function buildPlanningDemandSnapshot(args: {
  ids: OperationalIds;
  generatedAt?: string;
  scopeDate: string;
  candidates: PlanningDemandCandidate[];
  warnings?: string[];
}): PlanningDemandSnapshot {
  const generatedAt = args.generatedAt ?? new Date().toISOString();
  const items = args.candidates
    .map((candidate) =>
      classifyPlanningDemandCandidate(candidate, args.scopeDate, generatedAt, args.ids),
    )
    .filter((item): item is PlanningDemandItem => item !== null);
  const mapped = items.filter(
    (item) => item.latitude !== null && item.longitude !== null,
  ).length;
  return {
    source: "autotask-planning-demand",
    generatedAt,
    scopeDate: args.scopeDate,
    warnings: [...(args.warnings ?? [])],
    counts: {
      total: items.length,
      mapped,
      unmapped: items.length - mapped,
      eligible: items.filter((item) => item.readiness === "eligible").length,
      blocked: items.filter((item) => item.readiness === "blocked").length,
      aged: items.filter((item) => item.ageBand === "aged").length,
      overdue: items.filter((item) => item.overdue).length,
    },
    items,
  };
}

/** Resolve links in the app without overriding a snapshot's explicit suppression. */
export function projectPlanningDemandSnapshot(snapshot: PlanningDemandSnapshot, webUrl: string | null = null): PlanningDemandSnapshot {
  return {
    ...snapshot,
    source: "postgres-planning-demand-cache",
    items: snapshot.items.map((item) => ({
      ...item,
      autotaskUrl: item.autotaskUrl === null ? null : autotaskTicketUrl(item.ticketId, webUrl),
    })),
  };
}
