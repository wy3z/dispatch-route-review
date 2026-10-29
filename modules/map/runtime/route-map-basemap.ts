import type { FilterSpecification, Map as MapLibreMap } from "maplibre-gl";

const OPEN_FREE_MAP_BRIGHT = "https://tiles.openfreemap.org/styles/bright";
// OpenFreeMap's official style endpoint spells the Fjord theme `fiord`.
const OPEN_FREE_MAP_FJORD = "https://tiles.openfreemap.org/styles/fiord";

export function openFreeMapStyle(theme: string | undefined) {
  return theme === "dark" ? OPEN_FREE_MAP_FJORD : OPEN_FREE_MAP_BRIGHT;
}

const continuityManagers = new WeakSet<object>();

/** Let the candidate display decoded cached parents while finer tiles load. */
export function retainCachedBasemapParents(map: MapLibreMap) {
  const manager = map.style.tileManagers.openmaptiles;
  if (!manager || manager.getSource().type !== "vector" || continuityManagers.has(manager)) return;
  continuityManagers.add(manager);
  // Pinned MapLibre 5.24.0 seam: _updateRetainedTiles calls getTile for each
  // parent, but getTile only checks active tiles. A loading child has not yet
  // "wasRequested", so the native fallback skips decoded out-of-view parents.
  // Promote only an existing, usable cache entry through the native lifecycle:
  // no new fetches, extra cache, camera changes or rendering/eviction override.
  // Revalidate this seam and the visual continuity replay on library upgrades.
  const getTile = manager.getTile;
  manager.getTile = function (tileId) {
    const active = getTile.call(this, tileId);
    if (active) return active;
    const cached = this._outOfViewCache.get(tileId);
    return cached?.hasData() ? this._addTile(tileId) : active;
  };
}

