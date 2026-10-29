import type { PlanningDemandItem } from "@/modules/work/contracts";
import { formatMiles } from "../../../shared/coordinates";
import { formatTime } from "../../../shared/formatting";
import { suggestionNearLabel } from "@/modules/routing/domain";
import type { StaticRoadTiming, EngineerRoute, RouteIssue } from "@/modules/routing/contracts";
import {
  demandQueueLabel,
  jobTypeLabel,
  readyToBookAttentionReasons,
  readyToBookAttentionTone,
} from "@/modules/work/presentation";
import type { MapSuggestionContext } from "../contracts";

export type { MapSuggestionContext } from "../contracts";

type PopupTone = "positive" | "warning" | "negative";

type PopupState = {
  label: string;
  detail?: string;
  iconPath: string;
  tone?: PopupTone;
};

type JobPopupOptions = {
  variant: "booked" | "unbooked";
  ticketLabel: string;
  ticketUrl: string | null;
  company: string;
  title: string;
  statusLabel: string;
  statusClassName: string;
  states: PopupState[];
};

const PERSON_ICON =
  "M10 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 7c.5-3.2 2.5-5 6-5s5.5 1.8 6 5";
const CALENDAR_ICON = "M4 5.5h12v11H4Zm3-3v5m6-5v5M4 9h12";
const CLOCK_ICON =
  "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm0 3v4l2.8 1.8";

function createSvgIcon(pathData: string) {
  const icon = document.createElement("i");
  icon.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  svg.append(path);
  icon.append(svg);
  return icon;
}

function createTicketReference(label: string, url: string | null) {
  const reference = document.createElement(url ? "a" : "div");
  reference.className = "audit-map-ticket-reference";
  if (url) {
    reference.setAttribute("href", url);
    reference.setAttribute("target", "_blank");
    reference.setAttribute("rel", "noreferrer");
    const favicon = document.createElement("span");
    favicon.className = "autotask-favicon";
    favicon.setAttribute("aria-hidden", "true");
    reference.append(favicon);
  }
  const text = document.createElement("span");
  text.textContent = label;
  reference.append(text);
  return reference;
}

function createJobPopup(options: JobPopupOptions) {
  const content = document.createElement("div");
  const alertTone = options.states.some((state) => state.tone === "negative")
    ? "negative"
    : options.states.some((state) => state.tone === "warning")
      ? "warning"
      : null;
  content.className = `audit-map-popup audit-map-job-popup ${options.variant}${alertTone ? ` has-${alertTone}` : ""}`;

  const header = document.createElement("div");
  header.className = "audit-map-popup-header";
  header.append(createTicketReference(options.ticketLabel, options.ticketUrl));

  const identity = document.createElement("div");
  identity.className = "audit-map-ticket-copy audit-map-job-identity";
  const identityHeading = document.createElement("div");
  identityHeading.className = "audit-map-job-identity-head";
  const company = document.createElement("strong");
  company.textContent = options.company;
  const status = document.createElement("i");
  status.className = `audit-map-status ${options.statusClassName}`;
  status.textContent = options.statusLabel;
  identityHeading.append(company, status);
  const title = document.createElement("small");
  title.className = "audit-map-ticket-title";
  title.textContent = options.title;
  identity.append(identityHeading, title);

  const states = document.createElement("div");
  states.className = "audit-map-job-states";
  options.states.forEach((item) => {
    const state = document.createElement("span");
    if (item.tone) state.className = item.tone;
    const copy = document.createElement("span");
    copy.className = "audit-map-job-state-copy";
    const label = document.createElement("b");
    label.textContent = item.label;
    copy.append(label);
    if (item.detail) {
      const detail = document.createElement("small");
      detail.textContent = item.detail;
      copy.append(detail);
    }
    state.append(createSvgIcon(item.iconPath), copy);
    states.append(state);
  });

  const details = document.createElement("dl");
  details.className = "audit-map-job-details";
  const addDetail = (label: string, value: string) => {
    if (!value) return;
    const row = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const definition = document.createElement("dd");
    definition.textContent = value;
    row.append(term, definition);
    details.append(row);
  };

  content.append(header, identity, states, details);
  return { content, addDetail };
}

function roadEstimate(timing: StaticRoadTiming) {
  if (timing.availability === "unavailable") return "Unavailable";
  if (timing.kind === "return") {
    return `${formatTime(timing.estimatedTravelStartDateTime)}–${formatTime(timing.estimatedArrivalDateTime)}`;
  }
  return `${formatTime(timing.estimatedTravelStartDateTime)}–${formatTime(timing.bookedArrivalDateTime)}`;
}

function bookedArrivalState(
  timing: StaticRoadTiming,
  issueSeverity?: RouteIssue["severity"],
): PopupState {
  if (timing.availability === "unavailable") {
    return {
      label: "Arrival unavailable",
      detail: "No road estimate",
      iconPath: CLOCK_ICON,
    };
  }
  if (timing.kind === "return") {
    return {
      label: `${formatTime(timing.estimatedArrivalDateTime)} return`,
      detail: "Static estimate",
      iconPath: CLOCK_ICON,
    };
  }
  const arrival = timing.earliestArrivalDateTime;
  const margin = timing.marginMinutes;
  const timingTone =
    typeof margin !== "number"
      ? undefined
      : margin < 0
        ? "negative"
        : margin < 15
          ? "warning"
          : "positive";
  const tone =
    timingTone === "negative" || issueSeverity === "critical"
      ? "negative"
      : issueSeverity || timingTone === "warning"
        ? "warning"
        : timingTone;
  return {
    label: `${formatTime(arrival ?? timing.bookedArrivalDateTime)} arrival`,
    detail:
      typeof margin === "number"
        ? margin >= 0
          ? `${margin} min margin`
          : `${Math.abs(margin)} min short`
        : arrival
          ? "Earliest arrival"
          : "Booked arrival",
    iconPath: CLOCK_ICON,
    tone,
  };
}

