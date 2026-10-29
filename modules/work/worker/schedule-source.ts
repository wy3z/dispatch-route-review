import { thirdPartyCompanyField } from "./assignment-config";
import { groupBy } from "../../../shared/collections";
import type { ScheduleSnapshot, ScheduledVisit } from "../contracts";
import { findEngineerBase } from "@/modules/engineers/domain";
import { listEngineerRoster } from "@/modules/engineers/server";
import {
  selectedThirdPartyVisitStatusIds,
  syncThirdPartyVisitStatusCatalog,
} from "../server/third-party-statuses";
import { locationPostcode } from "./autotask-location";
import {
  addIsoCalendarDays,
  isIsoCalendarDate,
  londonCalendarDate,
  londonLocalMidnightUtc,
} from "../../../shared/calendar";
import { assertCacheWorker, autotaskCredentials, autotaskEntityFields, autotaskQuery, autotaskQueryByIds, autotaskQueryLookupByIds } from "./autotask-server";
import { mapById, numberValue, stringValue } from "./autotask-records";
import { geocodeCompanyLocations } from "./geocoding";
import type { AutotaskRecord } from "./autotask-records";
import {
  buildServiceCallTicketContexts,
  reconcileServiceCallProjection,
} from "./service-call-ticket-links";
import { classifyScheduleVisitOwner } from "../schedule/assignment";
import {
  assertConfiguredIdsExist,
  operationalIdsConfiguration,
  type OperationalIds,
} from "../operational-ids";
import { estimatedJsonBytes, WorkerCache } from "./memory-cache";

const RESOURCE_CACHE_MS = 60 * 60 * 1000;
const TICKET_FIELD_CACHE_MS = 60 * 60 * 1000;
const MEBIBYTE = 1024 * 1024;
type TicketFieldLabels = {
  statuses: Map<number, string>;
  queues: Map<number, string>;
};
let ticketFieldLabelsPromise: Promise<TicketFieldLabels> | null = null;
let ticketFieldLabelsOwnerSignal: AbortSignal | null = null;
/** Worker-owned ticket labels avoid repeating catalog sync on every date. */
const ticketFieldLabelsCache = new WorkerCache<string, TicketFieldLabels>({
  name: "ticket_field_labels",
  ttlMs: TICKET_FIELD_CACHE_MS,
  maxEntries: 1,
  maxEstimatedBytes: 4 * MEBIBYTE,
  estimateBytes: (key, labels) =>
    estimatedJsonBytes([
      key,
      {
        statuses: [...labels.statuses],
        queues: [...labels.queues],
      },
    ]),
});
/** Worker-owned active roster source avoids a full Resources query per date. */
const activeResourcesCache = new WorkerCache<string, AutotaskRecord[]>({
  name: "active_resources",
  ttlMs: RESOURCE_CACHE_MS,
  maxEntries: 1,
  maxEstimatedBytes: 8 * MEBIBYTE,
});
let activeResourcesPromise: Promise<AutotaskRecord[]> | null = null;
let activeResourcesOwnerSignal: AbortSignal | null = null;

async function awaitSharedWorkerLoad<T>(
  pending: Promise<T>,
  ownerSignal: AbortSignal | null,
  callerSignal: AbortSignal,
  retry: () => Promise<T>,
) {
  try {
    return await pending;
  } catch (error) {
    callerSignal.throwIfAborted();
    if (ownerSignal?.aborted) return retry();
    throw error;
  }
}

async function ticketFieldLabels(
  signal: AbortSignal,
  ids: OperationalIds,
): Promise<TicketFieldLabels> {
  const cached = ticketFieldLabelsCache.get("tickets");
  if (cached) return cached;

  if (ticketFieldLabelsPromise) {
    return awaitSharedWorkerLoad(
      ticketFieldLabelsPromise,
      ticketFieldLabelsOwnerSignal,
      signal,
      (): Promise<TicketFieldLabels> => ticketFieldLabels(signal, ids),
    );
  }

  ticketFieldLabelsOwnerSignal = signal;
  const pending = autotaskEntityFields("Tickets", signal)
    .then(async (fields) => {
      const status = fields.find((field) => field.name === "status");
      const queue = fields.find(
        (field) => field.name === "queueID" || field.name === "queueId",
      );
      const labels = {
        statuses: new Map(
          (status?.picklistValues ?? []).map((value) => [
            numberValue(value.value),
            stringValue(value.label),
          ]),
        ),
        queues: new Map(
          (queue?.picklistValues ?? []).map((value) => [
            numberValue(value.value),
            stringValue(value.label),
          ]),
        ),
      };
      await syncThirdPartyVisitStatusCatalog(labels.statuses);
      assertConfiguredIdsExist(
        "Booked-work queue",
        [...ids.supportQueueIds, ...ids.installQueueIds, ...ids.surveyQueueIds],
        labels.queues,
      );
      ticketFieldLabelsCache.set("tickets", labels);
      return labels;
    });
  ticketFieldLabelsPromise = pending.finally(() => {
    ticketFieldLabelsPromise = null;
    ticketFieldLabelsOwnerSignal = null;
  });
  return ticketFieldLabelsPromise;
}

