"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ReviewMapProps } from "../contracts";
import type { MapLibreReviewRuntime } from "../runtime/maplibre-review-runtime";
import { recordMapComparisonEvent } from "../runtime/map-comparison-events";
import "../runtime/maplibre-review.css";

/** React owns the host surface; the direct renderer owns everything inside the canvas. */
export function ReviewMap(props: ReviewMapProps & { legend?: ReactNode }) {
  const elementRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLDivElement>(null);
  const attributionRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<MapLibreReviewRuntime | null>(null);
  const latest = useRef(props);
  const [status, setStatus] = useState("Loading map. Routes and Timeline remain available.");
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    latest.current = props;
    runtimeRef.current?.update(props);
  }, [props]);
  useEffect(() => {
    let disposed = false;
    if (elementRef.current)
      recordMapComparisonEvent(elementRef.current, "module-start");
    const engine = import("maplibre-gl");
    void Promise.all([import("../runtime/maplibre-review-runtime"), engine]).then(([{ MapLibreReviewRuntime }, engine]) => {
      if (disposed || !elementRef.current || !navigationRef.current || !attributionRef.current)
        return;
      recordMapComparisonEvent(elementRef.current, "module-ready");
      try {
        runtimeRef.current = new MapLibreReviewRuntime(elementRef.current, latest.current, setStatus, setAnnouncement, engine, {
          navigation: navigationRef.current,
          attribution: attributionRef.current,
        });
      } catch (error) {
        if (new URLSearchParams(location.search).get("mapDiagnostics") === "1")
          elementRef.current.dataset.mapInitError = error instanceof Error ? error.stack : String(error);
        elementRef.current.dataset.basemap = "unavailable";
        elementRef.current.replaceChildren();
        setStatus("Map unavailable: this browser could not start WebGL. Review routes and jobs in the rail or Timeline.");
      }
    }).catch((error) => {
      if (elementRef.current && new URLSearchParams(location.search).get("mapDiagnostics") === "1")
        elementRef.current.dataset.mapInitError = error instanceof Error ? error.stack : String(error);
      if (!disposed)
        setStatus("Map unavailable. Review routes and jobs in the rail or Timeline.");
    });
    return () => {
      disposed = true;
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    };
  }, []);

  return <div className="audit-map-frame review-libre-frame">
    <div ref={elementRef} className="audit-map" data-map-engine="maplibre" role="region" tabIndex={0}
      aria-label="Road map of scheduled engineer visits and unassigned work"
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight - = m" aria-describedby="review-map-help" />
    <div className="review-map-controls">
      <div ref={navigationRef} className="review-map-navigation" />
      <details className="map-controls-row map-glass-surface review-map-legend-tray" onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }}>
        <summary className="review-map-attribution-toggle" aria-label="Map attribution" title="Map attribution">
          {props.legend}
          <span className="review-map-info" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v6" /><circle cx="12" cy="7.5" r=".8" fill="currentColor" stroke="none" />
            </svg>
          </span>
        </summary>
        <div ref={attributionRef} className="review-map-attribution-content" />
      </details>
    </div>
    <span id="review-map-help" className="sr-only">Use the route rail or Timeline to select individual jobs with the keyboard. Enter opens details.</span>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    {status && <p className="review-libre-status" role="status">{status}</p>}
  </div>;
}
