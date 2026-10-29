import {
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
  isReadyToBookDateEligible,
  projectReadyToBook,
  readyToBookConfiguration,
  describeCacheFreshness,
} from "@/modules/work/domain";
import type { PlanningDemandSnapshot } from "@/modules/work/contracts";
import { londonCalendarDate } from "../../../shared/calendar";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;

async function methodNotAllowed(request: Request) {
  try {
    await authenticateAndRequirePagePermission(request, "dispatch_review");
  } catch (error) {
    return authErrorResponse(error);
  }
  return Response.json(
    { message: "Method not allowed. Ready-to-book data is read-only." },
    { status: 405, headers: { ...PRIVATE_HEADERS, Allow: "GET" } },
  );
}

export async function POST(request: Request) { return auditApiRequest(request, () => methodNotAllowed(request)); }
export async function PUT(request: Request) { return auditApiRequest(request, () => methodNotAllowed(request)); }
export async function PATCH(request: Request) { return auditApiRequest(request, () => methodNotAllowed(request)); }
export async function DELETE(request: Request) { return auditApiRequest(request, () => methodNotAllowed(request)); }

export async function GET(request: Request) {
  return auditApiRequest(request, async () => {
   try {
    await authenticateAndRequirePagePermission(request, "dispatch_review");
    let scope;
    try {
      scope = readyToBookConfiguration();
    } catch (error) { // Invalid non-secret configuration needs an explicit, audited API failure.
      return Response.json(
        { message: error instanceof Error ? error.message : String(error) },
        { status: 500, headers: PRIVATE_HEADERS },
      );
    }
    const searchParams = new URL(request.url).searchParams;
    const planningDate = searchParams.get("date") ?? londonCalendarDate();
    if (!isReadyToBookDateEligible(planningDate)) {
      return Response.json(
        {
          message:
            "Ready-to-book requests are available only for a real London weekday from today onward.",
        },
        { status: 400, headers: PRIVATE_HEADERS },
      );
    }

    const demandDate = londonCalendarDate();
    const [snapshot, refresh] = await Promise.all([
      getCacheSnapshot<PlanningDemandSnapshot>(
        "planning_demand",
        demandDate,
      ),
      readCacheRefreshMetadata("planning_demand", demandDate),
    ]);
    const freshness = describeCacheFreshness(
      "planning_demand",
      demandDate,
      snapshot,
      refresh,
    );

    const webUrl = autotaskWebUrl();
    return cacheSnapshotResponse({
      request,
      freshness,
      payload: snapshot
        ? projectReadyToBook(snapshot.payload, planningDate, scope, webUrl)
        : null,
      label: "ready-to-book",
      validatorVariant: `${planningDate}:${webUrl ?? "links-disabled"}`,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
  });
}
