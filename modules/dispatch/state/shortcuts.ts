/** Keyboard intents for the map workspace. DOM focus and selection stay in the UI. */

export type MapWorkspaceActiveTarget =
  | "none"
  | "map"
  | "routes-list"
  | "review-list"
  | "map-tools"
  | "filters";

export type MapWorkspaceDirection = "up" | "down" | "left" | "right";

export type MapWorkspaceShortcutEvent = {
  key: string;
  /** Physical key identity. Preferred for bindings that must ignore Shift. */
  code?: string;
  defaultPrevented?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  /** True for inputs, textareas, selects and contenteditable controls. */
  editable?: boolean;
  /** True while a modal dialog owns keyboard interaction. */
  modalOpen?: boolean;
};

export type MapWorkspaceShortcutContext = {
  activeTarget: MapWorkspaceActiveTarget;
  /** A non-modal drawer, sheet or popover currently visible. */
  overlayOpen: boolean;
  /** An active map route, visit or demand selection that Escape can clear. */
  selectionActive: boolean;
};

export type MapWorkspaceShortcutIntent =
  | { type: "map-home" }
  | { type: "toggle-date" }
  | { type: "toggle-filters" }
  | { type: "toggle-review" }
  | { type: "cycle-timeline-size" }
  | { type: "toggle-rail-sections" }
  | { type: "toggle-shortcut-help" }
  | { type: "change-date"; direction: "previous" | "next" }
  | { type: "pan-map"; direction: MapWorkspaceDirection }
  | { type: "zoom-map"; direction: "in" | "out" }
  | { type: "cycle-rail-category"; direction: "previous" | "next" }
  | { type: "move-rail-job"; direction: "previous" | "next" }
  | { type: "open-focused-job" }
  | { type: "open-selection-autotask" }
  | { type: "clear-selection" }
  | { type: "dismiss-overlay" };

function directionForArrow(key: string): MapWorkspaceDirection | null {
  switch (key) {
    case "arrowup":
      return "up";
    case "arrowdown":
      return "down";
    case "arrowleft":
      return "left";
    case "arrowright":
      return "right";
    default:
      return null;
  }
}

function shouldIgnoreCommand(event: MapWorkspaceShortcutEvent) {
  return Boolean(
    event.defaultPrevented ||
      event.modalOpen ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey,
  );
}

function zoomDirection(event: MapWorkspaceShortcutEvent): "in" | "out" | null {
  if (event.code === "Minus" || event.key === "-" || event.key === "_") {
    return "out";
  }
  if (event.code === "Equal" || event.key === "=" || event.key === "+") {
    return "in";
  }
  return null;
}

function isHelpKey(event: MapWorkspaceShortcutEvent) {
  return event.code === "Slash" || event.key === "/" || event.key === "?";
}

/** Workspace intent, or null to leave the event with its native target. */
export function resolveMapWorkspaceShortcut(
  event: MapWorkspaceShortcutEvent,
  context: MapWorkspaceShortcutContext,
): MapWorkspaceShortcutIntent | null {
  if (shouldIgnoreCommand(event)) return null;

  const key = event.key.toLowerCase();

  if (key === "escape") {
    if (context.selectionActive) return { type: "clear-selection" };
    if (context.overlayOpen) return { type: "dismiss-overlay" };
    return null;
  }

  if (event.editable) return null;

  const zoom = zoomDirection(event);
  if (zoom) return { type: "zoom-map", direction: zoom };
  if (isHelpKey(event)) return { type: "toggle-shortcut-help" };

  if (key === "tab") {
    return {
      type: "move-rail-job",
      direction: event.shiftKey ? "previous" : "next",
    };
  }

  if (key === "r") {
    return {
      type: "cycle-rail-category",
      direction: event.shiftKey ? "previous" : "next",
    };
  }

  const arrow = directionForArrow(key);
  if (arrow) {
    return { type: "pan-map", direction: arrow };
  }

  if (event.shiftKey) return null;

  switch (key) {
    case "m":
      return { type: "map-home" };
    case "t":
      return { type: "cycle-timeline-size" };
    case "e":
      return { type: "toggle-rail-sections" };
    case "c":
      return { type: "toggle-date" };
    case "f":
      return { type: "toggle-filters" };
    case "i":
      return { type: "toggle-review" };
    case "[":
      return { type: "change-date", direction: "previous" };
    case "]":
      return { type: "change-date", direction: "next" };
    case "enter":
      return { type: "open-focused-job" };
    case "a":
      return { type: "open-selection-autotask" };
    default:
      return null;
  }
}
