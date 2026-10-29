import type { AuditLogEvent } from "../audit-export";
import { query } from "../../../platform/database";

export type AuditFilters = { action: string | null; resource: string | null; entityType: string | null; entityId: string | null; dateFrom: string | null; dateTo: string | null; limit: number; };

export async function listAuditEvents(
  { action, resource, entityType, entityId, dateFrom, dateTo, limit }: AuditFilters,
) {
  const result = await query<{
    id: string;
    occurred_at: Date;
    actor_email: string;
    action: string;
    entity_type: string;
    entity_id: string | null;
    request_id: string;
    before_state: unknown;
    after_state: unknown;
    metadata: unknown;
  }>(
    `SELECT id::text, occurred_at, actor_email, action, entity_type,
              entity_id, request_id, before_state, after_state, metadata
         FROM audit_events
        WHERE ($1::text IS NULL OR action = $1)
          AND ($2::text IS NULL OR lower(actor_email) = lower($2))
          AND ($3::text IS NULL OR entity_type = $3)
          AND ($4::text IS NULL OR entity_id = $4)
          AND ($5::date IS NULL OR occurred_at >= ($5::date::timestamp AT TIME ZONE 'Europe/London'))
          AND ($6::date IS NULL OR occurred_at < (($6::date + 1)::timestamp AT TIME ZONE 'Europe/London'))
        ORDER BY occurred_at DESC
        LIMIT $7`,
    [action, resource, entityType, entityId, dateFrom, dateTo, limit],
  );
  const events: AuditLogEvent[] = result.rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    actorEmail: row.actor_email,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    requestId: row.request_id,
    beforeState: row.before_state,
    afterState: row.after_state,
    metadata: row.metadata,
  }));
  return events;
}

export async function listAuditFilters() {
  const [resources, actions] = await Promise.all([
    query<{ actor_email: string; }>(
      `SELECT DISTINCT actor_email
           FROM audit_events
          ORDER BY actor_email
          LIMIT 1000`,
    ),
    query<{ action: string; }>(
      `SELECT DISTINCT action
           FROM audit_events
          ORDER BY action
          LIMIT 1000`,
    ),
  ]);
  return { resources: resources.rows.map((row) => row.actor_email), actions: actions.rows.map((row) => row.action) };
}
