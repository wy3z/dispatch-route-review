"use client";

import { useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import { useDialogFocusManagement } from "../../../shared/ui/useDialogFocusManagement";
import { AutotaskLink } from "@/modules/work/client";
import styles from "./ServiceCallDetail.module.css";
import { formatDuration, formatTime } from "../../../shared/formatting";
import {
  formatServiceCallDate,
  joinServiceCallAddress,
  ownerTypeLabel,
} from "./service-call-detail-helpers";
import { jobTypeLabel } from "@/modules/work/presentation";
import type { ScheduledVisit } from "@/modules/work/contracts";

type Props = {
  visit: ScheduledVisit;
  engineerColour?: string;
  onClose: () => void;
};

type DetailIcon =
  | "appointment"
  | "engineer"
  | "location"
  | "reference"
  | "work";

function DetailSectionIcon({ icon }: { icon: DetailIcon }) {
  if (icon === "appointment") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 3v3M17 3v3M4.5 9h15M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
      </svg>
    );
  }
  if (icon === "engineer") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
      </svg>
    );
  }
  if (icon === "location") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" />
        <circle cx="12" cy="10" r="2.25" />
      </svg>
    );
  }
  if (icon === "reference") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 3.5h8l4 4V20a1 1 0 0 1-1 1H7a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2Z" />
        <path d="M15 3.5V8h4M8.5 12h7M8.5 16h7" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m14.5 5.5 4 4M13 7l4 4M5 20l3.5-1 10-10a2.12 2.12 0 1 0-3-3l-10 10L5 20Z" />
    </svg>
  );
}

function DetailSectionHeading({
  id,
  icon,
  children,
}: {
  id: string;
  icon: DetailIcon;
  children: string;
}) {
  return (
    <h3 id={id} className={styles.sectionHeading}>
      <span className={styles.sectionIcon}>
        <DetailSectionIcon icon={icon} />
      </span>
      {children}
    </h3>
  );
}

