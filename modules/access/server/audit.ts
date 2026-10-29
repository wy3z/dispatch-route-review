import type { AppUser } from "../contracts";
import type { PoolClient } from "pg";
import { isIP } from "node:net";

export type AuditContext = {
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
};

type AuditActor = Pick<AppUser, "externalSubject" | "email"> & {
  id: string | null;
};

export function auditContext(request: Request): AuditContext {
  const forwardedIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    requestId: request.headers.get("x-request-id")?.slice(0, 200) || crypto.randomUUID(),
    ipAddress: forwardedIp && isIP(forwardedIp) ? forwardedIp : null,
    userAgent: request.headers.get("user-agent"),
  };
}

export async function appendAuditEvent(
  client: PoolClient,
  user: AuditActor,
  context: AuditContext,
  event: {
    action: string;
    entityType: string;
    entityId?: string | null;
    beforeState?: unknown;
    afterState?: unknown;
    metadata?: Record<string, unknown>;
  },
) {
  await client.query(
    `INSERT INTO audit_events
       (actor_user_id, actor_subject, actor_email, action, entity_type,
        entity_id, request_id, ip_address, user_agent, before_state,
        after_state, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::inet, $9, $10::jsonb, $11::jsonb, $12::jsonb)`,
    [
      user.id,
      user.externalSubject,
      user.email,
      event.action,
      event.entityType,
      event.entityId ?? null,
      context.requestId,
      context.ipAddress,
      context.userAgent,
      event.beforeState === undefined ? null : JSON.stringify(event.beforeState),
      event.afterState === undefined ? null : JSON.stringify(event.afterState),
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}
