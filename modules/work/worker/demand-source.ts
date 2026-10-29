import { assertCacheWorker, autotaskCredentials, autotaskEntityFields, autotaskQuery, autotaskQueryLookupByIds } from "./autotask-server";
import { mapById, numberValue, stringValue } from "./autotask-records";
import { geocodeCompanyLocations } from "./geocoding";
import type { AutotaskFieldInformation } from "./autotask-server";
import type { AutotaskRecord } from "./autotask-records";
import { locationPostcode } from "./autotask-location";
import { londonCalendarDate } from "../../../shared/calendar";
import { resolveSiteCoverage } from "../demand/coverage";
import { listEngineerRoster } from "@/modules/engineers/server";
import { buildPlanningDemandSnapshot, resolvePlanningDemandDuration } from "../demand/model";
import type { PlanningDemandCandidate, PlanningDemandSnapshot } from "../demand/model";
import {
  assertConfiguredIdsExist,
  operationalIdsConfiguration,
  type OperationalIds,
} from "../operational-ids";

function normalise(value: unknown) {
  return stringValue(value)
    .replace(/\s*&\s*/g, " & ")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-GB");
}

function field(
  fields: AutotaskFieldInformation[],
  candidates: string[],
) {
  const names = new Set(candidates.map(normalise));
  return fields.find((candidate) => names.has(normalise(candidate.name)));
}

function picklistById(
  fields: AutotaskFieldInformation[],
  candidates: string[],
) {
  const selected = field(fields, candidates);
  return new Map(
    (selected?.picklistValues ?? [])
      .map(
        (entry) =>
          [numberValue(entry.value), stringValue(entry.label)] as const,
      )
      .filter(([id, label]) => id > 0 && Boolean(label)),
  );
}

function recordDate(record: AutotaskRecord, candidates: string[]) {
  for (const name of candidates) {
    const value = stringValue(record[name]);
    if (value && Number.isFinite(Date.parse(value))) return value;
  }
  return null;
}

function countryCode(record: AutotaskRecord | undefined) {
  return stringValue(record?.countryCode).toUpperCase();
}

function countryName(record: AutotaskRecord | undefined) {
  return stringValue(record?.displayName) || stringValue(record?.name);
}

