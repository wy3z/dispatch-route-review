"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { HelpOverlay } from "./HelpOverlay";
import { KeyboardShortcutsOverlay } from "./KeyboardShortcutsOverlay";
import { ThemeToggle } from "./ThemeToggle";
import { DispatchHeader } from "./DispatchHeader";

type Props = {
  active: "dispatch" | "admin" | "engineers";
  canAccessDispatch: boolean;
  canAccessAdmin: boolean;
  canManageEngineers: boolean;
  keyboardShortcutsOpen?: boolean;
  onKeyboardShortcutsChange?: (open: boolean) => void;
  cacheGeneratedAt?: string | null;
};

const HELP_ONBOARDING_STORAGE_KEY = "dispatch-help-seen-v1";
const cacheTimestampFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

function cacheTimestamp(value: string | null) {
  if (!value) return "Not loaded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Unavailable"
    : cacheTimestampFormatter.format(parsed);
}

export function AppHeader(props: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(HELP_ONBOARDING_STORAGE_KEY)) return;
    } catch {
      // Storage failure must not hide the guide.
    }
    const frame = window.requestAnimationFrame(() => {
      try {
        window.localStorage.setItem(HELP_ONBOARDING_STORAGE_KEY, "true");
      } catch {
        // The guide can still open when storage is unavailable.
      }
      setHelpOpen(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    function closeForOutsidePointer(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    function closeForEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", closeForOutsidePointer);
    document.addEventListener("keydown", closeForEscape);
    return () => {
      document.removeEventListener("pointerdown", closeForOutsidePointer);
      document.removeEventListener("keydown", closeForEscape);
    };
  }, [menuOpen]);

  function menuLink(
    href: string,
    label: string,
    page: Props["active"] | null,
    className?: string,
  ) {
    const current = page === props.active;
    return (
      <Link
        href={href}
        className={[current ? "selected" : "", className ?? ""]
          .filter(Boolean)
          .join(" ") || undefined}
        aria-current={current ? "page" : undefined}
        onClick={() => setMenuOpen(false)}
      >
        {label}
      </Link>
    );
  }

  const closeHelp = useCallback(() => {
    setHelpOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const onKeyboardShortcutsChange = props.onKeyboardShortcutsChange;
  const closeKeyboardShortcuts = useCallback(() => {
    onKeyboardShortcutsChange?.(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, [onKeyboardShortcutsChange]);

  const showReturn = props.active !== "dispatch" && props.canAccessDispatch;

  return (
    <>
      <DispatchHeader
        centre={null}
        actions={
          <>
            <ThemeToggle />
            {showReturn ? (
              <Link className="app-return-link" href="/">
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="m8.5 5-5 5 5 5M4 10h12.5" />
                </svg>
                <span>Return</span>
              </Link>
            ) : null}
            <div className="app-menu" ref={menuRef}>
              <button
                ref={triggerRef}
                type="button"
                className="app-menu-trigger"
                aria-label={menuOpen ? "Close application menu" : "Open application menu"}
                aria-expanded={menuOpen}
                aria-controls={menuId}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" />
                </svg>
              </button>
              {menuOpen ? (
                <nav
                  id={menuId}
                  className="app-menu-popover"
                  aria-label="Application pages"
                >
                  {props.canAccessDispatch
                    ? menuLink("/", "Dispatch", "dispatch")
                    : null}
                  {props.canManageEngineers
                    ? menuLink("/engineers", "Engineer Controls", "engineers")
                    : null}
                  {props.canAccessAdmin
                    ? menuLink("/admin", "Administration", "admin")
                    : null}
                  <span className="app-menu-separator" aria-hidden="true" />
                  {onKeyboardShortcutsChange ? (
                    <button
                      type="button"
                      aria-keyshortcuts="/"
                      onClick={() => {
                        setMenuOpen(false);
                        onKeyboardShortcutsChange(true);
                      }}
                    >
                      Keyboard Shortcuts
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      setHelpOpen(true);
                    }}
                  >
                    Help
                  </button>
                  {props.cacheGeneratedAt !== undefined ? (
                    <>
                      <span className="app-menu-separator" aria-hidden="true" />
                      <div className="app-menu-cache-status">
                        <span>Schedule cache</span>
                        {props.cacheGeneratedAt ? (
                          <time dateTime={props.cacheGeneratedAt}>
                            {cacheTimestamp(props.cacheGeneratedAt)}
                          </time>
                        ) : (
                          <time>{cacheTimestamp(null)}</time>
                        )}
                      </div>
                    </>
                  ) : null}
                  <span className="app-menu-separator" aria-hidden="true" />
                  <a
                    href="/logout"
                    className="app-menu-logout"
                    onClick={() => setMenuOpen(false)}
                  >
                    Logout
                  </a>
                </nav>
              ) : null}
            </div>
          </>
        }
      />
      {helpOpen ? <HelpOverlay onClose={closeHelp} /> : null}
      {props.keyboardShortcutsOpen ? (
        <KeyboardShortcutsOverlay onClose={closeKeyboardShortcuts} />
      ) : null}
    </>
  );
}
