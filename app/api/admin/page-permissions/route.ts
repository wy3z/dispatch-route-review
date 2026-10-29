import { readJsonObject, UUID } from "../../../../shared/http";
import {
  updateUserPagePermission,
  auditContext,
  authenticateRequest,
  authErrorResponse,
  requireRole,
  requireSameOriginForMutation,
  auditApiRequest,
  listPagePermissions,
} from "@/modules/access/server";
import { isPagePermissionKey } from "@/modules/access/domain";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;
export async function GET(request: Request) {
  return auditApiRequest(request, async () => {
    try {
      const actor = await authenticateRequest(request);
      const requestedUserId = new URL(request.url).searchParams
        .get("userId")
        ?.trim();
      let userId = actor.id;
      if (requestedUserId !== undefined) {
        requireRole(actor, ["admin"]);
        if (!UUID.test(requestedUserId)) {
          return Response.json(
            { message: "Invalid user." },
            { status: 400, headers: PRIVATE_HEADERS },
          );
        }
        userId = requestedUserId;
      }
      return Response.json(
        { permissions: await listPagePermissions(userId) },
        { headers: PRIVATE_HEADERS },
      );
    } catch (error) {
      return authErrorResponse(error);
    }
  });
}

export async function PATCH(request: Request) {
  return auditApiRequest(request, async () => {
    try {
      const actor = await authenticateRequest(request);
      requireRole(actor, ["admin"]);
      requireSameOriginForMutation(request);
      const body = await readJsonObject(request);
      const userId = typeof body?.userId === "string" ? body.userId : "";
      if (
        !body ||
        !UUID.test(userId) ||
        !isPagePermissionKey(body.permissionKey) ||
        typeof body.granted !== "boolean"
      ) {
        return Response.json(
          { message: "Invalid page permission update." },
          { status: 400, headers: PRIVATE_HEADERS },
        );
      }
      const permissionKey = body.permissionKey;
      const granted = body.granted;
      const permissions = await updateUserPagePermission(userId, permissionKey, granted, actor, auditContext(request));
      if (!permissions) {
        return Response.json(
          { message: "User not found." },
          { status: 404, headers: PRIVATE_HEADERS },
        );
      }
      return Response.json({ permissions }, { headers: PRIVATE_HEADERS });
    } catch (error) {
      return authErrorResponse(error);
    }
  });
}
