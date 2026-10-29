import { waitForAbort } from "./request-lifecycle";
import {
  CACHE_WARM_WINDOW_DAYS,
  cacheRefreshLeaseSeconds,
  claimCacheRefreshJobs,
  enqueueDueSnapshots,
  failCacheRefresh,
  releaseCacheRefreshJob,
  renewCacheRefreshLease,
  requestCacheWarmup,
  storeCacheSnapshot,
} from "../server/snapshots";
import type { CacheRefreshJob } from "../server/snapshots";
import { deadLetterScheduleReviewRefresh, pruneScheduleReviewRefreshes } from "../server/refresh";
import { loadAutotaskSchedule } from "./schedule-source";
import { loadPlanningDemand } from "./demand-source";
import { pruneAutotaskApiActivity } from "./api-activity";
import { operationalIdsConfiguration } from "../operational-ids";
import { geocoderConfiguration } from "./geocoder-config";
import { addIsoCalendarDays, londonCalendarDate } from "../../../shared/calendar";
import { workerCacheMetrics } from "./memory-cache";
import { isCacheRefreshLeaseLostError, loadWithCacheRefreshLease } from "./refresh-lease";

function claimIdentity(job: CacheRefreshJob) {
  return {
    cacheKey: job.cacheKey,
    leaseOwner: job.leaseOwner,
    claimGeneration: job.claimGeneration,
    requestGeneration: job.requestGeneration,
  };
}

/** Release cancellation claims; only provider failures incur retry backoff. */
export async function handleCacheRefreshFailure(
  job: CacheRefreshJob,
  error: unknown,
  shutdownSignal: AbortSignal,
  window: { from: string; to: string },
) {
  if (shutdownSignal.aborted) {
    const release = await releaseCacheRefreshJob(job);
    if (release.released) {
      console.log(
        JSON.stringify({
          event: "cache_refresh_cancelled",
          ...claimIdentity(job),
          refreshPending: release.refreshPending,
        }),
      );
    } else {
      console.warn(
        JSON.stringify({
          event: "cache_refresh_cancellation_discarded",
          ...claimIdentity(job),
          reason: release.reason,
        }),
      );
    }
    return;
  }

  if (isCacheRefreshLeaseLostError(error)) {
    try {
      const release = await releaseCacheRefreshJob(job);
      if (release.released) {
        console.warn(
          JSON.stringify({
            event: "cache_refresh_lease_cancelled",
            ...claimIdentity(job),
            leaseLossReason: error.reason,
            refreshPending: release.refreshPending,
          }),
        );
      } else {
        console.warn(
          JSON.stringify({
            event: "cache_refresh_lease_cancellation_discarded",
            ...claimIdentity(job),
            leaseLossReason: error.reason,
            reason: release.reason,
          }),
        );
      }
    } catch (releaseError) {
      console.error(
        JSON.stringify({
          event: "cache_refresh_lease_cancellation_failed",
          ...claimIdentity(job),
          leaseLossReason: error.reason,
          error:
            releaseError instanceof Error
              ? releaseError.message
              : String(releaseError),
        }),
      );
    }
    return;
  }

  const detail = {
    ...claimIdentity(job),
    error: error instanceof Error ? error.message : String(error),
  };
  const terminal = await deadLetterScheduleReviewRefresh(
    job,
    error,
    window.from,
    window.to,
  );
  if (terminal.handled) {
    if (terminal.deadLettered) {
      console.error(
        JSON.stringify({
          event: "cache_refresh_dead_lettered",
          ...detail,
          attempts: job.attempts,
        }),
      );
    } else {
      console.warn(
        JSON.stringify({
          event: "cache_refresh_failure_discarded",
          ...detail,
          reason: terminal.reason,
        }),
      );
    }
    return;
  }

  const failure = await failCacheRefresh(job, error);
  if (failure.recorded) {
    console.error(
      JSON.stringify({
        event: "cache_refresh_failed",
        ...detail,
        backoffSeconds: failure.backoffSeconds,
      }),
    );
  } else {
    console.warn(
      JSON.stringify({
        event: "cache_refresh_failure_discarded",
        ...detail,
        reason: failure.reason,
      }),
    );
  }
}