export function stopPopupContent(
  stop: EngineerRoute["stops"][number],
  timing: StaticRoadTiming,
  issueSeverity?: RouteIssue["severity"],
) {
  const popup = createJobPopup({
    variant: "booked",
    ticketLabel: stop.ticketNumber || `Service call ${stop.serviceCallId}`,
    ticketUrl: stop.autotaskUrl ?? null,
    company: stop.companyName,
    title: stop.title || jobTypeLabel(stop.jobType, stop.queueLabel),
    statusLabel: stop.isComplete
      ? "Complete"
      : stop.ticketStatusLabel || "Attending",
    statusClassName: stop.isComplete ? "complete" : "attending",
    states: [
      { label: stop.resourceName, iconPath: PERSON_ICON },
      {
        label: `${formatTime(stop.startDateTime)}–${formatTime(stop.endDateTime)}`,
        detail: "Scheduled",
        iconPath: CALENDAR_ICON,
      },
      bookedArrivalState(timing, issueSeverity),
    ],
  });

  popup.addDetail("Site", stop.companyName);
  popup.addDetail(
    "Location",
    [stop.city, stop.postcode].filter(Boolean).join(" · "),
  );
  popup.addDetail("Work duration", `${stop.durationMinutes} min`);
  popup.addDetail("Work type", jobTypeLabel(stop.jobType, stop.queueLabel));
  if (stop.ownerType === "third-party") popup.addDetail("Ownership", "Third party");
  if (issueSeverity) popup.addDetail("Review", `${issueSeverity === "critical" ? "Critical" : issueSeverity === "warning" ? "Warning" : "Data"} Route Issue`);
  popup.addDetail("Road estimate", roadEstimate(timing));
  return popup.content;
}

export function readyToBookPopupContent(
  item: PlanningDemandItem,
  suggestion: MapSuggestionContext | undefined,
) {
  const attentionReasons = readyToBookAttentionReasons(item);
  const attentionTone = readyToBookAttentionTone(item);
  const statusLabel =
    item.statusLabel ||
    (item.requestType === "third_party"
      ? "Third party"
      : item.requestType === "access"
        ? "Access"
        : "Unassigned request");
  const popup = createJobPopup({
    variant: "unbooked",
    ticketLabel: item.ticketNumber || `Ticket ${item.ticketId}`,
    ticketUrl: item.autotaskUrl ?? null,
    company: item.companyLabel || "Company unavailable",
    title: item.title || "Unassigned request",
    statusLabel,
    statusClassName: `ready${
      item.requestType === "third_party" ? " third-party" : ""
    }`,
    states: [
      { label: "Unassigned", iconPath: PERSON_ICON },
      { label: "No schedule", iconPath: CALENDAR_ICON },
      { label: "No ETA", iconPath: CLOCK_ICON },
    ],
  });

  popup.addDetail("Site", item.companyLabel || item.siteLabel);
  popup.addDetail(
    "Location",
    [item.city, item.postcode].filter(Boolean).join(" · "),
  );
  popup.addDetail(
    "Work duration",
    `${item.durationMinutes} min${item.durationSource === "assumed" ? " (assumed)" : ""}`,
  );
  popup.addDetail("Work type", demandQueueLabel(item));
  popup.addDetail(
    "Territory",
    item.logisticsTerritory && item.logisticsTerritory !== item.territoryGroup
      ? `${item.logisticsTerritory} · ${item.territoryGroup}`
      : item.territoryGroup,
  );
  popup.addDetail(
    "Age",
    item.ageBand === "aged" ? "Over 24 hours" : item.ageBand === "fresh" ? "Under 24 hours" : "Age unavailable",
  );
  if (item.readiness === "blocked") {
    popup.addDetail("Readiness", "Blocked");
    popup.addDetail("Reason", item.exclusionDetail || "Outside current engineer coverage");
  }
  if (suggestion) {
    popup.addDetail("Nearby route", suggestion.resourceName);
    popup.addDetail(
      "Straight-line proximity",
      `${formatMiles(suggestion.distanceKm)} · near ${suggestionNearLabel(suggestion)}`,
    );
  }

  if (attentionReasons.length) {
    const alert = document.createElement("div");
    alert.className = `audit-map-job-alert attention-${attentionTone ?? "warning"}`;
    const label = document.createElement("strong");
    label.textContent = "Needs attention";
    const detail = document.createElement("span");
    detail.textContent = attentionReasons.join(" · ");
    alert.append(
      createSvgIcon("M10 2.5 18 17H2Zm0 5v4m0 2.5v.1"),
      label,
      detail,
    );
    popup.content.append(alert);
  }
  return popup.content;
}
