import { engineerRegions as regions } from "./contracts";
import type { EngineerRegion, EngineerRosterEntry } from "./contracts";

export type EngineerRosterPayload = Omit<EngineerRosterEntry, "id" | "colourIndex">;

export type EngineerRosterValidationResult =
  | { ok: true; engineer: EngineerRosterPayload }
  | { ok: false; message: string; errors: Record<string, string> };

const engineerRegions = new Set<EngineerRegion>(regions);

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normaliseRequiredText(
  value: unknown,
  label: string,
  maxLength: number,
  errors: Record<string, string>,
  key: string,
) {
  if (typeof value !== "string") {
    errors[key] = `${label} is required.`;
    return "";
  }
  const normalised = value.trim().replace(/\s+/g, " ");
  if (!normalised) errors[key] = `${label} is required.`;
  else if (normalised.length > maxLength) {
    errors[key] = `${label} must be ${maxLength} characters or fewer.`;
  }
  return normalised;
}

function normaliseTime(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function timeMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

/** Operator-managed alternative names; keeps nicknames out of source code. */
const MAX_ENGINEER_ALIASES = 10;

function normaliseAliases(
  value: unknown,
  name: string,
  errors: Record<string, string>,
) {
  if (value === undefined) return [];
  const failure = (message: string) => {
    errors.aliases = message;
    return [];
  };
  if (!Array.isArray(value)) {
    return failure("Aliases must be a list of names.");
  }
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return failure("Aliases must be a list of names.");
    }
    const normalised = entry.trim().replace(/\s+/g, " ");
    if (!normalised) continue;
    if (normalised.length > 256) {
      return failure("Each alias must be 256 characters or fewer.");
    }
    const key = normalised.toLowerCase();
    // The roster name itself always matches; storing it as an alias is noise.
    if (key === name.toLowerCase() || seen.has(key)) continue;
    seen.add(key);
    aliases.push(normalised);
  }
  if (aliases.length > MAX_ENGINEER_ALIASES) {
    return failure(`Use ${MAX_ENGINEER_ALIASES} aliases or fewer.`);
  }
  return aliases;
}

/** Validate a complete roster record. PATCH uses the same full payload as POST. */
export function validateEngineerRosterPayload(
  value: unknown,
): EngineerRosterValidationResult {
  const body = recordValue(value);
  if (!body) {
    return {
      ok: false,
      message: "A complete engineer record is required.",
      errors: {},
    };
  }

  const errors: Record<string, string> = {};
  const resourceId = body.resourceId;
  if (
    typeof resourceId !== "number" ||
    !Number.isSafeInteger(resourceId) ||
    resourceId <= 0
  ) {
    errors.resourceId = "Autotask resource ID must be a positive whole number.";
  }

  const name = normaliseRequiredText(body.name, "Name", 256, errors, "name");
  const base = normaliseRequiredText(body.base, "Home base", 256, errors, "base");

  const region = typeof body.region === "string" ? body.region.trim() : "";
  if (!engineerRegions.has(region as EngineerRegion)) {
    errors.region = "Region must be North, Midlands, South, or Ireland.";
  }

  const latitude = body.latitude;
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90
  ) {
    errors.latitude = "Latitude must be between -90 and 90.";
  }

  const longitude = body.longitude;
  if (
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    errors.longitude = "Longitude must be between -180 and 180.";
  }

  if (typeof body.active !== "boolean") {
    errors.active = "Active must be true or false.";
  }

  const workingDays = Array.isArray(body.workingDays)
    ? [...new Set(body.workingDays)].sort((first, second) =>
        typeof first === "number" && typeof second === "number"
          ? first - second
          : 0,
      )
    : [];
  if (
    workingDays.length === 0 ||
    workingDays.some(
      (day) => typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 7,
    )
  ) {
    errors.workingDays = "Select at least one valid working day.";
  }

  const workdayStart = normaliseTime(body.workdayStart);
  const workdayEnd = normaliseTime(body.workdayEnd);
  if (!workdayStart) errors.workdayStart = "Start time must use HH:MM.";
  if (!workdayEnd) errors.workdayEnd = "End time must use HH:MM.";
  if (
    workdayStart &&
    workdayEnd &&
    timeMinutes(workdayEnd) <= timeMinutes(workdayStart)
  ) {
    errors.workdayEnd = "End time must be later than start time.";
  }

  // Aliases are matched case-insensitively against booked visit names, so
  // normalise them against the (already normalised) roster name.
  const aliases = normaliseAliases(body.aliases, name, errors);

  if (Object.keys(errors).length > 0) {
    return {
      ok: false,
      message: "Check the highlighted engineer fields.",
      errors,
    };
  }

  return {
    ok: true,
    engineer: {
      resourceId: resourceId as number,
      name,
      base,
      region: region as EngineerRegion,
      latitude: latitude as number,
      longitude: longitude as number,
      active: body.active as boolean,
      workingDays: workingDays as number[],
      workdayStart: workdayStart as string,
      workdayEnd: workdayEnd as string,
      aliases,
    },
  };
}

export function engineerResourceIdMutationError(
  currentResourceId: number,
  nextResourceId: number,
) {
  return currentResourceId === nextResourceId
    ? null
    : "Autotask resource ID cannot be changed after an engineer is created.";
}
