import type { AutotaskUsagePayload } from "../usage";
import { query } from "../../../platform/database";

export type SummaryRow = {
  request_count: number;
  last_hour_request_count: number;
  success_count: number;
  failure_count: number;
  average_duration_ms: number;
  latest_request_at: Date | null;
};

export type BreakdownRow = {
  entity: string;
  operation: string;
  request_count: number;
  success_count: number;
  failure_count: number;
  average_duration_ms: number;
};

export type DailyRow = {
  day: string;
  request_count: number;
  success_count: number;
  failure_count: number;
};
export async function readAutotaskUsage(): Promise<AutotaskUsagePayload> {

  const [summary, breakdown, daily] = await Promise.all([
    query<SummaryRow>(
      `SELECT COUNT(*)::integer AS request_count,
                COUNT(*) FILTER (
                  WHERE occurred_at >= now() - interval '1 hour'
                )::integer AS last_hour_request_count,
                COUNT(*) FILTER (WHERE outcome = 'success')::integer AS success_count,
                COUNT(*) FILTER (WHERE outcome <> 'success')::integer AS failure_count,
                COALESCE(ROUND(AVG(duration_ms)), 0)::integer AS average_duration_ms,
                MAX(occurred_at) AS latest_request_at
           FROM autotask_api_activity
          WHERE occurred_at >= now() - interval '24 hours'`,
    ),
    query<BreakdownRow>(
      `SELECT entity, operation,
                COUNT(*)::integer AS request_count,
                COUNT(*) FILTER (WHERE outcome = 'success')::integer AS success_count,
                COUNT(*) FILTER (WHERE outcome <> 'success')::integer AS failure_count,
                COALESCE(ROUND(AVG(duration_ms)), 0)::integer AS average_duration_ms
           FROM autotask_api_activity
          WHERE occurred_at >= now() - interval '24 hours'
          GROUP BY entity, operation
          ORDER BY request_count DESC, entity, operation`,
    ),
    query<DailyRow>(
      `SELECT to_char(
                  date_trunc('day', occurred_at AT TIME ZONE 'Europe/London'),
                  'YYYY-MM-DD'
                ) AS day,
                COUNT(*)::integer AS request_count,
                COUNT(*) FILTER (WHERE outcome = 'success')::integer AS success_count,
                COUNT(*) FILTER (WHERE outcome <> 'success')::integer AS failure_count
           FROM autotask_api_activity
          WHERE occurred_at >= (
                  date_trunc('day', now() AT TIME ZONE 'Europe/London')
                  - interval '6 days'
                ) AT TIME ZONE 'Europe/London'
          GROUP BY day
          ORDER BY day`,
    ),
  ]);
  const totals = summary.rows[0];

  return {
    generatedAt: new Date().toISOString(),
    periodHours: 24,
    summary: {
      requestCount: totals.request_count,
      lastHourRequestCount: totals.last_hour_request_count,
      averageRequestsPerHour: Number((totals.request_count / 24).toFixed(1)),
      successCount: totals.success_count,
      failureCount: totals.failure_count,
      averageDurationMs: totals.average_duration_ms,
      latestRequestAt: totals.latest_request_at?.toISOString() ?? null,
    },
    breakdown: breakdown.rows.map((row) => ({
      entity: row.entity,
      operation: row.operation,
      requestCount: row.request_count,
      successCount: row.success_count,
      failureCount: row.failure_count,
      averageDurationMs: row.average_duration_ms,
    })),
    daily: daily.rows.map((row) => ({
      day: row.day,
      requestCount: row.request_count,
      successCount: row.success_count,
      failureCount: row.failure_count,
    })),
  };
}
