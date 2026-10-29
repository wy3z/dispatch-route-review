import {
  resolveRouteGeometry,
  isRoute,
  ROUTE_BATCH_MAX_WAYPOINTS,
  osrmRouting,
} from "@/modules/routing/server";
import {
  authErrorResponse,
  auditApiRequest,
  authenticateAndRequirePagePermission,
} from "@/modules/access/server";

export async function POST(request: Request) {
  return auditApiRequest(request, async () => {
    let user: Awaited<
      ReturnType<typeof authenticateAndRequirePagePermission>
    >;
    try {
      user = await authenticateAndRequirePagePermission(request, "dispatch_review");
    } catch (error) {
      return authErrorResponse(error);
    }

    const rateLimit = osrmRouting.takeCallerRequest(user.id);
    if (!rateLimit.allowed) {
      return Response.json(
        { message: "Too many road-routing requests. Try again shortly." },
        {
          status: 429,
          headers: {
            "Cache-Control": "private, no-store",
            "Retry-After": String(rateLimit.retryAfterSeconds),
          },
        },
      );
    }

    const routingContext = osrmRouting.beginRequest();
    let body: { routes?: unknown };
    try {
      body = (await request.json()) as { routes?: unknown };
    } catch {
      return Response.json(
        { message: "A JSON request body is required." },
        { status: 400, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const rawRoutes = Array.isArray(body?.routes) ? body.routes : [];
    if (
      !rawRoutes.length ||
      rawRoutes.length > 40 ||
      !rawRoutes.every(isRoute) ||
      rawRoutes.reduce(
        (total, route) => total + route.coordinates.length,
        0,
      ) > ROUTE_BATCH_MAX_WAYPOINTS
    ) {
      return Response.json(
        {
          message:
            "Between 1 and 40 valid routes and at most 400 total waypoints are required.",
        },
        { status: 400, headers: { "Cache-Control": "private, no-store" } },
      );
    }

    const results = await resolveRouteGeometry(rawRoutes, routingContext);
    return Response.json(
      { provider: "OSRM", traffic: "static", routes: results },
      { headers: { "Cache-Control": "private, max-age=900" } },
    );
  });
}
