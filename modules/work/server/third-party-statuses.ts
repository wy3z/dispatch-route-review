import type { PoolClient } from "pg";
import { query, withTransaction } from "../../../platform/database";

export type ThirdPartyVisitStatus = {
  id: number;
  label: string;
  selected: boolean;
  available: boolean;
};

type StatusRow = {
  status_id: string;
  label: string;
  selected: boolean;
  available: boolean;
};

function fromRow(row: StatusRow): ThirdPartyVisitStatus {
  const id = Number(row.status_id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Invalid stored Autotask ticket status ID: ${row.status_id}.`);
  }
  return { id, label: row.label, selected: row.selected, available: row.available };
}

export async function listThirdPartyVisitStatuses() {
  const result = await query<StatusRow>(
    `SELECT status_id::text, label, selected, available
       FROM third_party_visit_statuses
      ORDER BY available DESC, sort_order, status_id`,
  );
  return result.rows.map(fromRow);
}

export async function selectedThirdPartyVisitStatusIds() {
  const result = await query<{ status_id: string; }>(
    `SELECT status_id::text
       FROM third_party_visit_statuses
      WHERE selected = true`,
  );
  return new Set(result.rows.map((row) => Number(row.status_id)));
}

/** Worker-only metadata sync. Keep missing values; mark them unavailable. */
export async function syncThirdPartyVisitStatusCatalog(
  statuses: Map<number, string>,
) {
  const entries = [...statuses]
    .filter(([id, label]) => Number.isSafeInteger(id) && id > 0 && label.trim())
    .map(([id, label], sortOrder) => ({
      id,
      label: label.trim().replace(/\s+/g, " ").slice(0, 256),
      sort_order: sortOrder,
    }));
  if (!entries.length) {
    throw new Error("Autotask ticket-status metadata returned no usable values.");
  }
  await withTransaction(async (client) => {
    await client.query("UPDATE third_party_visit_statuses SET available = false");
    await client.query(
      `INSERT INTO third_party_visit_statuses
         (status_id, label, selected, available, sort_order)
       SELECT value.id, value.label, false, true, value.sort_order
         FROM jsonb_to_recordset($1::jsonb)
           AS value(id bigint, label text, sort_order integer)
       ON CONFLICT (status_id) DO UPDATE SET
         label = EXCLUDED.label,
         available = true,
         sort_order = EXCLUDED.sort_order,
         updated_at = now()`,
      [JSON.stringify(entries)],
    );
  });
}

export async function replaceSelectedThirdPartyVisitStatuses(
  client: PoolClient,
  selectedIds: number[],
) {
  await client.query(
    `UPDATE third_party_visit_statuses
        SET selected = status_id = ANY($1::bigint[]), updated_at = now()`,
    [selectedIds],
  );
}

export async function updateThirdPartyVisitStatuses(client: PoolClient, selectedIds: number[]) {
  const known = await client.query<{ status_id: string; }>(
    `SELECT status_id::text FROM third_party_visit_statuses
            WHERE status_id = ANY($1::bigint[])`,
    [selectedIds],
  );
  if (known.rowCount !== selectedIds.length) return null;
  const beforeResult = await client.query<{
    status_id: string;
    selected: boolean;
  }>(
    `SELECT status_id::text, selected
             FROM third_party_visit_statuses
            ORDER BY status_id
            FOR UPDATE`,
  );
  await replaceSelectedThirdPartyVisitStatuses(client, selectedIds);
  const result = await client.query<{
    status_id: string;
    label: string;
    selected: boolean;
    available: boolean;
  }>(
    `SELECT status_id::text, label, selected, available
             FROM third_party_visit_statuses
            ORDER BY available DESC, sort_order, status_id`,
  );
  const after = result.rows.map((row) => ({
    id: Number(row.status_id),
    label: row.label,
    selected: row.selected,
    available: row.available,
  }));
  return { beforeSelectedIds: beforeResult.rows.filter((status) => status.selected).map((status) => Number(status.status_id)), statuses: after };
}
