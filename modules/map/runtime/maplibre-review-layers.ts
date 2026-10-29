import type { ExpressionSpecification, FilterSpecification, LayerSpecification, SymbolLayerSpecification, Map as LibreMap, } from "maplibre-gl";
import type { ReviewPointProperties } from "../scene";
import { getContrastingTextColour } from "@/modules/engineers/domain";
import { MAP_MARKER_TOKENS, mapMarkerZoomTier } from "../markers";
export const SOURCE = { roads: "review-roads", booked: "review-booked", homes: "review-homes", demand: "review-demand", issues: "review-issues", advisory: "review-advisory", focus: "review-focus" } as const;
export const POINT_LAYERS = ["review-focus-icon", "review-suggested-icon", "review-demand-icon", "review-issues-icon", "review-booked-icon", "review-homes-icon"];
export const HIT_LAYERS = [...POINT_LAYERS, "review-roads-hit"];
const tiers = ["regional", "city", "street", "detail"] as const;
function pointRadius(properties: ReviewPointProperties, tier: typeof tiers[number]) {
  const token = MAP_MARKER_TOKENS.size[tier];
  return (properties.kind === "demand" ? token.demand : properties.kind === "home" ? Math.max(19, token.home)
    : properties.complete ? token.complete : Math.max(22, token.open)) / 2;
}
/** Refine only native queried candidates: transparent atlas pixels are not targets. */
export function pointContainsPointer(properties: ReviewPointProperties, zoom: number, x: number, y: number) {
  const tier = mapMarkerZoomTier(zoom);
  const radius = pointRadius(properties, tier);
  // Four CSS pixels beyond the body/stroke is an intentional interaction margin.
  const margin = 4;
  const body = properties.kind === "home"
    ? Math.abs(x) <= radius + margin && Math.abs(y) <= radius + margin
    : Math.hypot(x, y) <= radius + margin;
  const pinTip = properties.kind === "demand" && y >= 0 && y <= radius * 1.4 + margin
    && Math.abs(x) <= Math.max(0, (radius * 1.4 - y) / 1.4) + margin;
  const badge = (cx: number, cy: number, halfWidth: number) => Math.abs(x - cx) <= halfWidth + margin && Math.abs(y - cy) <= 9 + margin;
  return body || pinTip || (properties.thirdParty && badge(-radius, -radius, 11))
    || ((properties.attention || properties.kind === "issue") && badge(Math.max(radius, 12), -Math.max(radius, 12), 9));
}
/** Marker artwork has one home; canvas sprites stay local and render on the GPU. */
export function pointImageKey(properties: ReviewPointProperties) {
  const { kind, colour, label, complete, thirdParty, attention, excluded, severity } = properties;
  return JSON.stringify([kind, colour, label, complete, thirdParty, attention, excluded, severity]);
}
export function installPointImages(map: LibreMap, properties: ReviewPointProperties, measure?: (name: string, ms: number) => void) {
  const key = pointImageKey(properties);
  for (const tier of tiers) {
    const id = `${key}:${tier}`;
    if (map.hasImage(id))
      continue;
    const started = measure ? performance.now() : 0;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 160;
    // Each sprite is immediately read into ImageData for MapLibre. Request a
    // readback-friendly; the browser chooses its backing implementation.
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const allocated = measure ? performance.now() : 0;
    ctx.scale(2, 2);
    ctx.translate(40, 40);
    const demand = properties.kind === "demand";
    const issue = properties.kind === "issue";
    const home = properties.kind === "home";
    // A sequence remains readable at every zoom; completed markers expose it on focus.
    const radius = pointRadius(properties, tier);
    const ink = getContrastingTextColour(properties.colour);
    ctx.lineWidth = 2;
    ctx.strokeStyle = demand ? properties.colour : "rgba(255,255,255,.95)";
    ctx.fillStyle = demand ? "#fffaf0" : properties.colour;
    const badge = (text: string, x: number, y: number, colour: string, width = 18) => {
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.roundRect(x - width / 2, y - 9, width, 18, 5);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "white";
      ctx.stroke();
      ctx.fillStyle = "white";
      ctx.font = "800 11px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x, y);
    };
    {
      ctx.beginPath();
      if (home) {
        ctx.moveTo(-radius, -radius / 5);
        ctx.lineTo(0, -radius);
        ctx.lineTo(radius, -radius / 5);
        ctx.lineTo(radius, radius);
        ctx.lineTo(-radius, radius);
        ctx.closePath();
      }
      else if (demand) {
        // Rounded pin head with a tapered tip; keep the label at the map anchor.
        const shoulder = Math.PI / 4;
        ctx.arc(0, 0, radius, shoulder, Math.PI - shoulder, true);
        ctx.lineTo(0, radius * 1.4);
        ctx.closePath();
      }
      else
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
      if (properties.excluded)
        ctx.setLineDash([3, 3]);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = demand ? "#24334e" : ink;
      ctx.font = `800 ${demand ? 14 : 12}px system-ui`;
      if (home) {
        ctx.fillRect(-3, 1, 6, radius - 1);
      }
      else
        ctx.fillText(properties.complete ? "✓" : properties.label, 0, .5);
      if (properties.thirdParty)
        badge("3P", -radius, -radius, "#596579", 22);
      const severityColour = properties.severity === "critical" ? "#cf334d" : properties.severity === "data" ? "#4c6d96" : "#ae6700";
      if (properties.attention || issue)
        badge("!", Math.max(radius, 12), -Math.max(radius, 12), severityColour);
      if (properties.excluded) {
        ctx.strokeStyle = properties.colour;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-radius + 3, radius - 3);
        ctx.lineTo(-radius + 10, radius - 10);
        ctx.stroke();
      }
    }
    const drawn = measure ? performance.now() : 0;
    const pixels = ctx.getImageData(0, 0, 160, 160);
    const read = measure ? performance.now() : 0;
    map.addImage(id, pixels, { pixelRatio: 2 });
    if (measure) {
      measure("canvasAllocationMs", allocated - started);
      measure("canvasDrawingMs", drawn - allocated);
      measure("canvasReadbackMs", read - drawn);
      measure("addImageMs", performance.now() - read);
      measure("images", 1);
    }
  }
}
export function idsFilter(property: string, ids: readonly string[]): ExpressionSpecification {
  return ["in", ["get", property], ["literal", ids]];
}
const all: FilterSpecification = ["literal", true];
const none: FilterSpecification = ["literal", false];
const iconImage: ExpressionSpecification = ["step", ["zoom"],
  ["concat", ["get", "image"], ":regional"], 8, ["concat", ["get", "image"], ":city"],
  11, ["concat", ["get", "image"], ":street"], 14, ["concat", ["get", "image"], ":detail"]];
