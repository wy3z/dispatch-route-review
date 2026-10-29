"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogFocusManagement } from "./useDialogFocusManagement";

export function KeyboardShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useDialogFocusManagement(dialogRef, closeRef, onClose);

  return createPortal(
    <div
      className="help-overlay-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="keyboard-shortcuts-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
        aria-describedby="keyboard-shortcuts-intro"
      >
        <header className="keyboard-shortcuts-overlay-header">
          <div>
            <h2 id="keyboard-shortcuts-title">Keyboard Shortcuts</h2>
            <p id="keyboard-shortcuts-intro">
              Use these keys anywhere in Dispatch Review unless you are typing
              in a field or another dialog is open.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="keyboard-shortcuts-overlay-close"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
        </header>

        <div className="keyboard-shortcuts-overlay-content">
          <ul className="shortcut-list" aria-label="Keyboard shortcuts">
            <li><span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd></span> Pan the map</li>
            <li><span><kbd>Tab</kbd></span> Next job in the rail</li>
            <li><span><kbd>Shift</kbd><kbd>Tab</kbd></span> Previous job in the rail</li>
            <li><span><kbd>Enter</kbd></span> Open the focused job</li>
            <li><span><kbd>Esc</kbd></span> Deselect</li>
            <li><span><kbd>[</kbd><kbd>]</kbd></span> Previous / next day</li>
            <li><span><kbd>−</kbd><kbd>=</kbd></span> Zoom out / in</li>
            <li><span><kbd>M</kbd></span> Fit all visible map icons</li>
            <li><span><kbd>T</kbd></span> Cycle rail / timeline / full timeline</li>
            <li><span><kbd>R</kbd></span> Next rail category</li>
            <li><span><kbd>Shift</kbd><kbd>R</kbd></span> Previous rail category</li>
            <li><span><kbd>E</kbd></span> Expand / collapse all rail sections</li>
            <li><span><kbd>C</kbd></span> Calendar</li>
            <li><span><kbd>F</kbd></span> Filters</li>
            <li><span><kbd>I</kbd></span> Issues</li>
            <li><span><kbd>A</kbd></span> Open in Autotask</li>
            <li><span><kbd>?</kbd></span> Keyboard shortcuts</li>
          </ul>
        </div>

        <footer className="keyboard-shortcuts-overlay-footer">
          <p>Press <kbd>Esc</kbd> to close this guide.</p>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
