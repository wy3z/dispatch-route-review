import { appendAuditEvent, auditContext } from "./audit";
import { authenticateRequest } from "./auth";
import { query, withTransaction } from "../../../platform/database";

type ApiOperation = () => Response | Promise<Response>;

async function recordApiFailure(
  request: Request,
  status: number,
  startedAt: number,
) {
  const url = new URL(request.url);
  const context = auditContext(request);
  const metadata = {
    method: request.method,
    path: url.pathname,
    status,
    durationMs: Math.max(0, Date.now() - startedAt),
  };

  try {
    const user = await authenticateRequest(request);
    await withTransaction((client) =>
      appendAuditEvent(client, user, context, {
        action: "api.request.failed",
        entityType: "api_route",
        entityId: url.pathname,
        metadata,
      }),
    );
  } catch {
    // Best-effort breadcrumb with no untrusted identity. Never block the response.
    try {
      await query(
        `INSERT INTO audit_events
           (actor_user_id, actor_subject, actor_email, action, entity_type,
            entity_id, request_id, ip_address, user_agent, metadata)
         VALUES (NULL, 'unidentified', 'unidentified', 'api.request.failed',
                 'api_route', $1, $2, $3::inet, $4, $5::jsonb)`,
        [
          url.pathname,
          context.requestId,
          context.ipAddress,
          context.userAgent,
          JSON.stringify(metadata),
        ],
      );
    } catch {
      // There is deliberately no recursive logging path.
    }
  }
}

/** Audit failed API responses. No query values, bodies, ticket content, or secrets. */
export async function auditApiRequest(
  request: Request,
  operation: ApiOperation,
) {
  const startedAt = Date.now();
  try {
    const response = await operation();
    if (response.status >= 400) {
      await recordApiFailure(request, response.status, startedAt);
    }
    return response;
  } catch (error) {
    await recordApiFailure(request, 500, startedAt);
    throw error;
  }
}
