"use client";

import type { RouteSuggestionContext, RouteSuggestion } from "@/modules/routing/contracts";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { formatMiles } from "../../../shared/coordinates";
import { formatDuration } from "../../../shared/formatting";
import type { PlanningDemandItem } from "@/modules/work/contracts";
import { suggestionNearLabel } from "@/modules/routing/domain";
import styles from "./UnassignedDemandList.module.css";

type Props = {
  items: readonly PlanningDemandItem[];
  suggestions: readonly RouteSuggestion[];
  suggestionRadiusKm: number;
  suggestionContext?: RouteSuggestionContext;
  expanded: boolean;
  focusedDemandId: string | null;
  tooltipDemandId: string | null;
  onExpandedChange: (expanded: boolean) => void;
  onFocus: (demandId: string) => void;
  onOpen: (demandId: string) => void;
  onSuggestionRadiusChange: (radiusKm: number) => void;
  onTooltipShow: (element: HTMLElement, demand: PlanningDemandItem) => void;
  onTooltipHide: () => void;
};

function attentionTone(item: PlanningDemandItem) {
  if (item.overdue) return "critical";
  if (item.ageBand === "aged" || item.exclusionReason) return "warning";
  return null;
}

function workstreamBadge(item: PlanningDemandItem) {
  if (item.workstream === "install") return { label: "Install", short: "I" };
  if (item.workstream === "support") return { label: "Support", short: "S" };
  return { label: "Maintenance", short: "M" };
}

export function partitionUnassignedDemand(
  items: readonly PlanningDemandItem[],
  suggestionByDemandId: ReadonlyMap<string, RouteSuggestion>,
) {
  const suggested: PlanningDemandItem[] = [];
  const remaining: PlanningDemandItem[] = [];
  for (const item of items) {
    if (suggestionByDemandId.has(item.id)) suggested.push(item);
    else remaining.push(item);
  }
  suggested.sort((first, second) => {
    const firstDistance = suggestionByDemandId.get(first.id)?.distanceKm ?? 0;
    const secondDistance = suggestionByDemandId.get(second.id)?.distanceKm ?? 0;
    return firstDistance - secondDistance;
  });
  return { suggested, remaining };
}

export function UnassignedDemandList({
  items,
  suggestions = [],
  suggestionRadiusKm,
  suggestionContext,
  expanded,
  focusedDemandId,
  tooltipDemandId,
  onExpandedChange,
  onFocus,
  onOpen,
  onSuggestionRadiusChange,
  onTooltipShow,
  onTooltipHide,
}: Props) {
  const reduceMotion = useReducedMotion();
  const listId = "route-rail-unassigned-list";
  const historicalSuggestionsUnavailable =
    suggestionContext?.mode === "historical";
  const suggestionByDemandId = new Map(
    suggestions.map((suggestion) => [suggestion.demandId, suggestion]),
  );
  const { suggested, remaining } = partitionUnassignedDemand(
    items,
    suggestionByDemandId,
  );

  function renderTicket(item: PlanningDemandItem) {
    const suggestion = suggestionByDemandId.get(item.id) ?? null;
    const tone = attentionTone(item);
    const badge = workstreamBadge(item);
    return (
      <article
        key={item.id}
        role="listitem"
        className={[
          focusedDemandId === item.id ? styles.selected : "",
          suggestion ? styles.suggested : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined}
      >
        <button
          type="button"
          className={styles.ticket}
          aria-pressed={focusedDemandId === item.id}
          aria-label={
            suggestion
              ? `${item.companyLabel}, suggestion ${formatMiles(suggestion.distanceKm)} from ${suggestion.resourceName}`
              : undefined
          }
          aria-describedby={
            tooltipDemandId === item.id
              ? "route-rail-overview-tooltip"
              : undefined
          }
          data-detail-demand-id={item.id}
          data-suggested={suggestion ? "true" : undefined}
          onClick={() => onFocus(item.id)}
          onDoubleClick={() => onOpen(item.id)}
          onPointerEnter={(event) => onTooltipShow(event.currentTarget, item)}
          onPointerLeave={onTooltipHide}
          onFocus={(event) => onTooltipShow(event.currentTarget, item)}
          onBlur={onTooltipHide}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            onFocus(item.id);
            onOpen(item.id);
          }}
        >
          <i
            className={styles.workstream}
            data-workstream={item.workstream}
            aria-label={badge.label}
          >
            {badge.short}
          </i>
          <span>
            <strong>{item.companyLabel}</strong>
            {suggestion ? (
              <small className={styles.hint} data-suggestion>
                {formatMiles(suggestion.distanceKm)} from {suggestion.resourceName} · {suggestionNearLabel(suggestion)}
              </small>
            ) : null}
            <small>
              {item.ticketNumber} · {item.city || item.postcode || "Location unavailable"} · {formatDuration(item.durationMinutes)}
            </small>
          </span>
          {tone ? <em data-tone={tone}>!</em> : null}
        </button>
      </article>
    );
  }

  return (
    <section className={styles.root}>
      <button
        type="button"
        data-rail-category-trigger
        className={styles.trigger}
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => onExpandedChange(!expanded)}
      >
        <svg className={styles.chevron} viewBox="0 0 20 20" aria-hidden="true">
          <path d="m6.5 8 3.5 3.5L13.5 8" />
        </svg>
        <span>
          <strong>Unassigned</strong>
        </span>
        <b>{items.length}</b>
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            id={listId}
            className={styles.disclosure}
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: .22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className={styles.list} role="list" aria-label="Current backlog tickets">
              {items.length ? (
                <>
                  <div className={styles.group}>
                    <b>{suggested.length}</b>
                    <strong>Suggestions</strong>
                    {suggestionContext && historicalSuggestionsUnavailable ? (
                      <strong>Unavailable for historical dates</strong>
                    ) : null}
                    {!historicalSuggestionsUnavailable ? (
                      <label title="Suggestion distance is the straight-line search radius used to highlight nearby current-backlog jobs.">
                        <span className="sr-only">Nearby distance</span>
                        <select
                          aria-label="Suggestion radius"
                          value={suggestionRadiusKm}
                          onChange={(event) =>
                            onSuggestionRadiusChange(Number(event.target.value))
                          }
                        >
                          <option value={5}>Within {formatMiles(5, 0)}</option>
                          <option value={10}>Within {formatMiles(10, 0)}</option>
                          <option value={20}>Within {formatMiles(20, 0)}</option>
                        </select>
                      </label>
                    ) : null}
                  </div>
                  {suggested.length ? (
                    suggested.map(renderTicket)
                  ) : null}
                  {remaining.length ? remaining.map(renderTicket) : null}
                </>
              ) : (
                <p className={styles.empty}>No current backlog tickets match this route region.</p>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