function bookedJobType(
  queueId: number,
  ids: OperationalIds,
): ScheduledVisit["jobType"] {
  if (ids.installQueueIds.has(queueId)) return "install";
  if (ids.supportQueueIds.has(queueId)) return "support";
  if (ids.surveyQueueIds.has(queueId)) return "survey";
  return "other";
}

function normaliseThirdPartyStatusLabel(label: string) {
  return label
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*&\s*kit\s*$/i, "")
    .trim();
}

async function activeResources(
  signal: AbortSignal,
): Promise<AutotaskRecord[]> {
  const cached = activeResourcesCache.get("active");
  if (cached) return cached;

  if (activeResourcesPromise) {
    return awaitSharedWorkerLoad(
      activeResourcesPromise,
      activeResourcesOwnerSignal,
      signal,
      (): Promise<AutotaskRecord[]> => activeResources(signal),
    );
  }

  activeResourcesOwnerSignal = signal;
  activeResourcesPromise = autotaskQuery(
    "Resources",
    [{ field: "isActive", op: "eq", value: true }],
    signal,
  )
    .then((records) => {
      activeResourcesCache.set("active", records);
      return records;
    })
    .finally(() => {
      activeResourcesPromise = null;
      activeResourcesOwnerSignal = null;
    });
  return activeResourcesPromise;
}

function localDate(value: string) {
  return londonCalendarDate(new Date(value));
}

function utcBounds(date: string) {
  return {
    from: new Date(londonLocalMidnightUtc(date)).toISOString(),
    to: new Date(
      londonLocalMidnightUtc(addIsoCalendarDays(date, 1)),
    ).toISOString(),
  };
}

