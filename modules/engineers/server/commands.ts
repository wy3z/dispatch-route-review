import { engineerResourceIdMutationError } from "../validation";
import type { EngineerRosterPayload } from "../validation";
import { engineerRosterEntryFromDatabaseRow } from "./roster";
import type { EngineerRosterDatabaseRow } from "./roster";
import type { PoolClient } from "pg";
import { getResourceColourIndex } from "../colours";

export const ROSTER_RETURNING = `id, autotask_resource_id::text, name, base, region,
  latitude, longitude, colour_index, active, working_days, aliases,
  to_char(workday_start, 'HH24:MI') AS workday_start,
  to_char(workday_end, 'HH24:MI') AS workday_end`;

export class EngineerResourceIdConflictError extends Error { }

async function allocateEngineerColourIndex(
  client: PoolClient,
  resourceId: number,
) {
  // Lock so two creates cannot claim the same unused palette index.
  await client.query("SELECT pg_advisory_xact_lock($1)", [73_184_221]);
  const available = await client.query<{ colour_index: number; }>(
    `SELECT candidate::smallint AS colour_index
       FROM generate_series(0, 29) AS candidate
      WHERE NOT EXISTS (
        SELECT 1 FROM engineer_roster WHERE colour_index = candidate
      )
      ORDER BY candidate
      LIMIT 1`,
  );
  return available.rows[0]?.colour_index ??
    getResourceColourIndex({ resourceId });
}

export async function insertEngineer(
  client: PoolClient,
  engineer: EngineerRosterPayload,
  actorId: string,
) {
  const colourIndex = await allocateEngineerColourIndex(
    client,
    engineer.resourceId,
  );
  const result = await client.query<EngineerRosterDatabaseRow>(
    `INSERT INTO engineer_roster
       (autotask_resource_id, name, base, region, latitude, longitude,
        colour_index, active, working_days, workday_start, workday_end,
        aliases, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::smallint[], $10::time, $11::time,
             $12::text[], $13, $13)
     RETURNING ${ROSTER_RETURNING}`,
    [
      engineer.resourceId,
      engineer.name,
      engineer.base,
      engineer.region,
      engineer.latitude,
      engineer.longitude,
      colourIndex,
      engineer.active,
      engineer.workingDays,
      engineer.workdayStart,
      engineer.workdayEnd,
      engineer.aliases,
      actorId,
    ],
  );
  return engineerRosterEntryFromDatabaseRow(result.rows[0]);
}

export async function updateEngineer(
  client: PoolClient,
  id: string,
  next: EngineerRosterPayload,
  actorId: string,
) {
  const current = await client.query<EngineerRosterDatabaseRow>(
    `SELECT ${ROSTER_RETURNING}
             FROM engineer_roster
            WHERE id = $1
            FOR UPDATE`,
    [id],
  );
  if (!current.rows[0]) return null;
  const before = engineerRosterEntryFromDatabaseRow(current.rows[0]);
  const resourceIdError = engineerResourceIdMutationError(
    before.resourceId,
    next.resourceId,
  );
  if (resourceIdError) {
    throw new EngineerResourceIdConflictError(resourceIdError);
  }
  const updated = await client.query<EngineerRosterDatabaseRow>(
    `UPDATE engineer_roster
              SET name = $2,
                  base = $3,
                  region = $4,
                  latitude = $5,
                  longitude = $6,
                  active = $7,
                  working_days = $8::smallint[],
                  workday_start = $9::time,
                  workday_end = $10::time,
                  aliases = $11::text[],
                  updated_by = $12,
                  updated_at = now()
            WHERE id = $1
            RETURNING ${ROSTER_RETURNING}`,
    [
      id,
      next.name,
      next.base,
      next.region,
      next.latitude,
      next.longitude,
      next.active,
      next.workingDays,
      next.workdayStart,
      next.workdayEnd,
      next.aliases,
      actorId,
    ],
  );
  const after = engineerRosterEntryFromDatabaseRow(updated.rows[0]);
  return { before, after };
}

export async function deactivateEngineer(client: PoolClient, id: string, actorId: string) {
  const current = await client.query<EngineerRosterDatabaseRow>(
    `SELECT ${ROSTER_RETURNING}
             FROM engineer_roster
            WHERE id = $1
            FOR UPDATE`,
    [id],
  );
  if (!current.rows[0]) return null;
  const before = engineerRosterEntryFromDatabaseRow(current.rows[0]);
  const updated = await client.query<EngineerRosterDatabaseRow>(
    `UPDATE engineer_roster
              SET active = false, updated_by = $2, updated_at = now()
            WHERE id = $1
            RETURNING ${ROSTER_RETURNING}`,
    [id, actorId],
  );
  const after = engineerRosterEntryFromDatabaseRow(updated.rows[0]);
  return { before, after };
}