/** One guarded worker lifecycle, with its own cancellation and request caches. */
export async function runCacheWorker() {
  if (process.env.CACHE_WORKER !== "1") {
    throw new Error(
      "Refusing to start without CACHE_WORKER=1. Only this process may access live Autotask data.",
    );
  }

  const ids = operationalIdsConfiguration();
  const WORKER_CACHE_METRICS_INTERVAL_MS = 60 * 1000;
  const shutdown = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log(JSON.stringify({ event: "cache_worker_stopping", signal }));
      shutdown.abort();
    });
  }

  function wholeNumberSetting(
    name: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ) {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.floor(value)));
  }

  let warmedForDate: string | null = null;
  let lastWorkerCacheMetricsAt = 0;

  function logWorkerCacheMetrics() {
    const now = Date.now();
    if (now - lastWorkerCacheMetricsAt < WORKER_CACHE_METRICS_INTERVAL_MS) return;
    lastWorkerCacheMetricsAt = now;
    const memory = process.memoryUsage();
    console.log(
      JSON.stringify({
        event: "worker_cache_metrics",
        memory: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
        },
        caches: workerCacheMetrics(),
      }),
    );
  }

  function warmWindow(today: string) {
    const pastDays = wholeNumberSetting(
      "CACHE_WARM_PAST_DAYS",
      CACHE_WARM_WINDOW_DAYS.past,
      0,
      365,
    );
    const futureDays = wholeNumberSetting(
      "CACHE_WARM_FUTURE_DAYS",
      CACHE_WARM_WINDOW_DAYS.future,
      0,
      365,
    );
    return {
      from: addIsoCalendarDays(today, -pastDays),
      to: addIsoCalendarDays(today, futureDays),
    };
  }

  async function enqueueWarmWindow(today: string, from: string, to: string) {
    await requestCacheWarmup("planning_demand", today);
    for (let date = from; date <= to; date = addIsoCalendarDays(date, 1)) {
      await requestCacheWarmup("schedule", date);
    }
  }

  async function ensureWarmWindow() {
    const today = londonCalendarDate();
    const window = warmWindow(today);
    if (warmedForDate !== today) {
      await pruneAutotaskApiActivity();
      await enqueueWarmWindow(today, window.from, window.to);
      warmedForDate = today;
    }
    return window;
  }

  async function loadRefreshSnapshot(
    job: CacheRefreshJob,
    signal: AbortSignal,
  ) {
    switch (job.kind) {
      case "schedule":
        return loadAutotaskSchedule(job.scopeDate, signal, ids);
      case "planning_demand":
        return loadPlanningDemand(signal, ids);
      default: {
        const unsupportedKind: never = job.kind;
        throw new Error(
          `Unsupported cache refresh kind: ${String(unsupportedKind)}.`,
        );
      }
    }
  }

  async function completeRefresh(
    job: CacheRefreshJob,
    payload: unknown,
    generatedAt: string,
  ) {
    const completion = await storeCacheSnapshot(job, payload, generatedAt);
    if (!completion.stored) {
      console.warn(
        JSON.stringify({
          event: "cache_refresh_completion_discarded",
          ...claimIdentity(job),
          generatedAt,
          reason: completion.reason,
        }),
      );
      return;
    }
    console.log(
      JSON.stringify({
        event: "cache_refresh_succeeded",
        ...claimIdentity(job),
        generatedAt,
        refreshPending: completion.refreshPending,
      }),
    );
  }

  async function loadWithLeaseRenewal(job: CacheRefreshJob) {
    return loadWithCacheRefreshLease({
      leaseDurationMilliseconds: cacheRefreshLeaseSeconds() * 1_000,
      shutdownSignal: shutdown.signal,
      renewLease: () => renewCacheRefreshLease(job),
      load: (signal) => loadRefreshSnapshot(job, signal),
      onRenewed: () => {
        console.log(
          JSON.stringify({
            event: "cache_refresh_lease_renewed",
            ...claimIdentity(job),
          }),
        );
      },
      onRenewalError: (error) => {
        console.error(
          JSON.stringify({
            event: "cache_refresh_lease_renewal_failed",
            ...claimIdentity(job),
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      },
      onLeaseLost: (reason) => {
        console.warn(
          JSON.stringify({
            event: "cache_refresh_lease_lost",
            ...claimIdentity(job),
            reason,
          }),
        );
      },
    });
  }

  async function refreshWithLeaseRenewal(job: CacheRefreshJob) {
    const payload = await loadWithLeaseRenewal(job);
    shutdown.signal.throwIfAborted();
    await completeRefresh(job, payload, payload.generatedAt);
  }

  function waitForPoll(milliseconds: number) {
    return waitForAbort(milliseconds, shutdown.signal);
  }

  async function runBatch() {
    const window = await ensureWarmWindow();
    await pruneScheduleReviewRefreshes(window.from, window.to);
    await enqueueDueSnapshots(window.from, window.to);
    const jobs = await claimCacheRefreshJobs(
      wholeNumberSetting("CACHE_WORKER_BATCH_SIZE", 2, 1, 16),
    );
    const results = await Promise.allSettled(
      jobs.map(async (job) => {
        console.log(
          JSON.stringify({
            event: "cache_refresh_claimed",
            ...claimIdentity(job),
            attempts: job.attempts,
          }),
        );
        try {
          await refreshWithLeaseRenewal(job);
        } catch (error) {
          await handleCacheRefreshFailure(job, error, shutdown.signal, window);
        }
      }),
    );
    // Persistence or cancellation release can fail fatally. Drain every claimed
    // handler before propagating that error to the worker teardown path.
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    logWorkerCacheMetrics();
    return jobs.length;
  }

  async function main() {
    const geocoders = geocoderConfiguration();
    console.log(
      JSON.stringify({
        event: "geocoder_configuration_validated",
        ukHost: geocoders.ukHost,
        euHost: geocoders.euHost,
      }),
    );
    const once = process.env.CACHE_WORKER_ONCE === "1";
    const pollMilliseconds =
      wholeNumberSetting("CACHE_WORKER_POLL_SECONDS", 10, 1, 3_600) * 1_000;
    do {
      const processed = await runBatch();
      if (once || shutdown.signal.aborted) break;
      if (processed === 0) {
        await waitForPoll(pollMilliseconds);
      }
    } while (!shutdown.signal.aborted);
  }

  await main();
}
