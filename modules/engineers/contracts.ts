export type EngineerBase = {
  resourceId: number | null;
  name: string;
  base: string;
  region: EngineerRegion;
  latitude: number;
  longitude: number;
  /** Extra names this person is booked under when a visit has no resource ID. */
  aliases?: string[];
  /** Persisted palette position when this base comes from the managed roster. */
  colourIndex?: number | null;
};

export type EngineerRosterEntry = EngineerBase & {
  id: string;
  resourceId: number;
  colourIndex: number;
  active: boolean;
  /** Recurring ISO weekdays (Monday = 1), not dated leave or confirmed shifts. */
  workingDays: number[];
  /** Local wall-clock time in HH:MM form. */
  workdayStart: string;
  /** Local wall-clock time in HH:MM form. */
  workdayEnd: string;
};

export const engineerRegions = ["North", "Midlands", "South", "Ireland"] as const;
export type EngineerRegion = (typeof engineerRegions)[number];

export type { EngineerRosterPayload } from "./validation";
