import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditContext, authenticateRequest, updateUserPagePermission } from "../modules/access/server";
import { resolveAuthMode } from "../modules/access/domain";
import { insertEngineer, listEngineerRoster, updateEngineer } from "../modules/engineers/server";
import type { ScheduleSnapshot, ScheduledVisit } from "../modules/work/contracts";
import { buildPlanningDemandSnapshot, operationalIdsConfiguration } from "../modules/work/domain";
import {
  cacheKey,
  claimCacheRefreshJobs,
  releaseCacheRefreshJob,
  requestCacheRefresh,
  readCacheRefreshMetadata,
  storeCacheSnapshot,
} from "../modules/work/server";
import type { CacheRefreshJob } from "../modules/work/server";
import { withTransaction } from "../platform/database";
import { addIsoCalendarDays, londonCalendarDate, londonLocalMidnightUtc } from "../shared/calendar";
import { demoDemand, demoEngineers, demoSites, demoVisits } from "./demo-data";

export async function seedDemo(now = new Date()) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Demo seed refuses to run when NODE_ENV=production.");
  }
  if (resolveAuthMode() !== "development") {
    throw new Error("Demo seed requires development authentication and a disposable local database.");
  }
  if (process.env.DEMO_SEED !== "1") {
    throw new Error("Demo seed requires explicit opt-in DEMO_SEED=1.");
  }
  const ids = operationalIdsConfiguration();
  if (!ids.planningDemandStatusIds.includes(ids.readyToBook.statusId) || ids.surveyQueueIds.has(ids.readyToBook.queueId)) {
    throw new Error("Demo ready-to-book IDs must also classify as planning demand (requested/access/third-party status, non-survey queue).");
  }
  const today = londonCalendarDate(now);
  const generatedAt = now.toISOString();
  const queues = {
    support: [...ids.supportQueueIds][0], install: [...ids.installQueueIds][0],
    survey: [...ids.surveyQueueIds][0], ready: ids.readyToBook.queueId,
  };
  const statuses = {
    requested: [...ids.requestedStatusIds][0], access: [...ids.accessStatusIds][0],
    thirdParty: [...ids.thirdPartyRequestStatusIds][0], ready: ids.readyToBook.statusId,
  };
  // All fixture times are daytime, after London's overnight clock changes.
  const at = (date: string, minutes: number) => new Date(londonLocalMidnightUtc(addIsoCalendarDays(date, 1)) - (1440 - minutes) * 60_000).toISOString();
  const request = new Request("http://localhost:3100");
  const actor = await authenticateRequest(request);
  // A clean demo viewer needs a stored grant to pass normal page authorization.
  if (!await updateUserPagePermission(actor.id, "dispatch_review", true, actor, auditContext(request))) {
    throw new Error("Demo seed could not grant the local viewer Dispatch Review access.");
  }
  const roster = await listEngineerRoster({ includeInactive: true });
  await withTransaction(async (client) => {
    for (const engineer of demoEngineers) {
      const payload = {
        ...engineer, region: "North" as const, active: true, aliases: [],
        workingDays: [1, 2, 3, 4, 5], workdayStart: "08:00", workdayEnd: "18:00",
      };
      const existing = roster.find((entry) => entry.resourceId === engineer.resourceId);
      if (existing) {
        if (!await updateEngineer(client, existing.id, payload, actor.id)) {
          throw new Error(`Demo roster update failed for ${engineer.resourceId}.`);
        }
      } else {
        await insertEngineer(client, payload, actor.id);
      }
    }
  });

  const snapshots = new Map<string, { kind: "schedule" | "planning_demand"; date: string; payload: unknown }>();
  for (let offset = -7; offset <= 7; offset += 1) {
    const date = addIsoCalendarDays(today, offset);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const visits: ScheduledVisit[] = date !== today && (weekday === 0 || weekday === 6) ? [] : demoVisits.map((visit, index) => {
      const engineer = demoEngineers[visit.engineer];
      const site = demoSites[visit.site];
      const serviceCallId = 990000000 + Number(date.replaceAll("-", "")) * 100 + index;
      return {
        id: `${serviceCallId}-${engineer.resourceId}`, serviceCallId, ticketId: serviceCallId + 50,
        ticketNumber: `DEMO-${date}-${index + 1}`, title: `Demo ${visit.queue} visit ${index + 1}`,
        autotaskUrl: null, companyName: `Demo Company ${visit.site + 1}`, locationName: site.name,
        address: "Fictional demo site", city: site.city, postcode: "",
        resourceId: engineer.resourceId, resourceName: engineer.name, routeOwnerKey: String(engineer.resourceId),
        ownerType: "internal", thirdPartyCompany: null, ignoredResourceCount: 0,
        ticketStatusId: statuses.requested, ticketStatusLabel: "Demo booked status",
        queueId: queues[visit.queue], queueLabel: `Demo ${visit.queue}`, jobType: visit.queue,
        startDateTime: at(date, visit.start), endDateTime: at(date, visit.end), durationMinutes: visit.end - visit.start,
        status: 1, isComplete: offset < 0, latitude: site.latitude, longitude: site.longitude, additionalTicketCount: 0,
      };
    });
    visits.sort((a, b) => a.startDateTime.localeCompare(b.startDateTime) || a.resourceName.localeCompare(b.resourceName));
    const payload: ScheduleSnapshot = { source: "autotask", date, generatedAt, visits, warnings: [] };
    snapshots.set(cacheKey("schedule", date), { kind: "schedule", date, payload });
  }
  const demand = buildPlanningDemandSnapshot({
    ids, scopeDate: today, generatedAt,
    candidates: demoDemand.map((item, index) => {
      const site = demoSites[item.site];
      return {
        ticketId: 999000001 + index, ticketNumber: `DEMO-DEMAND-${index + 1}`, title: `Demo unassigned work ${index + 1}`,
        companyLabel: `Demo Company ${item.site + 1}`, siteLabel: site.name, city: site.city, postcode: "",
        latitude: site.latitude, longitude: site.longitude, durationMinutes: 60, durationSource: "estimated",
        routeRegion: "North", logisticsTerritory: "North West", countryCode: "GB",
        queueId: queues[item.queue], queueLabel: `Demo ${item.queue}`, statusId: statuses[item.status], statusLabel: `Demo ${item.status}`,
        statusChangedAt: at(addIsoCalendarDays(today, -item.daysOld), 480), dueDate: at(addIsoCalendarDays(today, item.dueInDays), 1020),
        exclusionReason: null, exclusionDetail: null,
        autotaskUrl: null,
      };
    }),
  });
  snapshots.set(cacheKey("planning_demand", today), { kind: "planning_demand", date: today, payload: demand });
  for (const snapshot of snapshots.values()) {
    await requestCacheRefresh(snapshot.kind, snapshot.date);
  }

  // Use leases to keep the single fenced snapshot writer.
  const pending = new Set(snapshots.keys());
  const claimed = new Map<string, CacheRefreshJob>();
  let failure: unknown;
  let failed = false;
  try {
    while (pending.size) {
      const jobs = await claimCacheRefreshJobs(snapshots.size);
      if (!jobs.length) {
        const reasons = await Promise.all([...pending].map(async (key) => {
          const snapshot = snapshots.get(key)!;
          const metadata = await readCacheRefreshMetadata(snapshot.kind, snapshot.date);
          const reason = metadata.state === "leased" ? "held by a lease"
            : metadata.state === "retry_wait" ? `in retry backoff until ${metadata.availableAt}`
              : `queue state ${metadata.state}; retry after checking for concurrent refreshes`;
          return `${key}: ${reason}`;
        }));
        throw new Error(`Demo seed could not claim its remaining keys: ${reasons.join("; ")}.`);
      }
      for (const job of jobs) claimed.set(job.cacheKey, job);
      for (const job of jobs) {
        const snapshot = snapshots.get(job.cacheKey);
        if (!snapshot) continue;
        const result = await storeCacheSnapshot(job, snapshot.payload, generatedAt);
        if (!result.stored) throw new Error(`Demo seed failed storing ${job.cacheKey}: ${result.reason}.`);
        claimed.delete(job.cacheKey);
        if (result.refreshPending) throw new Error(`Demo seed was superseded while storing ${job.cacheKey}. Stop the worker and retry.`);
        pending.delete(job.cacheKey);
      }
    }
  } catch (error) { // Preserve the seed failure if releasing claims also fails.
    failed = true;
    failure = error;
  } finally {
    // Hold unrelated claims until done so the next batch cannot reclaim them.
    const releases = await Promise.allSettled([...claimed.values()].map(async (job) => {
      const result = await releaseCacheRefreshJob(job);
      if (!result.released || result.refreshPending) {
        throw new Error(`Demo seed failed releasing ${job.cacheKey}: ${result.released ? "refresh_pending" : result.reason}.`);
      }
    }));
    const errors = releases.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) {
      throw new AggregateError(failed ? [failure, ...errors] : errors,
        `${failed ? `Demo seed failed: ${failure instanceof Error ? failure.message : String(failure)}; ` : ""}claim cleanup failed.`);
    }
  }
  if (failed) throw failure;
  return { today, engineers: demoEngineers.length, scheduleDays: snapshots.size - 1, visitsPerPopulatedDay: demoVisits.length, demandItems: demand.items.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await seedDemo()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await globalThis.__dispatchDatabasePool?.end();
    globalThis.__dispatchDatabasePool = undefined;
  }
}
