import assert from "node:assert/strict";
import test from "node:test";
import { resolveMapWorkspaceShortcut } from "../modules/dispatch/state/shortcuts";
import type {
  MapWorkspaceShortcutContext,
  MapWorkspaceShortcutEvent,
} from "../modules/dispatch/state/shortcuts";

const idle: MapWorkspaceShortcutContext = {
  activeTarget: "none",
  overlayOpen: false,
  selectionActive: false,
};

function resolve(
  key: string,
  context: Partial<MapWorkspaceShortcutContext> = {},
  event: Partial<MapWorkspaceShortcutEvent> = {},
) {
  return resolveMapWorkspaceShortcut({ key, ...event }, { ...idle, ...context });
}

test("global workspace shortcuts resolve to their documented actions", () => {
  assert.deepEqual(resolve("m"), { type: "map-home" });
  assert.deepEqual(resolve("t"), { type: "cycle-timeline-size" });
  assert.deepEqual(resolve("e"), { type: "toggle-rail-sections" });
  assert.deepEqual(resolve("c"), { type: "toggle-date" });
  assert.deepEqual(resolve("i"), { type: "toggle-review" });
  assert.deepEqual(resolve("f"), { type: "toggle-filters" });
  assert.deepEqual(resolve("Tab"), { type: "move-rail-job", direction: "next" });
  assert.deepEqual(resolve("Tab", {}, { shiftKey: true }), {
    type: "move-rail-job",
    direction: "previous",
  });
  assert.deepEqual(resolve("r"), {
    type: "cycle-rail-category",
    direction: "next",
  });
  assert.deepEqual(resolve("R", {}, { shiftKey: true }), {
    type: "cycle-rail-category",
    direction: "previous",
  });
  assert.deepEqual(resolve("/"), { type: "toggle-shortcut-help" });
  assert.deepEqual(resolve("?", {}, { shiftKey: true, code: "Slash" }), {
    type: "toggle-shortcut-help",
  });
  assert.deepEqual(resolve("["), { type: "change-date", direction: "previous" });
  assert.deepEqual(resolve("]"), { type: "change-date", direction: "next" });
  assert.deepEqual(resolve("a"), { type: "open-selection-autotask" });
  assert.deepEqual(resolve("Enter"), { type: "open-focused-job" });
  assert.equal(resolve("o"), null);
  assert.equal(resolve("q"), null);
});

test("map movement uses arrows for panning and Shift-safe zoom", () => {
  for (const [key, direction] of [
    ["ArrowUp", "up"],
    ["ArrowDown", "down"],
    ["ArrowLeft", "left"],
    ["ArrowRight", "right"],
  ] as const) {
    assert.deepEqual(resolve(key), { type: "pan-map", direction });
    assert.deepEqual(resolve(key, {}, { shiftKey: true }), {
      type: "pan-map",
      direction,
    });
  }
  assert.equal(resolve("w"), null);
  assert.deepEqual(resolve("a"), { type: "open-selection-autotask" });
  for (const event of [
    { key: "-", code: "Minus" },
    { key: "_", code: "Minus", shiftKey: true },
  ]) {
    assert.deepEqual(resolve(event.key, {}, event), {
      type: "zoom-map",
      direction: "out",
    });
  }
  for (const event of [
    { key: "=", code: "Equal" },
    { key: "+", code: "Equal", shiftKey: true },
    { key: "+" },
  ]) {
    assert.deepEqual(resolve(event.key, {}, event), {
      type: "zoom-map",
      direction: "in",
    });
  }
  assert.equal(resolve("z"), null);
  assert.equal(resolve("x"), null);
});

test("Escape deselects, then dismisses an overlay, and does not reset the map", () => {
  assert.deepEqual(resolve("Escape", { selectionActive: true }), {
    type: "clear-selection",
  });
  assert.deepEqual(resolve("Escape", { overlayOpen: true }), {
    type: "dismiss-overlay",
  });
  assert.equal(resolve("Escape"), null);
});

test("handled, editable, modal and system-modified events stay with their owner", () => {
  for (const event of [
    { defaultPrevented: true },
    { modalOpen: true },
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
  ]) {
    assert.equal(resolve("m", {}, event), null);
  }
  assert.equal(resolve("m", {}, { editable: true }), null);
  assert.equal(resolve("Escape", {}, { modalOpen: true }), null);
  assert.equal(resolve("Tab", {}, { editable: true }), null);
});
