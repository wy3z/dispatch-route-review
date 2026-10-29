import { autotaskTicketUrl } from "../links";
import type { ScheduleSnapshot, ScheduledVisit } from "../contracts";

/** Browser DTO. Also strips sensitive or obsolete fields from historical cache rows. */
export function projectScheduledVisit(
  visit: ScheduledVisit & Record<string, unknown>,
  webUrl: string | null = null,
): ScheduledVisit {
  return {
    id: visit.id,
    serviceCallId: visit.serviceCallId,
    ticketId: visit.ticketId,
    ticketNumber: visit.ticketNumber,
    title: visit.title,
    autotaskUrl: visit.autotaskUrl === null ? null : autotaskTicketUrl(visit.ticketId, webUrl),
    companyName: visit.companyName,
    locationName: visit.locationName,
    address: visit.address,
    city: visit.city,
    postcode: visit.postcode,
    resourceId: visit.resourceId,
    resourceName: visit.resourceName,
    routeOwnerKey: visit.routeOwnerKey,
    ownerType: visit.ownerType,
    thirdPartyCompany: visit.thirdPartyCompany ?? null,
    ticketStatusId: visit.ticketStatusId,
    ticketStatusLabel: visit.ticketStatusLabel,
    queueId: visit.queueId,
    queueLabel: visit.queueLabel,
    jobType: visit.jobType,
    ignoredResourceCount: visit.ignoredResourceCount,
    startDateTime: visit.startDateTime,
    endDateTime: visit.endDateTime,
    durationMinutes: visit.durationMinutes,
    status: visit.status,
    isComplete: visit.isComplete,
    latitude: visit.latitude,
    longitude: visit.longitude,
    additionalTicketCount: visit.additionalTicketCount,
  };
}

export function projectScheduleSnapshot(
  snapshot: ScheduleSnapshot,
  webUrl: string | null = null,
): ScheduleSnapshot {
  return {
    source: snapshot.source,
    date: snapshot.date,
    generatedAt: snapshot.generatedAt,
    visits: snapshot.visits.map((visit) =>
      projectScheduledVisit(
        visit as ScheduledVisit & Record<string, unknown>,
        webUrl,
      ),
    ),
    warnings: [...snapshot.warnings],
  };
}
