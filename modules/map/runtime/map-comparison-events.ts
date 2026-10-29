/** Opt-in, non-identifying lifecycle timestamps for map performance comparisons. */
export function recordMapComparisonEvent(element: HTMLElement, name: string, measurements?: Record<string, number>) {
  if (new URLSearchParams(location.search).get("mapDiagnostics") !== "1") return;
  const at = performance.now();
  const detail = { engine: element.dataset.mapEngine, name, at, ...measurements, instrumentationMs: 0 };
  window.dispatchEvent(new CustomEvent("review-map-comparison", { detail }));
  detail.instrumentationMs = performance.now() - at;
}
