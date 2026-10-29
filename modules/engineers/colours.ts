export type ResourceColourIndex = number;

/** Persist the index, not the hex, so every surface shares one palette. */
export const RESOURCE_COLOURS = [
  "#D70000",
  "#8C3CFF",
  "#028800",
  "#00ACC7",
  "#E7A500",
  "#FF7FD1",
  "#6C004F",
  "#583B00",
  "#005759",
  "#15E18D",
  "#0000DD",
  "#A2766A",
  "#BCB7FF",
  "#C004B9",
  "#645473",
  "#790000",
  "#0774D8",
  "#739B7D",
  "#FF7852",
  "#004B00",
  "#8F7B01",
  "#F3007B",
  "#8FBA00",
  "#A67BB8",
  "#5A02A3",
  "#E3AFAF",
  "#A03A52",
  "#A2C8C8",
  "#9E4B00",
  "#546745",
] as const;

type ResourceColourSource = {
  colourIndex?: unknown;
  resourceId?: number | string | null;
  id?: number | string | null;
  name?: string | null;
  routeOwnerKey?: string | null;
  /** A legacy explicit colour remains authoritative when one is supplied. */
  colour?: string | null;
};

function stableResourceKey(resource: ResourceColourSource) {
  return String(
    resource.resourceId ??
      resource.routeOwnerKey ??
      resource.id ??
      resource.name ??
      "unidentified-resource",
  );
}

/** Stable FNV-1a based fallback for records that predate stored colourIndex. */
function fallbackColourIndex(key: string): ResourceColourIndex {
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  return (hash >>> 0) % RESOURCE_COLOURS.length;
}

export function getResourceColourIndex(
  resource: ResourceColourSource,
): ResourceColourIndex {
  const stored = resource.colourIndex;
  if (
    typeof stored === "number" &&
    Number.isInteger(stored) &&
    stored >= 0 &&
    stored < RESOURCE_COLOURS.length
  ) {
    return stored;
  }
  return fallbackColourIndex(stableResourceKey(resource));
}

export function getResourceColour(
  resource: ResourceColourSource,
): string {
  if (
    typeof resource.colour === "string" &&
    /^#[\da-f]{6}$/i.test(resource.colour)
  ) {
    return resource.colour.toUpperCase();
  }
  return RESOURCE_COLOURS[getResourceColourIndex(resource)];
}

function linearChannel(value: number) {
  const channel = value / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(colour: string) {
  const value = colour.replace("#", "");
  if (!/^[\da-f]{6}$/i.test(value)) return null;
  const red = linearChannel(Number.parseInt(value.slice(0, 2), 16));
  const green = linearChannel(Number.parseInt(value.slice(2, 4), 16));
  const blue = linearChannel(Number.parseInt(value.slice(4, 6), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function getContrastingTextColour(
  background: string,
): "#111827" | "#FFFFFF" {
  const backgroundLuminance = relativeLuminance(background);
  if (backgroundLuminance === null) return "#FFFFFF";
  const darkLuminance = relativeLuminance("#111827") ?? 0;
  const darkContrast =
    (Math.max(backgroundLuminance, darkLuminance) + 0.05) /
    (Math.min(backgroundLuminance, darkLuminance) + 0.05);
  const lightContrast = (1.05) / (backgroundLuminance + 0.05);
  return darkContrast >= lightContrast ? "#111827" : "#FFFFFF";
}

export function withAlpha(colour: string, alpha: number) {
  const value = colour.replace("#", "");
  if (!/^[\da-f]{6}$/i.test(value)) return colour;
  const boundedAlpha = Math.min(1, Math.max(0, alpha));
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${boundedAlpha})`;
}
