import type { EngineerRosterEntry } from "@/modules/engineers/contracts";

export type EngineerDraft = {
  id?: string;
  resourceId: string;
  name: string;
  base: string;
  region: EngineerRosterEntry["region"];
  latitude: string;
  longitude: string;
  active: boolean;
  workingDays: number[];
  workdayStart: string;
  workdayEnd: string;
  /** Comma-separated in the form; parsed into the aliases list on save. */
  aliasesText: string;
};

export const weekDays = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
] as const;

export function blankDraft(): EngineerDraft {
  return {
    resourceId: "",
    name: "",
    base: "",
    region: "North",
    latitude: "",
    longitude: "",
    active: true,
    workingDays: [1, 2, 3, 4, 5],
    workdayStart: "09:00",
    workdayEnd: "17:00",
    aliasesText: "",
  };
}

export function draftForEngineer(engineer: EngineerRosterEntry): EngineerDraft {
  return {
    id: engineer.id,
    resourceId: String(engineer.resourceId),
    name: engineer.name,
    base: engineer.base,
    region: engineer.region,
    latitude: String(engineer.latitude),
    longitude: String(engineer.longitude),
    active: engineer.active,
    workingDays: [...engineer.workingDays],
    workdayStart: engineer.workdayStart,
    workdayEnd: engineer.workdayEnd,
    aliasesText: (engineer.aliases ?? []).join(", "),
  };
}

function aliasesFromDraft(aliasesText: string) {
  return aliasesText
    .split(",")
    .map((alias) => alias.trim())
    .filter(Boolean);
}

export function requestBody(draft: EngineerDraft) {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    resourceId: Number(draft.resourceId),
    name: draft.name,
    base: draft.base,
    region: draft.region,
    latitude: Number(draft.latitude),
    longitude: Number(draft.longitude),
    active: draft.active,
    workingDays: draft.workingDays,
    workdayStart: draft.workdayStart,
    workdayEnd: draft.workdayEnd,
    aliases: aliasesFromDraft(draft.aliasesText),
  };
}

export function workingDaysLabel(days: number[]) {
  if (days.join(",") === "1,2,3,4,5") return "Mon–Fri";
  return weekDays
    .filter((day) => days.includes(day.value))
    .map((day) => day.label)
    .join(", ");
}
