import { readAutotaskUsage } from "@/modules/work/server";
import {
  authenticateRequest,
  authErrorResponse,
  requireRole,
  auditApiRequest,
} from "@/modules/access/server";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET(request: Request) {
  return auditApiRequest(request, async () => {
   try {
    const user = await authenticateRequest(request);
    requireRole(user, ["admin"]);
    return Response.json(await readAutotaskUsage(), { headers: PRIVATE_HEADERS });
  } catch (error) {
    return authErrorResponse(error);
  }
  });
}
