import type { ScheduledVisit } from "../contracts";

export type ScheduledVisitStatusCounts = {
  all: number;
  open: number;
  complete: number;
};

/** Service-call status counts without double-counting multi-owner visit rows. */
export function scheduledVisitStatusCounts(
  visits: readonly Pick<ScheduledVisit, "serviceCallId" | "isComplete">[],
): ScheduledVisitStatusCounts {
  const byCall = new Map<number, boolean>();
  visits.forEach((visit) =>
    byCall.set(visit.serviceCallId, visit.isComplete),
  );
  const complete = [...byCall.values()].filter(Boolean).length;
  return {
    all: byCall.size,
    open: byCall.size - complete,
    complete,
  };
}