export async function loadPlanningDemand(
  signal: AbortSignal,
  ids: OperationalIds = operationalIdsConfiguration(),
): Promise<PlanningDemandSnapshot> {
  assertCacheWorker();
  signal.throwIfAborted();
  if (!autotaskCredentials()) {
    throw new Error("Autotask credentials are unavailable to the cache worker.");
  }

  try {
    const [ticketFields, companyFields, engineerRoster] = await Promise.all([
      autotaskEntityFields("Tickets", signal),
      autotaskEntityFields("Companies", signal),
      listEngineerRoster(),
    ]);
    const statusLabels = picklistById(ticketFields, ["status"]);
    const queueLabels = picklistById(ticketFields, ["queueID", "queueId"]);
    assertConfiguredIdsExist(
      "Planning-demand status",
      ids.planningDemandStatusIds,
      statusLabels,
    );
    assertConfiguredIdsExist(
      "Ready-to-book status",
      [ids.readyToBook.statusId],
      statusLabels,
    );
    assertConfiguredIdsExist(
      "Planning-demand queue",
      [...ids.supportQueueIds, ...ids.installQueueIds, ...ids.surveyQueueIds],
      queueLabels,
    );
    assertConfiguredIdsExist(
      "Ready-to-book queue",
      [ids.readyToBook.queueId],
      queueLabels,
    );

    const tickets = await autotaskQuery(
      "Tickets",
      [{ field: "status", op: "in", value: ids.planningDemandStatusIds }],
      signal,
    );
    const territoryFields = ["territoryID", "territoryId", "territory"];
    const ticketTerritories = picklistById(ticketFields, territoryFields);
    const companyTerritories = picklistById(companyFields, territoryFields);

    const companyIds = tickets.map((ticket) => numberValue(ticket.companyID));
    const locationIds = tickets.map((ticket) =>
      numberValue(ticket.companyLocationID),
    );
    const [companies, locations] = await Promise.all([
      autotaskQueryLookupByIds("Companies", companyIds, signal),
      autotaskQueryLookupByIds("CompanyLocations", locationIds, signal),
    ]);
    const countries = await autotaskQueryLookupByIds(
      "Countries",
      locations.map((location) => numberValue(location.countryID)),
      signal,
    );
    const coordinates = await geocodeCompanyLocations(
      locations,
      countries,
      signal,
    );
    const companiesById = mapById(companies);
    const locationsById = mapById(locations);
    const countriesById = mapById(countries);
    const warnings: string[] = [];
    if (engineerRoster.length === 0) {
      warnings.push(
        "The engineer roster has no active engineers, so UK planning coverage is unavailable.",
      );
    }
    let usedStatusDateFallback = false;

    const candidates: PlanningDemandCandidate[] = tickets.map((ticket) => {
      const ticketId = numberValue(ticket.id);
      const company = companiesById.get(numberValue(ticket.companyID));
      const locationId = numberValue(ticket.companyLocationID);
      const location = locationsById.get(locationId);
      const country = location
        ? countriesById.get(numberValue(location.countryID))
        : undefined;
      const point = coordinates.get(locationId);
      const postcode = location ? locationPostcode(location) : "";
      const coverage = resolveSiteCoverage(
        {
          latitude: point?.latitude ?? null,
          longitude: point?.longitude ?? null,
          postcode,
          countryCode: countryCode(country),
          countryName: countryName(country),
        },
        engineerRoster,
      );
      const duration = resolvePlanningDemandDuration(ticket.estimatedHours);
      const exactStatusDate = recordDate(ticket, [
        "lastStatusChangeDateTime",
        "lastStatusChangeDate",
      ]);
      const statusChangedAt = exactStatusDate ?? recordDate(ticket, [
        "lastActivityDate",
        "lastTrackedModificationDateTime",
      ]);
      if (!exactStatusDate && statusChangedAt) usedStatusDateFallback = true;
      const ticketTerritoryId = numberValue(
        ticket.territoryID ?? ticket.territoryId ?? ticket.territory,
      );
      const queueId = numberValue(ticket.queueID ?? ticket.queueId);
      const statusId = numberValue(ticket.status);
      const companyTerritoryId = numberValue(
        company?.territoryID ?? company?.territoryId ?? company?.territory,
      );
      return {
        ticketId,
        ticketNumber: stringValue(ticket.ticketNumber) || `T${ticketId}`,
        title: stringValue(ticket.title) || `Ticket ${ticketId}`,
        companyLabel:
          stringValue(company?.companyName) ||
          stringValue(location?.name) ||
          "Unknown company",
        siteLabel: stringValue(location?.name) || "Unknown site",
        city: stringValue(location?.city),
        postcode,
        latitude: point?.latitude ?? null,
        longitude: point?.longitude ?? null,
        durationMinutes: duration.durationMinutes,
        durationSource: duration.durationSource,
        routeRegion: coverage.region,
        logisticsTerritory:
          ticketTerritories.get(ticketTerritoryId) ||
          companyTerritories.get(companyTerritoryId) ||
          null,
        countryCode: countryCode(country) || null,
        queueId,
        queueLabel: queueLabels.get(queueId) || `Queue ${queueId}`,
        statusId,
        statusLabel: statusLabels.get(statusId) || `Status ${statusId}`,
        statusChangedAt,
        dueDate: recordDate(ticket, ["dueDateTime", "dueDate"]),
        exclusionReason: coverage.exclusionReason,
        exclusionDetail: coverage.exclusionDetail,
      };
    });

    if (usedStatusDateFallback) {
      warnings.push(
        "Some ticket age bands use the latest available activity timestamp because Autotask did not return an exact status-change timestamp.",
      );
    }
    const snapshot = buildPlanningDemandSnapshot({
      ids,
      scopeDate: londonCalendarDate(),
      generatedAt: new Date().toISOString(),
      candidates,
      warnings,
    });
    return snapshot;
  } catch (error) {
    signal.throwIfAborted();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Ready to Book requests could not be loaded from Autotask. ${detail}`,
      { cause: error },
    );
  }
}
