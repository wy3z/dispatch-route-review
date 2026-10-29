import type { EngineerRegion, EngineerRosterEntry } from "../contracts";
import { query } from "../../../platform/database";

export type EngineerRosterDatabaseRow = {
  id: string;
  autotask_resource_id: string;
  name: string;
  base: string;
  region: EngineerRegion;
  latitude: number;
  longitude: number;
  colour_index: number;
  active: boolean;
  working_days: number[];
  workday_start: string;
  workday_end: string;
  aliases: string[];
};

export function engineerRosterEntryFromDatabaseRow(
  row: EngineerRosterDatabaseRow,
): EngineerRosterEntry {
  const resourceId = Number(row.autotask_resource_id);
  if (!Number.isSafeInteger(resourceId) || resourceId <= 0) {
    throw new Error(`Invalid stored Autotask resource ID for engineer ${row.id}.`);
  }
  return {
    id: row.id,
    resourceId,
    name: row.name,
    base: row.base,
    region: row.region,
    latitude: row.latitude,
    longitude: row.longitude,
    colourIndex: row.colour_index,
    active: row.active,
    workingDays: row.working_days,
    workdayStart: row.workday_start.slice(0, 5),
    workdayEnd: row.workday_end.slice(0, 5),
    aliases: row.aliases ?? [],
  };
}

export async function listEngineerRoster(
  { includeInactive = false }: { includeInactive?: boolean } = {},
) {
  const result = await query<EngineerRosterDatabaseRow>(
    `SELECT id, autotask_resource_id::text, name, base, region,
            latitude, longitude, colour_index, active, working_days,
            to_char(workday_start, 'HH24:MI') AS workday_start,
            to_char(workday_end, 'HH24:MI') AS workday_end, aliases
       FROM engineer_roster
      WHERE $1::boolean OR active = true
      ORDER BY active DESC,
               CASE region
                 WHEN 'North' THEN 1
                 WHEN 'Midlands' THEN 2
                 WHEN 'South' THEN 3
                 WHEN 'Ireland' THEN 4
               END,
               name,
               autotask_resource_id`,
    [includeInactive],
  );
  return result.rows.map(engineerRosterEntryFromDatabaseRow);
}
