import { authenticateRequest, authErrorResponse, auditApiRequest } from "@/modules/access/server";

export async function GET(request: Request) {
  return auditApiRequest(request, async () => {
    try {
      const user = await authenticateRequest(request);
      return Response.json({ user }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      return authErrorResponse(error);
    }
  });
}
