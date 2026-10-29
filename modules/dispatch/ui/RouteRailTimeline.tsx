import type { ReactNode } from "react";
import type { RoutePaneMode } from "./workspace/workspace-layout";

type Props = {
  children: ReactNode;
  routePaneMode: RoutePaneMode;
  snapshotGeneratedAt: string | null;
  onCycleRoutePane: () => void;
};

export function RouteRailTimeline({ children, routePaneMode, snapshotGeneratedAt, onCycleRoutePane }: Props) {
  return (
    <div className="route-rail-timeline" id="route-rail-timeline">
      <div className="route-rail-timeline-head">
        <span title="A booked route is an engineer’s assigned visits for the selected day, shown as context for comparison.">Booked day by engineer · grouped by region</span>
        <div className="dispatch-review-timeline-legend" aria-label="Timeline legend">
          <span><i className="visit" /> Visit</span>
          <span><i className="travel" /> Travel</span>
          <span><i className="critical" /> Problem</span>
          <span><i className="warning" /> Tight</span>
          <span><i className="data" /> Data</span>
          <span><i className="suggestion" /> Suggestion</span>
        </div>
      </div>
      {children}
      <footer className="dispatch-review-timeline-foot">
        <div>
          <span>Travel is a static road estimate, not live traffic.</span>
          <strong>
            Read-only source snapshot · {snapshotGeneratedAt
              ? new Date(snapshotGeneratedAt).toLocaleString("en-GB")
              : "loading"}
          </strong>
        </div>
        <button
          type="button"
          className="route-rail-expand-timeline"
          aria-label={routePaneMode === "timeline" ? "Expand route timeline to full screen" : "Return to engineer routes"}
          aria-controls="route-rail-timeline"
          aria-keyshortcuts="t"
          onClick={onCycleRoutePane}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 4.5h14M6 8v8M10 6v10M14 10v6" />
          </svg>
          <span>{routePaneMode === "timeline" ? "Full screen" : "Routes"}</span>
          <kbd>T</kbd>
        </button>
      </footer>
    </div>
  );
}
