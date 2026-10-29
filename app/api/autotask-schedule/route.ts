import type { ScheduleSnapshot } from "@/modules/work/contracts";
import {
  getCachedScheduleMonth,
  getCacheSnapshot,
  autotaskWebUrl,
  cacheSnapshotResponse,
  readCacheRefreshMetadata,
} from "@/modules/work/server";
import {
  authErrorResponse,
  authenticateAndRequirePagePermission,
  auditApiRequest,
} from "@/modules/access/server";
import {
  projectScheduleSnapshot,
  describeCacheFreshness,
  IDLE_CACHE_REFRESH,
} from "@/modules/work/domain";
import { isIsoCalendarDate, londonCalendarDate } from "../../../shared/calendar";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET(request: Request) {
  return auditApiRequest(request, async () => {
   try {
    await authenticateAndRequirePagePermission(request, "dispatch_review");
    const searchParams = new URL(request.url).searchParams;
    const month = searchParams.get("month");

    if (month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return Response.json(
          { message: "A valid month is required." },
          { status: 400, headers: PRIVATE_HEADERS },
        );
      }
      const days = await getCachedScheduleMonth(month);
      const now = new Date();
      const usableDays = days.flatMap((day) => {
        const freshness = describeCacheFreshness(
          "schedule",
          day.date,
          {
            sourceRefreshedAt: day.sourceRefreshedAt,
            refreshedAt: day.refreshedAt,
            expiresAt: day.expiresAt,
            stale: Date.parse(day.expiresAt) <= now.getTime(),
            lastError: day.lastError,
            consecutiveFailures: day.consecutiveFailures,
          },
          IDLE_CACHE_REFRESH,
          now,
        );
        return freshness.usable
          ? [{
              date: day.date,
              calls: day.calls,
              complete: day.complete,
              scheduled: day.scheduled,
              cache: freshness,
            }]
          : [];
      });
      return Response.json(
        {
          source: "postgres-cache",
          month,
          generatedAt:
            usableDays
              .map((day) => day.cache.sourceRefreshedAt)
              .filter((value): value is string => value !== null)
              .sort()
              .at(-1) ?? null,
          days: usableDays,
          omittedOverAgeDays: days.length - usableDays.length,
        },
        { headers: { ...PRIVATE_HEADERS, "X-Dispatch-Cache": "database" } },
      );
    }

    const date = searchParams.get("date") ?? londonCalendarDate();
    if (!isIsoCalendarDate(date)) {
      return Response.json(
        { message: "A valid date is required." },
        { status: 400, headers: PRIVATE_HEADERS },
      );
    }

    const [snapshot, refresh] = await Promise.all([
      getCacheSnapshot<ScheduleSnapshot>("schedule", date),
      readCacheRefreshMetadata("schedule", date),
    ]);
    const freshness = describeCacheFreshness(
      "schedule",
      date,
      snapshot,
      refresh,
    );

    const webUrl = autotaskWebUrl();
    return cacheSnapshotResponse({
      request,
      freshness,
      payload: snapshot ? projectScheduleSnapshot(snapshot.payload, webUrl) : null,
      label: "schedule",
      validatorVariant: webUrl ?? "links-disabled",
    });
  } catch (error) {
    return authErrorResponse(error);
  }
  });
}
