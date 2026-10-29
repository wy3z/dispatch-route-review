"use client";

import { motion } from "motion/react";
import type { Transition } from "motion/react";
import type { RefObject } from "react";
import type { RouteIssue } from "@/modules/routing/contracts";
import type { ScheduledVisit } from "@/modules/work/contracts";
import { workspaceDockPanelMotion } from "./workspace/workspace-motion";

type Props = {
  panelRef: RefObject<HTMLElement | null>;
  transition: Transition;
  issues: RouteIssue[];
  visitById: ReadonlyMap<string, ScheduledVisit>;
  selectedVisitId: string | null;
  bookedLoading: boolean;
  scheduleLoaded: boolean;
  onClose: () => void;
  onIssueFocus: (issue: RouteIssue) => void;
};

export function DispatchReviewPanel({
  panelRef,
  transition,
  issues,
  visitById,
  selectedVisitId,
  bookedLoading,
  scheduleLoaded,
  onClose,
  onIssueFocus,
}: Props) {
  return (
    <motion.aside
      {...workspaceDockPanelMotion}
      transition={transition}
      className="panel audit-list-panel dispatch-review-popover-panel dispatch-map-tools-panel map-glass-surface"
      id="map-tools-panel"
      ref={panelRef}
      aria-labelledby="map-tool-notifications"
      data-map-tool-content="notifications"
    >
      <div className="panel-head">
        <div>
          <p className="eyebrow">ISSUES</p>
          <h2>Route problems</h2>
        </div>
        <button
          className="panel-minimise"
          aria-label="Close issues"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <div
        className="audit-list"
        id="audit-review-list"
        data-map-shortcut-scope="notifications-list"
      >
        {bookedLoading && !scheduleLoaded ? (
          <div className="list-empty">Loading booked visits…</div>
        ) : null}
        {!bookedLoading && !issues.length ? (
          <div className="list-empty">
            <strong>No route conflicts detected</strong>
            <span>Check missing data warnings and review the map before dispatch.</span>
          </div>
        ) : null}
        {issues.map((issue) => {
          const issueVisit = issue.visitId
            ? visitById.get(issue.visitId)
            : null;
          return (
            <article
              className={`issue-card severity-${issue.severity}${issue.visitId && selectedVisitId === issue.visitId ? " selected" : ""}`}
              key={issue.id}
            >
              <button
                type="button"
                className="issue-focus"
                data-notification-item
                data-detail-visit-id={issue.visitId ?? undefined}
                aria-pressed={Boolean(
                  issue.visitId && selectedVisitId === issue.visitId,
                )}
                aria-label={
                  issueVisit
                    ? `Show ${issueVisit.ticketNumber || "job"} on the map`
                    : `Focus ${issue.title}`
                }
                onClick={() => onIssueFocus(issue)}
              >
                <span className="issue-label">
                  {issue.severity === "critical"
                    ? "PROBLEM"
                    : issue.severity === "warning"
                      ? "TIGHT"
                      : "DATA"}
                </span>
                <strong>{issue.title}</strong>
                <small>
                  {issue.resourceName}
                  {issueVisit ? ` · ${issueVisit.companyName}` : ""}
                </small>
                <p>{issue.detail}</p>
              </button>
            </article>
          );
        })}
      </div>
    </motion.aside>
  );
}
