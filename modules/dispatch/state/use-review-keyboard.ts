"use client";

import type { useReviewModel } from "./use-review-model";
import { useCallback, useEffect } from "react";
import type { RefObject } from "react";
import type { useDispatchReviewController } from "./use-dispatch-review-controller";
import { adjacentReviewDate } from "../model/review";
import { resolveMapWorkspaceShortcut } from "./shortcuts";
import type { MapWorkspaceActiveTarget } from "./shortcuts";

type Options = {
  controller: ReturnType<typeof useDispatchReviewController>;
  model: ReturnType<typeof useReviewModel>;
  routeRailRef: RefObject<HTMLElement | null>;
  reverseRailExpansionRef: RefObject<HTMLButtonElement | null>;
  changeDateRef: RefObject<(date: string) => void>;
};

/** Workspace keyboard and rail navigation; the renderer still owns camera movement. */
export function useReviewKeyboard(
  { controller, model, routeRailRef, reverseRailExpansionRef, changeDateRef }: Options,
) {
  const {
    activeMapTool,
    timelineOpen,
    dismissMapTools,
    clearReviewSelection,
    fitVisibleMarkers,
    openVisitDetails,
    openDemandDetails,
    openReviewOverlay,
    openFiltersOverlay,
    showRailCategory,
    toggleAllRailSections,
    cycleRoutePaneMode,
    date,
    routesOpen,
    focusedDemandId,
    selectedRouteId,
    selectedVisitId,
    detailVisitId,
    detailDemandId,
    setShortcutsOpen,
    collapsedRouteRegions,
  } = controller;
  const {
    readyToBookItems,
    visitById,
    railRouteGroups,
  } = model;
  const { state: workspaceLayoutState, toggleTool } = controller.workspaceLayout;
  const unassignedExpanded = workspaceLayoutState.unassignedExpanded;

  const cycleRailCategory = useCallback((direction: "previous" | "next") => {
    const categoryTriggers = Array.from(
      routeRailRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-rail-category-trigger]",
      ) ?? [],
    );
    const activeElement = document.activeElement;
    let currentIndex = categoryTriggers.findIndex((trigger) => {
      if (trigger === activeElement) return true;
      const controlledId = trigger.getAttribute("aria-controls");
      return Boolean(
        controlledId &&
        activeElement instanceof Node &&
        document.getElementById(controlledId)?.contains(activeElement),
      );
    });

    if (currentIndex === -1) {
      const expandedIndexes = [
        ...(unassignedExpanded ? [0] : []),
        ...railRouteGroups.flatMap(({ region }, index) =>
          collapsedRouteRegions.has(region) ? [] : [index + 1],
        ),
      ];
      currentIndex = direction === "next"
        ? expandedIndexes.at(-1) ?? -1
        : expandedIndexes[0] ?? 0;
    }

    const categoryCount = railRouteGroups.length + 1;
    const nextIndex = direction === "next"
      ? (currentIndex + 1) % categoryCount
      : (currentIndex - 1 + categoryCount) % categoryCount;
    showRailCategory(
      nextIndex,
      railRouteGroups.map(({ region }) => region),
    );

    window.requestAnimationFrame(() => {
      const nextTrigger = routeRailRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-rail-category-trigger]",
      )[nextIndex];
      nextTrigger?.focus({ preventScroll: true });
      nextTrigger?.scrollIntoView({ block: "nearest" });
    });
  }, [
    routeRailRef,
    collapsedRouteRegions,
    railRouteGroups,
    showRailCategory,
    unassignedExpanded,
  ]);

  useEffect(() => {
    function activeShortcutTarget(target: EventTarget | null): MapWorkspaceActiveTarget {
      if (!(target instanceof HTMLElement)) return "none";
      const scope = target.closest<HTMLElement>("[data-map-shortcut-scope]")
        ?.dataset.mapShortcutScope;
      if (scope === "routes") return "routes-list";
      if (scope === "notifications-list") return "review-list";
      if (scope === "map-tools") return "map-tools";
      if (scope === "filters") return "filters";
      if (target.closest(".audit-map")) return "map";
      return "none";
    }

    function handleMapShortcut(event: KeyboardEvent) {
      const target = event.target;
      const targetElement = target instanceof HTMLElement ? target : null;
      // Popup and map chrome controls retain normal focus traversal and activation.
      if (targetElement?.closest(".maplibregl-popup, .review-map-controls") && ["Tab", "Enter", " "].includes(event.key)) return;
      if (targetElement?.closest(".review-map-controls") && event.key === "Escape") return;
      const editable = Boolean(
        targetElement?.matches("input, textarea, select, [contenteditable='true']"),
      );
      const modalOpen =
        detailVisitId !== null ||
        detailDemandId !== null ||
        Boolean(targetElement?.closest('[role="dialog"]'));
      const selectionActive =
        selectedRouteId !== "all" ||
        selectedVisitId !== null ||
        focusedDemandId !== null;
      const intent = resolveMapWorkspaceShortcut(
        {
          key: event.key,
          code: event.code,
          defaultPrevented: event.defaultPrevented,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          editable,
          modalOpen,
        },
        {
          activeTarget: activeShortcutTarget(target),
          overlayOpen: activeMapTool !== null || timelineOpen || routesOpen,
          selectionActive,
        },
      );
      if (!intent) return;

      // The map runtime owns camera movement. Shortcuts still declare those keys for help/tests.
      if (intent.type === "pan-map" || intent.type === "zoom-map") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("review-map-camera", { detail: intent }));
        return;
      }

      event.preventDefault();
      if (event.key === "Escape") {
        // The first Escape press clears selection atomically.
        event.stopPropagation();
      }
      if (intent.type === "map-home") {
        fitVisibleMarkers();
        return;
      }
      if (intent.type === "toggle-review") {
        openReviewOverlay((current) => !current);
        return;
      }
      if (intent.type === "toggle-filters") {
        openFiltersOverlay((current) => !current);
        return;
      }
      if (intent.type === "toggle-date") {
        toggleTool("date");
        return;
      }
      if (intent.type === "toggle-shortcut-help") {
        setShortcutsOpen((current) => !current);
        return;
      }
      if (intent.type === "cycle-timeline-size") {
        cycleRoutePaneMode();
        return;
      }
      if (intent.type === "toggle-rail-sections") {
        const allCollapsed =
          !workspaceLayoutState.unassignedExpanded &&
          railRouteGroups.every(({ region }) => collapsedRouteRegions.has(region));
        toggleAllRailSections(
          railRouteGroups.map(({ region }) => region),
          allCollapsed,
        );
        return;
      }
      if (intent.type === "cycle-rail-category") {
        cycleRailCategory(intent.direction);
        return;
      }
      if (intent.type === "change-date") {
        changeDateRef.current(adjacentReviewDate(date, intent.direction));
        return;
      }
      if (intent.type === "move-rail-job") {
        const rail = routeRailRef.current;
        if (!rail) return;
        const reverseExpandedEngineer = reverseRailExpansionRef.current;
        if (
          intent.direction === "previous" &&
          reverseExpandedEngineer !== null &&
          reverseExpandedEngineer === document.activeElement
        ) {
          const expandedEngineer = reverseExpandedEngineer;
          reverseRailExpansionRef.current = null;
          const visits = Array.from(
            rail.querySelectorAll<HTMLButtonElement>(
              `#${CSS.escape(expandedEngineer.getAttribute("aria-controls") ?? "")} [data-detail-visit-id]`,
            ),
          ).filter((button) => button.offsetParent !== null);
          const lastVisit = visits.at(-1);
          if (lastVisit) {
            lastVisit.focus();
            lastVisit.click();
            return;
          }
        }
        const items = Array.from(
          rail.querySelectorAll<HTMLButtonElement>(
            ".route-rail-route, .review-timeline-engineer, [data-detail-visit-id], [data-detail-demand-id]",
          ),
        ).filter((button) => button.offsetParent !== null);
        if (!items.length) {
          const categoryTriggers = Array.from(
            rail.querySelectorAll<HTMLButtonElement>(
              "[data-rail-category-trigger]",
            ),
          ).filter((button) => button.offsetParent !== null);
          if (
            categoryTriggers.length &&
            categoryTriggers.every(
              (button) => button.getAttribute("aria-expanded") === "false",
            )
          ) {
            categoryTriggers[0].focus();
            categoryTriggers[0].click();
          }
          return;
        }
        const currentIndex = items.findIndex(
          (button) => button === document.activeElement,
        );
        const from = currentIndex === -1
          ? intent.direction === "next" ? -1 : 0
          : currentIndex;
        const nextIndex = intent.direction === "next"
          ? (from + 1) % items.length
          : (from - 1 + items.length) % items.length;
        const next = items[nextIndex];
        reverseRailExpansionRef.current =
          intent.direction === "previous" &&
            next.classList.contains("route-rail-route") &&
            next.getAttribute("aria-expanded") === "false"
            ? next
            : null;
        next.focus();
        next.click();
        return;
      }
      if (intent.type === "open-focused-job") {
        // A suggested demand can retain a booked anchor for context. The anchor
        // must not replace the focused unassigned item for keyboard actions.
        if (focusedDemandId) {
          openDemandDetails(focusedDemandId);
          return;
        }
        if (selectedVisitId) {
          openVisitDetails(selectedVisitId);
          return;
        }
        targetElement?.closest<HTMLButtonElement>("button")?.click();
        return;
      }
      if (intent.type === "open-selection-autotask") {
        const detailTarget = targetElement?.closest<HTMLElement>(
          "[data-detail-visit-id], [data-detail-demand-id]",
        );
        const visitId = detailTarget?.dataset.detailVisitId ?? selectedVisitId;
        const demandId = detailTarget?.dataset.detailDemandId ?? focusedDemandId;
        const href = demandId
          ? readyToBookItems.find((item) => item.id === demandId)?.autotaskUrl
          : visitId
            ? visitById.get(visitId)?.autotaskUrl
            : null;
        if (href) window.open(href, "_blank", "noopener,noreferrer");
        return;
      }
      if (intent.type === "clear-selection") {
        clearReviewSelection();
        return;
      }
      if (intent.type === "dismiss-overlay") {
        dismissMapTools();
      }
    }

    window.addEventListener("keydown", handleMapShortcut, true);
    return () => window.removeEventListener("keydown", handleMapShortcut, true);
  }, [
    routeRailRef,
    reverseRailExpansionRef,
    changeDateRef,
    clearReviewSelection,
    fitVisibleMarkers,
    collapsedRouteRegions,
    cycleRailCategory,
    cycleRoutePaneMode,
    detailDemandId,
    detailVisitId,
    dismissMapTools,
    activeMapTool,
    focusedDemandId,
    date,
    openDemandDetails,
    openFiltersOverlay,
    openReviewOverlay,
    openVisitDetails,
    railRouteGroups,
    routesOpen,
    selectedRouteId,
    selectedVisitId,
    readyToBookItems,
    setShortcutsOpen,
    timelineOpen,
    toggleAllRailSections,
    toggleTool,
    workspaceLayoutState.unassignedExpanded,
    visitById,
  ]);
}
