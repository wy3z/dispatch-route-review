import {
  authErrorResponse,
  authenticateAndRequirePagePermission,
  auditApiRequest,
} from "@/modules/access/server";
import {
  getCacheSnapshot,
  autotaskWebUrl,
  cacheSnapshotResponse,
  readCacheRefreshMetadata,
} from "@/modules/work/server";
import type { PlanningDemandSnapshot } from "@/modules/work/contracts";
import { londonCalendarDate } from "../../../shared/calendar";
import { describeCacheFreshness, projectPlanningDemandSnapshot } from "@/modules/work/domain";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;

async function methodNotAllowed(request: Request) {
  try {
    await authenticateAndRequirePagePermission(request, "dispatch_review");
  } catch (error) {
    return authErrorResponse(error);
  }
  return Response.json(
    { message: "Method not allowed. Planning-demand data is read-only." },
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
    const scopeDate = londonCalendarDate();
    const [snapshot, refresh] = await Promise.all([
      getCacheSnapshot<PlanningDemandSnapshot>("planning_demand", scopeDate),
      readCacheRefreshMetadata("planning_demand", scopeDate),
    ]);
    const freshness = describeCacheFreshness(
      "planning_demand",
      scopeDate,
      snapshot,
      refresh,
    );

    const webUrl = autotaskWebUrl();
    return cacheSnapshotResponse({
      request,
      freshness,
      payload: snapshot
        ? projectPlanningDemandSnapshot(snapshot.payload, webUrl)
        : null,
      label: "planning-demand",
      validatorVariant: webUrl ?? "links-disabled",
    });
  } catch (error) {
    try {
      return authErrorResponse(error);
    } catch {
      return Response.json(
        { message: "Planning-demand data is temporarily unavailable." },
        { status: 500, headers: PRIVATE_HEADERS },
      );
    }
  }
  });
}
