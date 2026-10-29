import { isIsoCalendarDate } from "../../shared/calendar";
import type { EngineerBase, EngineerRosterEntry } from "./contracts";

export { engineerRegions } from "./contracts";

function normaliseName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function findEngineerBase(
  engineers: readonly EngineerBase[],
  resourceId: number | null,
  name?: string,
) {
  if (resourceId) {
    return engineers.find((engineer) => engineer.resourceId === resourceId) ?? null;
  }
  if (!name) return null;
  // Fallback for booked visits with no Autotask resource link. Matching is a
  // normalised exact name, plus operator-managed roster aliases so nicknames
  // stay data rather than code. Aliases are deduplicated per engineer only,
  // so cross-engineer collisions are possible: an ambiguous match resolves
  // to NOBODY. An unlinked booking left unassigned is recoverable; silently
  // attributing it to the wrong engineer is not.
  const input = normaliseName(name);
  const matches = engineers.filter(
    (engineer) =>
      normaliseName(engineer.name) === input ||
      (engineer.aliases ?? []).some((alias) => normaliseName(alias) === input),
  );
  return matches.length === 1 ? matches[0] : null;
}

/** Normal weekly roster minutes for one London calendar date. */
export function engineerWorkingMinutesForDate(
  engineer: EngineerRosterEntry,
  date: string,
) {
  if (!engineer.active || !isIsoCalendarDate(date)) return 0;
  const parsed = new Date(`${date}T00:00:00Z`);
  const dayOfWeek = parsed.getUTCDay() || 7;
  if (!engineer.workingDays.includes(dayOfWeek)) return 0;
  const [startHour, startMinute] = engineer.workdayStart.split(":").map(Number);
  const [endHour, endMinute] = engineer.workdayEnd.split(":").map(Number);
  return Math.max(
    0,
    endHour * 60 + endMinute - (startHour * 60 + startMinute),
  );
}
