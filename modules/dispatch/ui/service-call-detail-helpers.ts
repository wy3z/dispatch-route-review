import type { ScheduledVisit } from "@/modules/work/contracts";

export function formatServiceCallDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

export function joinServiceCallAddress(visit: ScheduledVisit) {
  return [visit.address, visit.city, visit.postcode]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(", ");
}

export function ownerTypeLabel(ownerType: ScheduledVisit["ownerType"]) {
  switch (ownerType) {
    case "internal":
      return "Internal engineer";
    case "third-party":
      return "Third-party attendance";
    case "unassigned":
      return "Unassigned";
    default:
      return ownerType;
  }
}
