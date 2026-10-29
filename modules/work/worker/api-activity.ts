import { query } from "../../../platform/database";

export const AUTOTASK_API_ACTIVITY_RETENTION_DAYS = 8;

export type AutotaskApiOutcome =
  | "success"
  | "http_error"
  | "timeout"
  | "network_error";

export type AutotaskApiActivity = {
  entity: string;
  operation: "query" | "entity_information";
  method: "GET" | "POST";
  pageNumber: number;
  statusCode: number | null;
  outcome: AutotaskApiOutcome;
  durationMs: number;
};

type AutotaskRequestDescriptor = {
  entity: string;
  operation: AutotaskApiActivity["operation"];
  pageNumber?: number;
};

export function assertCacheWorker() {
  if (process.env.CACHE_WORKER !== "1") {
    throw new Error(
      "Live Autotask access is restricted to the cache worker (set CACHE_WORKER=1 there).",
    );
  }
}

function safeEntity(value: string) {
  const safe = value.trim().replace(/[^A-Za-z0-9_]/g, "").slice(0, 100);
  return safe || "Unknown";
}

export function autotaskApiOutcome(
  response: Pick<Response, "ok"> | null,
  error?: unknown,
): AutotaskApiOutcome {
  if (response) return response.ok ? "success" : "http_error";
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError"
    ? "timeout"
    : "network_error";
}

export function autotaskApiLogEntry(activity: AutotaskApiActivity) {
  return {
    event: "autotask_api_request_completed",
    entity: activity.entity,
    operation: activity.operation,
    method: activity.method,
    pageNumber: activity.pageNumber,
    statusCode: activity.statusCode,
    outcome: activity.outcome,
    durationMs: activity.durationMs,
  };
}

async function recordActivity(activity: AutotaskApiActivity) {
  console.log(JSON.stringify(autotaskApiLogEntry(activity)));
  try {
    await query(
      `INSERT INTO autotask_api_activity
         (entity, operation, method, page_number, status_code, outcome, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        activity.entity,
        activity.operation,
        activity.method,
        activity.pageNumber,
        activity.statusCode,
        activity.outcome,
        activity.durationMs,
      ],
    );
  } catch {
    // Telemetry must not fail a successful Autotask read. Docker logs are fallback.
    console.error(
      JSON.stringify({
        event: "autotask_api_activity_persist_failed",
        entity: activity.entity,
        operation: activity.operation,
      }),
    );
  }
}

export async function pruneAutotaskApiActivity() {
  try {
    const result = await query(
      `DELETE FROM autotask_api_activity
        WHERE occurred_at < now() - make_interval(days => $1::integer)`,
      [AUTOTASK_API_ACTIVITY_RETENTION_DAYS],
    );
    if (result.rowCount) {
      console.log(
        JSON.stringify({
          event: "autotask_api_activity_pruned",
          deletedCount: result.rowCount,
          retentionDays: AUTOTASK_API_ACTIVITY_RETENTION_DAYS,
        }),
      );
    }
  } catch {
    // Pruning is operational housekeeping and must not stop cache refreshes.
    console.error(JSON.stringify({ event: "autotask_api_activity_prune_failed" }));
  }
}

export async function trackedAutotaskFetch(
  input: string,
  init: RequestInit,
  descriptor: AutotaskRequestDescriptor,
) {
  assertCacheWorker();
  const startedAt = performance.now();
  const method = init.method === "POST" ? "POST" : "GET";
  const entity = safeEntity(descriptor.entity);
  const pageNumber = Math.max(1, Math.floor(descriptor.pageNumber ?? 1));
  try {
    const response = await fetch(input, { ...init, redirect: "error" });
    // Await so admin counts update immediately. Persist failures are swallowed.
    await recordActivity({
      entity,
      operation: descriptor.operation,
      method,
      pageNumber,
      statusCode: response.status,
      outcome: autotaskApiOutcome(response),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });
    return response;
  } catch (error) {
    await recordActivity({
      entity,
      operation: descriptor.operation,
      method,
      pageNumber,
      statusCode: null,
      outcome: autotaskApiOutcome(null, error),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });
    throw error;
  }
}
