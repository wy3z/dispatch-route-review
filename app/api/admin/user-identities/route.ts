import { readJsonObject, UUID } from "@/shared/http";
import {
  AuthIdentityChangeError,
  auditApiRequest,
  auditContext,
  authenticateRequest,
  authErrorResponse,
  getUserIdentityState,
  isExactExternalSubject,
  requireRole,
  requireSameOriginForMutation,
  updateUserIdentity,
} from "@/modules/access/server";
import type { AuthIdentityOperation } from "@/modules/access/server";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;
const REASON_MAX_LENGTH = 1_000;

function errorResponse(error: unknown) {
  if (error instanceof AuthIdentityChangeError) {
    return Response.json(
      { message: error.message },
      { status: error.status, headers: PRIVATE_HEADERS },
    );
  }
  return authErrorResponse(error);
}

export async function GET(request: Request) {
  return auditApiRequest(request, async () => {
    try {
      const actor = await authenticateRequest(request);
      requireRole(actor, ["admin"]);
      const userId = new URL(request.url).searchParams.get("userId") ?? "";
      if (!UUID.test(userId)) {
        return Response.json(
          { message: "Invalid user identity query." },
          { status: 400, headers: PRIVATE_HEADERS },
        );
      }
      const identityState = await getUserIdentityState(userId);
      return identityState
        ? Response.json({ identityState }, { headers: PRIVATE_HEADERS })
        : Response.json(
            { message: "User not found." },
            { status: 404, headers: PRIVATE_HEADERS },
          );
    } catch (error) {
      return errorResponse(error);
    }
  });
}

export async function POST(request: Request) {
  return auditApiRequest(request, async () => {
    try {
      const actor = await authenticateRequest(request);
      requireRole(actor, ["admin"]);
      requireSameOriginForMutation(request);
      const contentType = request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        return Response.json(
          { message: "Content-Type must be application/json." },
          { status: 415, headers: PRIVATE_HEADERS },
        );
      }

      const body = await readJsonObject(request);
      const operation = body?.operation;
      const userId = typeof body?.userId === "string" ? body.userId : "";
      const expectedPrimaryIdentityId =
        typeof body?.expectedPrimaryIdentityId === "string"
          ? body.expectedPrimaryIdentityId
          : "";
      const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
      const replacementSubject =
        typeof body?.replacementSubject === "string"
          ? body.replacementSubject
          : undefined;
      const identityId =
        typeof body?.identityId === "string" ? body.identityId : undefined;
      const retainPrevious = body?.retainPrevious === true;

      if (
        !["stage", "replace", "retire"].includes(String(operation)) ||
        !UUID.test(userId) ||
        !UUID.test(expectedPrimaryIdentityId) ||
        reason.length < 1 ||
        reason.length > REASON_MAX_LENGTH ||
        ((operation === "stage" || operation === "replace") &&
          (!replacementSubject || !isExactExternalSubject(replacementSubject))) ||
        (operation === "retire" && (!identityId || !UUID.test(identityId))) ||
        (operation !== "replace" && body?.retainPrevious !== undefined) ||
        (operation === "replace" &&
          body?.retainPrevious !== undefined &&
          typeof body.retainPrevious !== "boolean")
      ) {
        return Response.json(
          { message: "Invalid identity change." },
          { status: 400, headers: PRIVATE_HEADERS },
        );
      }

      const identityState = await updateUserIdentity(
        {
          operation: operation as AuthIdentityOperation,
          userId,
          expectedPrimaryIdentityId,
          replacementSubject,
          identityId,
          retainPrevious,
          reason,
        },
        actor,
        auditContext(request),
      );
      return Response.json({ identityState }, { headers: PRIVATE_HEADERS });
    } catch (error) {
      return errorResponse(error);
    }
  });
}
