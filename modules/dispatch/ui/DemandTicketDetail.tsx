"use client";

import { useRef } from "react";
import { useDialogFocusManagement } from "../../../shared/ui/useDialogFocusManagement";
import { AutotaskLink } from "@/modules/work/client";
import { formatDuration } from "../../../shared/formatting";
import type { PlanningDemandItem } from "@/modules/work/contracts";

type Props = {
  demand: PlanningDemandItem;
  onClose: () => void;
};

export function DemandTicketDetail({ demand, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useDialogFocusManagement(dialogRef, closeButtonRef, onClose);

  const titleId = `demand-detail-title-${demand.ticketId}`;
  const location = [demand.siteLabel, demand.city, demand.postcode]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(", ");

  return (
    <div
      className="service-detail-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} className="service-detail demand-ticket-detail" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="service-detail-head">
          <div className="service-detail-heading">
            <p className="eyebrow">UNASSIGNED REQUEST</p>
            <h2 id={titleId}>{demand.companyLabel}</h2>
            <span className="service-detail-title">{demand.title}</span>
          </div>
          <button ref={closeButtonRef} type="button" className="service-detail-close" aria-label="Close ticket details" onClick={onClose}>×</button>
        </header>

        <div className="service-detail-meta">
          <span className={`service-detail-status${demand.readiness === "eligible" ? " complete" : ""}`}>
            {demand.statusLabel || "Requested"}
          </span>
          <span className="service-detail-owner">{demand.queueLabel}</span>
          {demand.overdue ? <span className="service-detail-extra">Overdue</span> : null}
        </div>

        <dl className="service-detail-grid">
          <div>
            <dt>Ticket</dt>
            <dd><strong>{demand.ticketNumber}</strong><small>Ticket ID {demand.ticketId}</small></dd>
          </div>
          <div>
            <dt>Estimated work</dt>
            <dd><span>{formatDuration(demand.durationMinutes)}</span><small>{demand.durationSource === "assumed" ? "Assumed duration" : "Ticket estimate"}</small></dd>
          </div>
          <div>
            <dt>Queue</dt>
            <dd><span>{demand.queueLabel}</span><small>Queue ID {demand.queueId}</small></dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd><span>{demand.statusLabel}</span><small>Status ID {demand.statusId}</small></dd>
          </div>
          <div className="service-detail-grid-span">
            <dt>Location</dt>
            <dd><span>{location || "Location unavailable"}</span><small>{demand.logisticsTerritory || demand.territoryGroup}</small></dd>
          </div>
        </dl>

        <footer className="service-detail-foot">
          <AutotaskLink className="autotask-action-link service-detail-open" href={demand.autotaskUrl ?? null} label={`Open ${demand.ticketNumber} in Autotask`}>
            <span className="autotask-favicon" aria-hidden="true" />
            <span>Open in Autotask</span>
          </AutotaskLink>
          <button type="button" className="button secondary" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  );
}
