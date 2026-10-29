import type { DemandWorkstream, PlanningDemandItem } from "./demand/model";
import type { ScheduledVisit } from "./contracts";

/** Worker-derived job type. Queue text is a fallback label, never a classifier. */
export function jobTypeLabel(
  jobType: ScheduledVisit["jobType"],
  queueLabel = "",
) {
  switch (jobType) {
    case "install":
      return "Install";
    case "support":
      return "Support";
    case "survey":
      return "Survey";
    case "other":
      return queueLabel.trim() || "Queue not set";
  }
}

/** Display an already ID-derived planning-demand workstream. */
export function demandQueueLabel(
  item: Pick<PlanningDemandItem, "workstream" | "queueLabel">,
) {
  if (item.workstream === "install") return "Install";
  if (item.workstream === "support") return "Support";
  return item.queueLabel.trim() || "Queue not set";
}

/** Semantic map colour for an already ID-derived demand workstream. */
export function demandWorkstreamColour(workstream: DemandWorkstream) {
  if (workstream === "install") return "#7C5CFC";
  if (workstream === "support") return "#00A7D6";
  return "#2EAE72";
}

export function routeInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "—";
}

export function readyToBookAttentionReasons(item: PlanningDemandItem) {
  const reasons: string[] = [];
  if (item.exclusionReason) {
    reasons.push(
      item.exclusionDetail ||
        "Site location is outside current engineer coverage.",
    );
  }
  if (item.ageBand === "aged") reasons.push("Waiting over 24 hours");
  if (item.overdue) reasons.push("Overdue");
  return reasons;
}

export function readyToBookAttentionTone(item: PlanningDemandItem) {
  if (item.overdue) return "critical";
  return readyToBookAttentionReasons(item).length ? "warning" : null;
}
