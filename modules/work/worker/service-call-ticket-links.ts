import type { ScheduledVisit } from "../contracts";
import { numberValue } from "./autotask-records";
import type { AutotaskRecord } from "./autotask-records";

export type ServiceCallTicketContext = {
  call: AutotaskRecord;
  serviceCallId: number;
  relatedLinks: readonly AutotaskRecord[];
  ticketId: number | null;
  ticket: AutotaskRecord | null;
  additionalTicketCount: number;
};

/** Build one ticket context for every source service call, including zero-link calls. */
export function buildServiceCallTicketContexts(
  calls: readonly AutotaskRecord[],
  callLinks: ReadonlyMap<number, readonly AutotaskRecord[]>,
  ticketMap: ReadonlyMap<number, AutotaskRecord>,
  thirdPartyStatusIds: ReadonlySet<number>,
): ServiceCallTicketContext[] {
  return calls.map((call) => {
    const serviceCallId = numberValue(call.id);
    const relatedLinks = callLinks.get(serviceCallId) ?? [];
    const thirdPartyLink = relatedLinks.find((link) => {
      const linkedTicket = ticketMap.get(numberValue(link.ticketID));
      return thirdPartyStatusIds.has(numberValue(linkedTicket?.status));
    });
    const primaryLink = thirdPartyLink ?? relatedLinks[0] ?? null;
    const ticketId = primaryLink
      ? numberValue(primaryLink.ticketID) || null
      : null;

    return {
      call,
      serviceCallId,
      relatedLinks,
      ticketId,
      ticket: ticketId === null ? null : ticketMap.get(ticketId) ?? null,
      additionalTicketCount: Math.max(0, relatedLinks.length - 1),
    };
  });
}

export type ServiceCallProjectionReconciliation = {
  sourceCount: number;
  projectedCount: number;
  unprojectedServiceCallIds: number[];
};

/** Reconcile unique source calls against projected visits; duplicate assignments count once. */
export function reconcileServiceCallProjection(
  sourceContexts: readonly Pick<ServiceCallTicketContext, "serviceCallId">[],
  projectedVisits: readonly Pick<ScheduledVisit, "serviceCallId">[],
): ServiceCallProjectionReconciliation {
  const sourceServiceCallIds = [
    ...new Set(sourceContexts.map((context) => context.serviceCallId)),
  ];
  const projectedServiceCallIds = new Set(
    projectedVisits.map((visit) => visit.serviceCallId),
  );
  const unprojectedServiceCallIds = sourceServiceCallIds.filter(
    (serviceCallId) => !projectedServiceCallIds.has(serviceCallId),
  );

  return {
    sourceCount: sourceServiceCallIds.length,
    projectedCount:
      sourceServiceCallIds.length - unprojectedServiceCallIds.length,
    unprojectedServiceCallIds,
  };
}