export function ServiceCallDetail({ visit, engineerColour, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useDialogFocusManagement(dialogRef, closeButtonRef, onClose);

  const address = useMemo(() => joinServiceCallAddress(visit), [visit]);
  const bookedDate = useMemo(
    () => formatServiceCallDate(visit.startDateTime),
    [visit.startDateTime],
  );
  const titleId = `service-detail-title-${visit.id}`;
  const descriptionId = `service-detail-description-${visit.id}`;
  const ticketLabel =
    visit.ticketNumber || `Service call ${visit.serviceCallId}`;
  const statusLabel = visit.isComplete
    ? "Complete"
    : visit.ticketStatusLabel || "Open";
  const engineerStyle = engineerColour
    ? ({ "--engineer-colour": engineerColour } as CSSProperties)
    : undefined;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className={styles.header}>
          <div className={styles.heading}>
            <div className={styles.kickerRow}>
              <span className={styles.kicker}>Booked service call</span>
              <span
                className={`${styles.status}${visit.isComplete ? ` ${styles.statusComplete}` : ""}`}
              >
                <span aria-hidden="true" />
                {statusLabel}
              </span>
            </div>
            <h2 id={titleId}>{visit.companyName}</h2>
            <p id={descriptionId}>{visit.title}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.closeButton}
            aria-label="Close service call details"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m7 7 10 10M17 7 7 17" />
            </svg>
          </button>
        </header>

        <div className={styles.scroller}>
          <section className={styles.section} aria-labelledby={`${titleId}-appointment`}>
            <DetailSectionHeading id={`${titleId}-appointment`} icon="appointment">
              Scheduled
            </DetailSectionHeading>
            <div className={styles.appointmentCard}>
              <div className={styles.dateBlock}>
                <span>Booked date</span>
                <strong>{bookedDate}</strong>
              </div>
              <dl className={styles.appointmentGrid}>
                <div>
                  <dt>Start</dt>
                  <dd>
                    <time dateTime={visit.startDateTime}>
                      {formatTime(visit.startDateTime)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Finish</dt>
                  <dd>
                    <time dateTime={visit.endDateTime}>
                      {formatTime(visit.endDateTime)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd>{formatDuration(visit.durationMinutes)}</dd>
                </div>
              </dl>
            </div>
          </section>

          <div className={styles.twoColumnSections}>
            <section className={styles.section} aria-labelledby={`${titleId}-work`}>
              <DetailSectionHeading id={`${titleId}-work`} icon="work">
                Job details
              </DetailSectionHeading>
              <dl className={styles.detailList}>
                <div>
                  <dt>Ticket</dt>
                  <dd>
                    {visit.autotaskUrl ? (
                      <AutotaskLink
                        className={styles.ticketLink}
                        href={visit.autotaskUrl}
                        label={`Open ${ticketLabel} in Autotask`}
                      >
                        {ticketLabel}
                      </AutotaskLink>
                    ) : (
                      ticketLabel
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Job type</dt>
                  <dd>{jobTypeLabel(visit.jobType, visit.queueLabel)}</dd>
                </div>
                <div>
                  <dt>Queue</dt>
                  <dd>{visit.queueLabel || "Queue not set"}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{visit.ticketStatusLabel || "Status unavailable"}</dd>
                </div>
              </dl>
            </section>

            <section className={styles.section} aria-labelledby={`${titleId}-engineer`}>
              <DetailSectionHeading id={`${titleId}-engineer`} icon="engineer">
                Engineer
              </DetailSectionHeading>
              <div className={styles.engineerCard} style={engineerStyle}>
                <span className={styles.engineerAvatar} aria-hidden="true">
                  {visit.resourceName
                    .split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((part) => part[0]?.toUpperCase())
                    .join("") || "—"}
                </span>
                <div>
                  <strong>{visit.resourceName || "No assigned engineer"}</strong>
                  <span>{ownerTypeLabel(visit.ownerType)}</span>
                </div>
              </div>
              {visit.resourceId !== null ? (
                <p className={styles.supportingCopy}>
                  Resource ID <span>{visit.resourceId}</span>
                </p>
              ) : null}
            </section>
          </div>

          <section className={styles.section} aria-labelledby={`${titleId}-location`}>
            <DetailSectionHeading id={`${titleId}-location`} icon="location">
              Location
            </DetailSectionHeading>
            <div className={styles.locationCard}>
              <div>
                <strong>{visit.locationName || visit.companyName}</strong>
                <span>{address || "Address unavailable"}</span>
              </div>
              <span className={styles.coordinates}>
                {visit.latitude !== null && visit.longitude !== null
                  ? `${visit.latitude.toFixed(4)}, ${visit.longitude.toFixed(4)}`
                  : "Coordinates unavailable"}
              </span>
            </div>
          </section>

          <section className={styles.section} aria-labelledby={`${titleId}-records`}>
            <DetailSectionHeading id={`${titleId}-records`} icon="reference">
              Record details
            </DetailSectionHeading>
            <dl className={styles.recordGrid}>
              <div>
                <dt>Service call ID</dt>
                <dd>{visit.serviceCallId}</dd>
              </div>
              <div>
                <dt>Ticket ID</dt>
                <dd>{visit.ticketId ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt>Queue ID</dt>
                <dd>{visit.queueId || "Unavailable"}</dd>
              </div>
              <div>
                <dt>Status ID</dt>
                <dd>{visit.ticketStatusId || "Unavailable"}</dd>
              </div>
            </dl>
          </section>

          {(visit.additionalTicketCount > 0 ||
            visit.ignoredResourceCount > 0 ||
            visit.ownerType !== "internal") && (
            <section className={styles.flags} aria-label="Service call notes">
              {visit.additionalTicketCount > 0 && (
                <span>
                  +{visit.additionalTicketCount} linked ticket
                  {visit.additionalTicketCount === 1 ? "" : "s"}
                </span>
              )}
              {visit.ignoredResourceCount > 0 && (
                <span>
                  {visit.ignoredResourceCount} unrecognised linked resource
                  {visit.ignoredResourceCount === 1 ? "" : "s"}
                </span>
              )}
              {visit.ownerType !== "internal" && (
                <span>{ownerTypeLabel(visit.ownerType)}</span>
              )}
            </section>
          )}
        </div>

        <footer className={styles.footer}>
          <span className={styles.readOnlyNote}>Read-only cached Autotask data</span>
          <div className={styles.footerActions}>
            {visit.autotaskUrl ? (
              <AutotaskLink
                className={styles.openLink}
                href={visit.autotaskUrl}
                label={`Open ${ticketLabel} in Autotask`}
              >
                <span className={styles.autotaskIcon} aria-hidden="true" />
                <span>Open in Autotask</span>
              </AutotaskLink>
            ) : (
              <span className={styles.noLink}>Autotask link unavailable</span>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
