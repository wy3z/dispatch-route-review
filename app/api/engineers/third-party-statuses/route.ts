import { updateManagedThirdPartyStatuses } from "../../../../workflows/engineer-management";
import {
  auditContext,
  authErrorResponse,
  requireSameOriginForMutation,
  auditApiRequest,
  authenticateAndRequirePagePermission,
} from "@/modules/access/server";
import { listThirdPartyVisitStatuses } from "@/modules/work/server";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;

function selectedIdsFrom(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const selectedIds = (value as Record<string, unknown>).selectedIds;
  if (!Array.isArray(selectedIds)) return null;
  if (selectedIds.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) {
    return null;
  }
  return [...new Set(selectedIds)];
}

export async function GET(request: Request) {
  return auditApiRequest(request, async () => {
    try {
      await authenticateAndRequirePagePermission(request, "engineer_management");
      const statuses = await listThirdPartyVisitStatuses();
      return Response.json({ statuses }, { headers: PRIVATE_HEADERS });
    } catch (error) {
      return authErrorResponse(error);
    }
  });
}

export async function PATCH(request: Request) {
  return auditApiRequest(request, async () => {
    try {
      const actor = await authenticateAndRequirePagePermission(
        request,
        "engineer_management",
      );
      requireSameOriginForMutation(request);
      const selectedIds = selectedIdsFrom(await request.json().catch(() => null));
      if (!selectedIds) {
        return Response.json(
          { message: "Selected statuses must be valid numeric Autotask IDs." },
          { status: 400, headers: PRIVATE_HEADERS },
        );
      }

      const statuses = await updateManagedThirdPartyStatuses(selectedIds, actor, auditContext(request));
      if (!statuses) {
        return Response.json(
          { message: "One or more selected statuses are not in the Autotask catalog." },
          { status: 400, headers: PRIVATE_HEADERS },
        );
      }
      return Response.json({ statuses }, { headers: PRIVATE_HEADERS });
    } catch (error) {
      return authErrorResponse(error);
    }
  });
}
