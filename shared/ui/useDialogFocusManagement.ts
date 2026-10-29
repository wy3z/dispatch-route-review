"use client";

import { useEffect, useEffectEvent } from "react";
import type { RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]';

export function useDialogFocusManagement(
  dialogRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  // A changed callback must not unlock scrolling or replace the return-focus target.
  const close = useEffectEvent(onClose);

  useEffect(() => {
    const root = dialogRef.current;
    if (!root) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => initialFocusRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") &&
          element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      if (!root.contains(active) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [dialogRef, initialFocusRef]);
}
