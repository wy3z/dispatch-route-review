/** Map marker hierarchy. Visual state stays separate from visit modifiers. */

export type MapMarkerZoomTier = "regional" | "city" | "street" | "detail";

export const MAP_MARKER_TOKENS = {
  zoom: {
    city: 8,
    street: 11,
    detail: 14,
  },
  size: {
    regional: { complete: 10, open: 15, demand: 32, suggestion: 46, home: 15 },
    city: { complete: 13, open: 19, demand: 38, suggestion: 52, home: 19 },
    street: { complete: 17, open: 24, demand: 44, suggestion: 58, home: 24 },
    detail: { complete: 21, open: 30, demand: 50, suggestion: 66, home: 30 },
  },
} as const;

export function mapMarkerZoomTier(zoom: number): MapMarkerZoomTier {
  if (zoom >= MAP_MARKER_TOKENS.zoom.detail) return "detail";
  if (zoom >= MAP_MARKER_TOKENS.zoom.street) return "street";
  if (zoom >= MAP_MARKER_TOKENS.zoom.city) return "city";
  return "regional";
}

export function planningMarkersForLayers<T extends { id: string }>(
  items: T[],
  options: {
    showDemand: boolean;
    showSuggestions: boolean;
    suggestionIds: Iterable<string>;
  },
) {
  if (options.showDemand) return items;
  if (!options.showSuggestions) return [];
  const suggestionIds = new Set(options.suggestionIds);
  return items.filter((item) => suggestionIds.has(item.id));
}