export async function loadAutotaskSchedule(
  date: string,
  signal: AbortSignal,
  ids: OperationalIds = operationalIdsConfiguration(),
): Promise<ScheduleSnapshot> {
  assertCacheWorker();
  signal.throwIfAborted();
  if (!isIsoCalendarDate(date)) {
    throw new Error("A valid schedule date is required.");
  }
  if (!autotaskCredentials()) {
    throw new Error("Autotask credentials are unavailable to the cache worker.");
  }

  try {
    const bounds = utcBounds(date);
    const [
      callsResult,
      ticketLabels,
      prefetchedResources,
      engineerRoster,
      thirdPartyStatusIds,
    ] = await Promise.all([
      autotaskQuery(
        "ServiceCalls",
        [
          { field: "startDateTime", op: "gte", value: bounds.from },
          { field: "startDateTime", op: "lt", value: bounds.to },
        ],
        signal,
      ),
      ticketFieldLabels(signal, ids),
      activeResources(signal),
      listEngineerRoster({ includeInactive: true }),
      selectedThirdPartyVisitStatusIds(),
    ]);
    if (engineerRoster.length === 0) {
      throw new Error(
        "The engineer roster is empty; scheduled assignments cannot be classified.",
      );
    }
    const calls = callsResult.filter(
      (call) =>
        !call.canceledDateTime &&
        localDate(stringValue(call.startDateTime)) === date,
    );

    const callIds = calls.map((call) => numberValue(call.id));
    const companyIds = calls.map((call) => numberValue(call.companyID));
    const [links, companiesResult, companyLocations] = await Promise.all([
      autotaskQueryByIds(
        "ServiceCallTickets",
        "serviceCallID",
        callIds,
        signal,
      ),
      autotaskQueryLookupByIds("Companies", companyIds, signal).then(
        (records) => ({ records, error: null as string | null }),
        (error) => {
          signal.throwIfAborted();
          return {
            records: [] as AutotaskRecord[],
            error: error instanceof Error ? error.message : String(error),
          };
        },
      ),
      autotaskQueryLookupByIds(
        "CompanyLocations",
        calls.map((call) => numberValue(call.companyLocationID)),
        signal,
      ),
    ]);
    const companies = companiesResult.records;
    const companiesWarning = companiesResult.error
      ? companiesResult.error.toLowerCase().includes("permission") ||
        companiesResult.error.toLowerCase().includes("adequate")
        ? "Companies could not be loaded due to Autotask permissions."
        : `Companies could not be loaded: ${companiesResult.error}`
      : null;
    const linkIds = links.map((link) => numberValue(link.id));
    const countriesPromise = autotaskQueryLookupByIds(
      "Countries",
      companyLocations.map((location) => numberValue(location.countryID)),
      signal,
    );
    const coordinatesPromise = countriesPromise.then((countries) =>
      geocodeCompanyLocations(companyLocations, countries, signal),
    );

    const [assignments, tickets, coordinates] = await Promise.all([
      autotaskQueryByIds(
        "ServiceCallTicketResources",
        "serviceCallTicketID",
        linkIds,
        signal,
      ),
      autotaskQueryByIds(
        "Tickets",
        "id",
        links.map((link) => numberValue(link.ticketID)),
        signal,
      ),
      coordinatesPromise,
    ]);

    const prefetchedResourceIds = new Set(
      prefetchedResources.map((resource) => numberValue(resource.id)),
    );
    const inactiveResources = await autotaskQueryLookupByIds(
      "Resources",
      assignments
        .map((assignment) => numberValue(assignment.resourceID))
        .filter((resourceId) => !prefetchedResourceIds.has(resourceId)),
      signal,
    );
    const resources = [...prefetchedResources, ...inactiveResources];

    const callLinks = groupBy(links, (link) => numberValue(link.serviceCallID));
    const linkAssignments = groupBy(assignments, (assignment) => numberValue(assignment.serviceCallTicketID));

    const ticketMap = mapById(tickets);
    const companyMap = mapById(companies);
    const locationMap = mapById(companyLocations);
    const resourceMap = mapById(resources);
    const serviceCallContexts = buildServiceCallTicketContexts(
      calls,
      callLinks,
      ticketMap,
      thirdPartyStatusIds,
    );

    const visits: ScheduledVisit[] = [];
    serviceCallContexts.forEach(
      ({
        call,
        serviceCallId,
        relatedLinks,
        ticketId,
        ticket: linkedTicket,
        additionalTicketCount,
      }) => {
      const ticket = linkedTicket ?? {};
      const ticketStatusId = numberValue(ticket.status);
      const ticketStatusLabel =
        ticketLabels.statuses.get(ticketStatusId) ||
        (ticketId === null ? "Ticket not linked" : `Status ${ticketStatusId}`);
      const queueId = numberValue(ticket.queueID ?? ticket.queueId);
      const queueLabel =
        ticketLabels.queues.get(queueId) ||
        (queueId ? `Queue ${queueId}` : "Queue not set");
      const thirdPartyVisit = thirdPartyStatusIds.has(ticketStatusId);
      const thirdPartyStatusLabel = thirdPartyVisit
        ? normaliseThirdPartyStatusLabel(ticketStatusLabel)
        : ticketStatusLabel;
      const company = companyMap.get(numberValue(call.companyID)) ?? {};
      const location = locationMap.get(numberValue(call.companyLocationID)) ?? {};
      const postcode = locationPostcode(location);
      const point = coordinates.get(numberValue(location.id));
      const callAssignments = relatedLinks.flatMap(
        (link) => linkAssignments.get(numberValue(link.id)) ?? [],
      );
      const deduplicatedAssignments = [
        ...new Map(
          callAssignments.map((assignment) => [
            numberValue(assignment.resourceID),
            assignment,
          ]),
        ).values(),
      ];
      const recognisedAssignments = deduplicatedAssignments
        .map((assignment) => {
          const assignedResourceId = numberValue(assignment.resourceID);
          const assignedResource = resourceMap.get(
            assignedResourceId,
          );
          const assignedName = assignedResource
            ? `${stringValue(assignedResource.firstName)} ${stringValue(assignedResource.lastName)}`.trim()
            : "";
          return {
            assignment,
            engineer: findEngineerBase(
              engineerRoster,
              assignedResourceId,
              assignedName,
            ),
          };
        })
        .filter(
          (
            recognised,
          ): recognised is {
            assignment: (typeof deduplicatedAssignments)[number];
            engineer: NonNullable<ReturnType<typeof findEngineerBase>>;
          } => Boolean(recognised.engineer),
        );
      const isComplete = numberValue(call.isComplete) === 1;
      const effectiveAssignments = thirdPartyVisit
        ? [null]
        : recognisedAssignments.length
          ? recognisedAssignments
          : [null];

      const startDateTime = stringValue(call.startDateTime);
      const endDateTime = stringValue(call.endDateTime);
      const computedDuration = Math.max(
        1,
        Math.round(
          (new Date(endDateTime).getTime() -
            new Date(startDateTime).getTime()) /
            60000,
        ),
      );

      const callDetails = {
        serviceCallId,
        ticketId,
        ticketNumber: stringValue(ticket.ticketNumber),
        title:
          stringValue(ticket.title) ||
          `Service call ${serviceCallId}`,
        companyName:
          stringValue(company.companyName) ||
          stringValue(location.name) ||
          "Unknown company",
        locationName: stringValue(location.name),
        address: [location.address1, location.address2]
          .map(stringValue)
          .filter(Boolean)
          .join(", "),
        city: stringValue(location.city),
        postcode,
        ticketStatusId,
        ticketStatusLabel,
        queueId,
        queueLabel,
        jobType: bookedJobType(queueId, ids),
        startDateTime,
        endDateTime,
        durationMinutes:
          computedDuration || Math.round(numberValue(call.duration) * 60),
        status: numberValue(call.status),
        isComplete,
        latitude: point?.latitude ?? null,
        longitude: point?.longitude ?? null,
        additionalTicketCount,
      };

      effectiveAssignments.forEach((recognisedAssignment) => {
        const assignment = recognisedAssignment?.assignment ?? null;
        const recognisedEngineer = recognisedAssignment?.engineer ?? null;
        const owner = classifyScheduleVisitOwner({
          isThirdPartyStatus: thirdPartyVisit,
          ticketStatusId,
          thirdPartyLabel: thirdPartyStatusLabel,
          ticketUserDefinedFields: ticket.userDefinedFields,
          thirdPartyCompanyField: thirdPartyCompanyField(),
          isComplete,
          assignmentCount: deduplicatedAssignments.length,
          recognisedAssignmentCount: recognisedAssignments.length,
          recognisedAssignment:
            assignment && recognisedEngineer
              ? {
                  resourceId: numberValue(assignment.resourceID),
                  resourceName: recognisedEngineer.name,
                }
              : null,
        });
        visits.push({
          ...callDetails,
          id: `${serviceCallId}-${owner.routeOwnerKey}`,
          resourceId: owner.resourceId,
          resourceName: owner.resourceName,
          routeOwnerKey: owner.routeOwnerKey,
          ownerType: owner.ownerType,
          thirdPartyCompany: owner.thirdPartyCompany ?? null,
          ignoredResourceCount: owner.ignoredResourceCount,
        });
      });
    });

    visits.sort(
      (first, second) =>
        new Date(first.startDateTime).getTime() -
          new Date(second.startDateTime).getTime() ||
        first.resourceName.localeCompare(second.resourceName),
    );

    const warnings: string[] = [];
    if (companiesWarning) warnings.push(companiesWarning);
    const missingThirdPartyCompanies = visits.filter(
      (visit) => visit.ownerType === "third-party" && !visit.thirdPartyCompany,
    ).length;
    if (thirdPartyCompanyField() && missingThirdPartyCompanies) {
      warnings.push(
        `${missingThirdPartyCompanies} third-party attendance records have no usable configured company field value; status-based fallback groups are shown.`,
      );
    }
    const missingTicketLinks = serviceCallContexts.filter(
      (context) => context.relatedLinks.length === 0,
    ).length;
    if (missingTicketLinks) {
      warnings.push(
        `${missingTicketLinks} scheduled service call${missingTicketLinks === 1 ? "" : "s"} without a linked ticket ${missingTicketLinks === 1 ? "is" : "are"} shown using service-call data.`,
      );
    }
    const reconciliation = reconcileServiceCallProjection(
      serviceCallContexts,
      visits,
    );
    if (reconciliation.unprojectedServiceCallIds.length) {
      warnings.push(
        `Schedule projection retained ${reconciliation.projectedCount} of ${reconciliation.sourceCount} source service calls; omitted service call IDs: ${reconciliation.unprojectedServiceCallIds.join(", ")}.`,
      );
    }
    const missingPostcodes = visits.filter(
      (visit) =>
        !visit.postcode &&
        (visit.latitude === null || visit.longitude === null),
    ).length;
    const unmapped = visits.filter(
      (visit) => visit.latitude === null || visit.longitude === null,
    ).length;
    const unresolvedCompletedAssignments = visits.filter(
      (visit) => visit.isComplete && visit.ownerType === "unassigned",
    ).length;
    if (missingPostcodes) {
      warnings.push(`${missingPostcodes} attendance records have no postcode.`);
    }
    if (unmapped) {
      warnings.push(`${unmapped} attendance records could not be geocoded.`);
    }
    if (unresolvedCompletedAssignments) {
      warnings.push(
        `${unresolvedCompletedAssignments} completed attendance records have an unresolved engineer assignment.`,
      );
    }

    const snapshot: ScheduleSnapshot = {
      source: "autotask",
      date,
      generatedAt: new Date().toISOString(),
      visits,
      warnings,
    };
    return snapshot;
  } catch (error) {
    signal.throwIfAborted();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The scheduled service calls could not be loaded from Autotask. ${detail}`,
      { cause: error },
    );
  }
}
