import { readCacheSystemHealth } from "@/modules/work/server";
import { database } from "../platform/database";

async function main() {
  try {
    const health = await readCacheSystemHealth();
    console.log(
      JSON.stringify({
        status: health.status,
        worker: health.worker.status,
        caches: health.caches.map((cache) => ({
          key: `${cache.kind}:${cache.scopeDate}`,
          status: cache.status,
          ageSeconds: cache.ageSeconds,
          consecutiveFailures: cache.consecutiveFailures,
          refreshState: cache.refresh.state,
        })),
        queue: health.queue,
        issues: health.issues.map((issue) => issue.code),
      }),
    );
    if (!health.ready || !health.worker.healthy) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "not_ready",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    try {
      await database().end();
    } catch {
      // A failed connection already marks the probe unhealthy.
    }
  }
}

void main();