/** Hide regional admin lines and POI noise. Keep country borders (`boundary_2`). */
export function tuneOpenFreeMapStyle(map: MapLibreMap) {
  const layers = map.getStyle().layers ?? [];
  const layerIds = new Set(layers.map((layer) => layer.id));
  const hide = [
    "boundary_3",
    "boundary_state",
    "ferry",
    "poi_r20",
    "poi_r7",
    "highway-name-path",
    "highway-name-minor",
    "highway-name-major",
    "highway-shield-non-us",
    "highway-shield-us-interstate",
    "road_shield_us",
    "highway_name_other",
    "highway_ref",
    "label_other",
    "label_village",
    "label_state",
    "place_other",
    "place_suburb",
    "place_village",
  ];
  hide.forEach((id) => {
    if (layerIds.has(id)) map.setLayoutProperty(id, "visibility", "none");
  });
  const landCountryFilter: FilterSpecification = [
    "all",
    ["==", ["get", "admin_level"], 2],
    ["!=", ["get", "maritime"], 1],
    ["!", ["has", "claimed_by"]],
  ];
  ["boundary_country_z0-4", "boundary_country_z5-"].forEach((id) => {
    if (layerIds.has(id)) map.setFilter(id, landCountryFilter);
  });
  const brightCountryLabels = [
    "label_country_1",
    "label_country_2",
    "label_country_3",
  ];
  brightCountryLabels.forEach((id) => {
    if (!layerIds.has(id)) return;
    map.setPaintProperty(id, "text-opacity", 0.72);
    map.setPaintProperty(id, "text-color", "#7a858e");
    map.setPaintProperty(id, "text-halo-color", "rgba(255,255,255,.68)");
    map.setPaintProperty(id, "text-halo-width", 0.65);
    map.setPaintProperty(id, "text-halo-blur", 0.5);
  });
  const fiordCountryLabels = [
    "place_country_major",
    "place_country_minor",
    "place_country_other",
  ];
  fiordCountryLabels.forEach((id) => {
      if (!layerIds.has(id)) return;
      map.setPaintProperty(id, "text-opacity", 0.78);
      map.setPaintProperty(id, "text-color", "rgb(140,155,168)");
      map.setPaintProperty(id, "text-halo-color", "rgba(26,35,48,.68)");
      map.setPaintProperty(id, "text-halo-width", 0.75);
  });
  [
    ["label_town", 0.88],
    ["label_city", 0.92],
    ["label_city_capital", 0.96],
  ].forEach(([id, opacity]) => {
    if (typeof id !== "string" || !layerIds.has(id)) return;
    map.setPaintProperty(id, "text-opacity", opacity);
    map.setPaintProperty(id, "text-color", "#7c8790");
    map.setPaintProperty(id, "text-halo-color", "rgba(255,255,255,.72)");
    map.setPaintProperty(id, "text-halo-width", 0.7);
    map.setPaintProperty(id, "text-halo-blur", 0.5);
    map.setPaintProperty(id, "icon-opacity", 0.46);
  });
  [
    ["place_town", 0.88],
    ["place_city", 0.92],
    ["place_city_large", 0.96],
  ].forEach(([id, opacity]) => {
    if (typeof id !== "string" || !layerIds.has(id)) return;
    map.setPaintProperty(id, "text-opacity", opacity);
    map.setPaintProperty(id, "text-color", "rgb(153,166,176)");
    map.setPaintProperty(id, "text-halo-color", "rgba(24,31,45,.72)");
    map.setPaintProperty(id, "text-halo-width", 0.75);
    map.setPaintProperty(id, "text-halo-blur", 0.5);
    map.setPaintProperty(id, "icon-opacity", 0.46);
  });
  if (layerIds.has("airport")) {
    map.setPaintProperty("airport", "text-opacity", 0.88);
    map.setPaintProperty("airport", "text-color", "#7c8790");
    map.setPaintProperty("airport", "text-halo-color", "rgba(255,255,255,.72)");
    map.setPaintProperty("airport", "text-halo-width", 0.7);
    map.setPaintProperty("airport", "text-halo-blur", 0.5);
    map.setPaintProperty("airport", "icon-opacity", 0.46);
  }
  // Hide Fiord's blocky residential fill until local zoom.
  if (
    layerIds.has("place_country_major") &&
    layerIds.has("landuse_residential")
  ) {
    map.setPaintProperty("landuse_residential", "fill-opacity", [
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      0,
      7,
      0,
      8,
      0.12,
      9,
      0.1,
    ]);
  }
  if (layerIds.has("place_country_major")) {
    if (layerIds.has("park")) {
      map.setPaintProperty("park", "fill-opacity", 0);
    }
    if (layerIds.has("park_outline")) {
      map.setPaintProperty("park_outline", "line-opacity", 0);
    }
  }
  if (layerIds.has("place_country_major") && layerIds.has("aeroway-area")) {
    map.setPaintProperty("aeroway-area", "fill-opacity", [
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      0,
      9,
      0,
      10,
      1,
    ]);
  }
  if (layerIds.has("place_country_major") && layerIds.has("road_area_pier")) {
    map.setPaintProperty("road_area_pier", "fill-opacity", [
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      0,
      9,
      0,
      10,
      1,
    ]);
  }
  ["boundary_2", "boundary_country_z0-4", "boundary_country_z5-"].forEach(
    (id) => {
      if (!layerIds.has(id)) return;
      map.setPaintProperty(id, "line-opacity", 0.42);
      map.setPaintProperty(id, "line-width", 0.8);
    },
  );
  layers.forEach((layer) => {
    if (
      layer.type === "line" &&
      /^(?:tunnel[-_]|highway[-_]|bridge[-_])/.test(layer.id) &&
      !/railway/.test(layer.id) &&
      layerIds.has(layer.id)
    ) {
      const fiord = layerIds.has("place_country_major");
      const colour = /casing/.test(layer.id)
        ? fiord
          ? "#56637a"
          : "#c7c9c8"
        : /(?:minor|service|track|path|link)/.test(layer.id)
          ? fiord
            ? "#4f5c72"
            : "#deddd9"
          : fiord
            ? "#5d6a81"
            : "#d0d2d1";
      map.setPaintProperty(layer.id, "line-color", colour);
      map.setPaintProperty(layer.id, "line-opacity", 0.9);
    }
  });
}
