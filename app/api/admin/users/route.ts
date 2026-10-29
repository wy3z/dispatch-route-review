import { readJsonObject, UUID } from "../../../../shared/http";
import {
  updateUserAccess,
  listUsers,
  auditContext,
  authenticateRequest,
  authErrorResponse,
  requireSameOriginForMutation,
  requireRole,
  auditApiRequest,
} from "@/modules/access/server";
import type { UserRole } from "@/modules/access/contracts";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;
export async function GET(request: Request) {
  return auditApiRequest(request, async () => {
   try {
    const user = await authenticateRequest(request);
    requireRole(user, ["admin"]);
    return Response.json(
      { users: await listUsers() },
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
    if (!body) {
      return Response.json({ message: "Invalid user update." }, { status: 400, headers: PRIVATE_HEADERS });
    }
    const userId = typeof body.userId === "string" ? body.userId : "";
    const role = ["viewer", "scheduler", "admin"].includes(String(body.role))
      ? (body.role as UserRole)
      : null;
    const active = typeof body.active === "boolean" ? body.active : null;
    if (!UUID.test(userId) || (!role && active === null)) {
      return Response.json({ message: "Invalid user update." }, { status: 400, headers: PRIVATE_HEADERS });
    }

    const updated = await updateUserAccess(userId, role, active, actor, auditContext(request));
    return updated
      ? Response.json({ user: updated }, { headers: PRIVATE_HEADERS })
      : Response.json({ message: "User not found." }, { status: 404, headers: PRIVATE_HEADERS });
  } catch (error) {
    return authErrorResponse(error);
  }
  });
}
