import { isIsoCalendarDate } from "../../shared/calendar";

export type AuditLogEvent = {
  id: string;
  occurredAt: string;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string | null;
  requestId: string;
  beforeState: unknown;
  afterState: unknown;
  metadata: unknown;
};

export function validAuditDate(value: string | null) {
  if (value === null || value === "") return null;
  return isIsoCalendarDate(value) ? value : undefined;
}

function csvText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function csvCell(value: unknown) {
  const text = csvText(value);
  // Stop Excel treating untrusted audit text as a formula.
  const safe = /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function auditEventsToCsv(events: AuditLogEvent[]) {
  const rows: unknown[][] = [
    [
      "Time",
      "Event ID",
      "Resource",
      "Action",
      "Entity type",
      "Entity ID",
      "Request ID",
      "Before state",
      "After state",
      "Metadata",
    ],
    ...events.map((event) => [
      event.occurredAt,
      event.id,
      event.actorEmail,
      event.action,
      event.entityType,
      event.entityId,
      event.requestId,
      event.beforeState,
      event.afterState,
      event.metadata,
    ]),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
