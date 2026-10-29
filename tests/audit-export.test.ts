import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { auditEventsToCsv, csvCell, validAuditDate } from "../modules/access/audit-export";
import type { AuditLogEvent } from "../modules/access/audit-export";

test("audit dates accept real ISO dates only", () => {
  assert.equal(validAuditDate(null), null);
  assert.equal(validAuditDate(""), null);
  assert.equal(validAuditDate("2026-08-07"), "2026-08-07");
  assert.equal(validAuditDate("2026-02-29"), undefined);
  assert.equal(validAuditDate("07/08/2026"), undefined);
});

test("CSV cells escape quotes and neutralise spreadsheet formulas", () => {
  assert.equal(csvCell('value, with "quotes"'), '"value, with ""quotes"""');
  assert.equal(csvCell("=HYPERLINK(\"bad\")"), '"\'=HYPERLINK(""bad"")"');
  assert.equal(csvCell("  +SUM(1,1)"), '"\'  +SUM(1,1)"');
});

test("audit CSV includes full state and metadata context", () => {
  const event: AuditLogEvent = {
    id: "1",
    occurredAt: "2026-08-07T09:30:00.000Z",
    actorEmail: "admin@example.test",
    action: "page.visibility.updated",
    entityType: "app_page",
    entityId: "draft",
    requestId: "request-1",
    beforeState: { visible: false },
    afterState: { visible: true },
    metadata: { pageLabel: "Scheduler" },
  };
  const csv = auditEventsToCsv([event]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /"Resource","Action"/);
  assert.match(csv, /admin@example\.test/);
  assert.match(csv, /page\.visibility\.updated/);
  assert.match(csv, /\{\"\"visible\"\":true\}/);
});

test("audit filter migration indexes resource, date and action lookup paths", () => {
  const migration = readFileSync(
    join(process.cwd(), "db/migrations/003_audit_filter_indexes.sql"),
    "utf8",
  );
  assert.match(migration, /occurred_at DESC/);
  assert.match(migration, /lower\(actor_email\), occurred_at DESC/);
  assert.match(migration, /action, occurred_at DESC/);
});
