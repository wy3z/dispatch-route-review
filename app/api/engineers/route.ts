import {
  deactivateManagedEngineer,
  updateManagedEngineer,
  createManagedEngineer,
} from "../../../workflows/engineer-management";
import { EngineerResourceIdConflictError, listEngineerRoster } from "@/modules/engineers/server";
import {
  auditContext,
  authenticateRequest,
  authErrorResponse,
  AuthenticationError,
  requireSameOriginForMutation,
  auditApiRequest,
  authenticateAndRequirePagePermission,
  hasPagePermission,
} from "@/modules/access/server";
import { validateEngineerRosterPayload } from "@/modules/engineers/domain";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function jsonBody(request: Request) {
  try {
    const value: unknown = await request.json();
    return value;
  } catch {
    return null;
  }
}

async function authenticateRosterRead(request: Request) {
  const actor = await authenticateRequest(request);
  if (await hasPagePermission(actor.id, "engineer_management")) return actor;
  if (await hasPagePermission(actor.id, "dispatch_review")) return actor;
  throw new AuthenticationError(
    "You do not have permission to access the engineer roster.",
    403,
  );
}

function bodyId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id.trim() : "";
}

function validationResponse(result: Extract<
  ReturnType<typeof validateEngineerRosterPayload>,
  { ok: false }
>) {
  return Response.json(
    { message: result.message, errors: result.errors },
    { status: 400, headers: PRIVATE_HEADERS },
  );
}

function duplicateResourceResponse(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23505"
  ) {
    return Response.json(
      { message: "That Autotask resource ID is already assigned to an engineer." },
      { status: 409, headers: PRIVATE_HEADERS },
    );
  }
  return null;
}

export async function GET(request: Request) {
  return auditApiRequest(request, async () => {
    try {
      await authenticateRosterRead(request);
      const engineers = await listEngineerRoster({ includeInactive: true });
      return Response.json({ engineers }, { headers: PRIVATE_HEADERS });
    } catch (error) {
      return authErrorResponse(error);
    }
  });
}

export async function POST(request: Request) {
  return auditApiRequest(request, async () => {
    try {
      const actor = await authenticateAndRequirePagePermission(
        request,
        "engineer_management",
      );
      requireSameOriginForMutation(request);
      const validation = validateEngineerRosterPayload(await jsonBody(request));
      if (!validation.ok) return validationResponse(validation);

      const engineer = await createManagedEngineer(validation.engineer, actor, auditContext(request));
      return Response.json(
        { engineer },
        { status: 201, headers: PRIVATE_HEADERS },
      );
    } catch (error) {
      const duplicate = duplicateResourceResponse(error);
      if (duplicate) return duplicate;
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
      const body = await jsonBody(request);
      const id = bodyId(body);
      if (!UUID.test(id)) {
        return Response.json(
          { message: "A valid engineer ID is required." },
          { status: 400, headers: PRIVATE_HEADERS },
        );
      }
      const validation = validateEngineerRosterPayload(body);
      if (!validation.ok) return validationResponse(validation);

      const engineer = await updateManagedEngineer(id, validation.engineer, actor, auditContext(request));
      if (!engineer) {
        return Response.json(
          { message: "Engineer not found." },
          { status: 404, headers: PRIVATE_HEADERS },
        );
      }
      return Response.json({ engineer }, { headers: PRIVATE_HEADERS });
    } catch (error) {
      if (error instanceof EngineerResourceIdConflictError) {
        return Response.json(
          { message: error.message },
          { status: 409, headers: PRIVATE_HEADERS },
        );
      }
      const duplicate = duplicateResourceResponse(error);
      if (duplicate) return duplicate;
      return authErrorResponse(error);
    }
  });
}

export async function DELETE(request: Request) {
  return auditApiRequest(request, async () => {
    try {
      const actor = await authenticateAndRequirePagePermission(
        request,
        "engineer_management",
      );
      requireSameOriginForMutation(request);
      const id = bodyId(await jsonBody(request));
      if (!UUID.test(id)) {
        return Response.json(
          { message: "A valid engineer ID is required." },
          { status: 400, headers: PRIVATE_HEADERS },
        );
      }

      const engineer = await deactivateManagedEngineer(id, actor, auditContext(request));
      if (!engineer) {
        return Response.json(
          { message: "Engineer not found." },
          { status: 404, headers: PRIVATE_HEADERS },
        );
      }
      return Response.json({ engineer }, { headers: PRIVATE_HEADERS });
    } catch (error) {
      return authErrorResponse(error);
    }
  });
}