function icons(id: string, source: string): SymbolLayerSpecification {
  return { id, type: "symbol", source, layout: {
      "icon-image": iconImage, "icon-allow-overlap": true, "icon-ignore-placement": true,
      "icon-padding": 0, "symbol-sort-key": ["get", "priority"],
    }, paint: { "icon-opacity": source === SOURCE.booked || source === SOURCE.issues || source === SOURCE.homes
        ? ["coalesce", ["feature-state", "reviewOpacity"], ["case", ["get", "complete"], .64, 1]] : 1 } };
}
/** All casing/emphasis/hit layers share the exact same canonical geometry source. */
export function reviewLayers(): LayerSpecification[] {
  const line = (id: string, width: number, casing: boolean, filter: FilterSpecification = all): LayerSpecification => ({
    id, type: "line", source: SOURCE.roads, filter,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": casing ? "rgba(25,35,45,.40)" : ["get", "colour"], "line-width": width,
      "line-opacity": casing ? .82 : ["case", ["get", "complete"], .55, .84] },
  });
  const road: FilterSpecification = ["==", ["get", "kind"], "road"];
  const fallback: FilterSpecification = ["==", ["get", "kind"], "fallback"];
  const fallbackCasing = line("review-fallback-casing", 6, true, fallback);
  const fallbackLine = line("review-fallback-line", 3.5, false, fallback);
  if (fallbackCasing.type === "line")
    fallbackCasing.paint!["line-dasharray"] = [1, 2.6];
  if (fallbackLine.type === "line")
    fallbackLine.paint!["line-dasharray"] = [1, 2.6];
  return [
    line("review-roads-casing", 6, true, road), line("review-roads-line", 3.5, false, road), fallbackCasing, fallbackLine,
    line("review-emphasis-casing", 8, true, none), line("review-emphasis-line", 5, false, none),
    { id: "review-roads-hit", type: "line", source: SOURCE.roads, paint: { "line-width": 18, "line-opacity": 0 } },
    { id: "review-advisory-line", type: "line", source: SOURCE.advisory, paint: {
        "line-color": "#e8a317", "line-width": ["case", ["boolean", ["feature-state", "focused"], false], 2, 1],
        "line-opacity": ["case", ["boolean", ["feature-state", "focused"], false], .65, .25], "line-dasharray": [2, 4],
      } },
    { ...icons("review-homes-icon", SOURCE.homes), filter: none }, icons("review-booked-icon", SOURCE.booked), icons("review-issues-icon", SOURCE.issues),
    { id: "review-suggested-halo", type: "circle", source: SOURCE.demand, filter: none, paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 27, 14, 37],
        "circle-color": "#e8a317", "circle-opacity": .16, "circle-stroke-color": "#e8a317", "circle-stroke-width": 2, "circle-stroke-opacity": .65,
      } },
    icons("review-demand-icon", SOURCE.demand), { ...icons("review-suggested-icon", SOURCE.demand), filter: none },
    { id: "review-focus-halo", type: "circle", source: SOURCE.focus, filter: ["!=", ["get", "kind"], "issue"], paint: {
        "circle-radius": ["case", ["==", ["get", "kind"], "demand"], 34, 22], "circle-color": "#ffffff", "circle-opacity": .2,
        "circle-stroke-color": "#7357bd", "circle-stroke-width": 3, "circle-stroke-opacity": .95,
      } }, icons("review-focus-icon", SOURCE.focus),
  ];
}
