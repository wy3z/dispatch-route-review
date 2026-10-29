"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogFocusManagement } from "./useDialogFocusManagement";

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  useDialogFocusManagement(dialogRef, doneRef, onClose);

  return createPortal(
    <div
      className="help-overlay-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="help-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-overlay-title"
        aria-describedby="help-overlay-intro"
      >
        <header className="help-overlay-header">
          <div>
            <h2 id="help-overlay-title">Quick guide</h2>
            <p id="help-overlay-intro">
              Find unassigned work near existing engineer routes. This view is read-only; make any changes in Autotask.
            </p>
          </div>
          <button type="button" className="help-overlay-close" aria-label="Close quick guide" onClick={onClose}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
          </button>
        </header>

        <div className="help-overlay-content">
          <ol className="help-steps">
            <li><b>1</b><div><strong>Choose a day</strong><p>Open Calendar to load booked routes and unassigned work.</p></div></li>
            <li><b>2</b><div><strong>Start with Suggestions</strong><p>Suggestions are nearby unassigned jobs. They are leads, not assignments.</p></div></li>
            <li><b>3</b><div><strong>Compare the route</strong><p>Select a suggestion to highlight the closest relevant route or engineer base. Adjust the distance to widen or narrow the search.</p></div></li>
            <li><b>4</b><div><strong>Check before acting</strong><p>Open the job details and its Autotask record before making any changes.</p></div></li>
          </ol>

          <div className="help-map-key" aria-label="Map key">
            <strong>Map key</strong>
            <span><b>I</b> Install</span><span><b>S</b> Support</span><span><b>M</b> Maintenance</span><span><b>!</b> Review flag</span>
          </div>

          <div className="help-overlay-actions">
            <p><i>Suggestions use straight-line distance and cached data. Autotask remains the source of truth.</i></p>
            <button ref={doneRef} type="button" className="help-overlay-done" onClick={onClose}>Start reviewing</button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
