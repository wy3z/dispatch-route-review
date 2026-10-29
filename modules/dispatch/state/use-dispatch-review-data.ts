"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { watchPlanningDemandCache, watchScheduleCache } from "@/modules/work/client";
import type {
  ReviewCacheState,
  PlanningDemandSnapshot,
  ScheduleSnapshot,
} from "@/modules/work/contracts";
import {
  addIsoCalendarDays,
  londonCalendarDate,
  londonLocalMidnightUtc,
} from "../../../shared/calendar";
import { isReadyToBookDateEligible } from "@/modules/work/domain";
import { resolveRouteSuggestionContext } from "@/modules/routing/domain";

export function isDispatchReviewDemandDateEligible(
  date: string,
  now = new Date(),
) {
  return isReadyToBookDateEligible(date, now);
}

export function nextDispatchReviewDemandEligibilityCheckAt(now = new Date()) {
  return londonLocalMidnightUtc(
    addIsoCalendarDays(londonCalendarDate(now), 1),
  );
}

type Options = {
  date: string;
  onScheduleLoaded: (snapshot: ScheduleSnapshot) => void;
};

/** Adapt independent cached views to React and the selected London review day. */
export function useDispatchReviewData({
  date,
  onScheduleLoaded,
}: Options) {
  const [schedule, setSchedule] = useState<ReviewCacheState<ScheduleSnapshot>>({
    snapshot: null, loading: true, warming: false, error: "",
  });
  const [demand, setDemand] = useState<ReviewCacheState<PlanningDemandSnapshot>>({
    snapshot: null, loading: false, warming: false, error: "",
  });
  const demandView = useRef<ReturnType<typeof watchPlanningDemandCache> | null>(null);
  const [demandEligibilityRevision, setDemandEligibilityRevision] = useState(0);
  const demandDateEligible = isDispatchReviewDemandDateEligible(date);

  useEffect(() => {
    if (!demandDateEligible) return;
    const delay = Math.max(
      0,
      nextDispatchReviewDemandEligibilityCheckAt() - Date.now(),
    );
    const timer = window.setTimeout(() => {
      setDemandEligibilityRevision((revision) => revision + 1);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [demandDateEligible, demandEligibilityRevision]);

  useEffect(() => {
    const view = watchScheduleCache(date, setSchedule, onScheduleLoaded);
    return () => view.dispose();
  }, [date, onScheduleLoaded]);

  // The rail always needs demand on eligible dates, even when map layers are hidden.
  // Keep one owner so date eligibility does not reset retained freshness or schedule reads.
  useEffect(() => {
    const view = watchPlanningDemandCache(setDemand);
    demandView.current = view;
    return () => {
      view.dispose();
      demandView.current = null;
    };
  }, []);
  useEffect(() => {
    demandView.current?.setActive(demandDateEligible);
  }, [demandDateEligible]);

  const demandSnapshot = demand.snapshot;
  const suggestionContext = useMemo(() => demandDateEligible && demandSnapshot
    ? resolveRouteSuggestionContext({ selectedDate: date, backlogDate: demandSnapshot.scopeDate })
    : undefined, [date, demandDateEligible, demandSnapshot]);

  return {
    snapshot: schedule.snapshot,
    loading: schedule.loading,
    loadError: schedule.error,
    demandSnapshot: demandDateEligible ? demandSnapshot : null,
    suggestionContext,
    demandLoading: demandDateEligible ? demand.loading : false,
    demandWarming: demandDateEligible ? demand.warming : false,
    demandError: demandDateEligible ? demand.error : "",
  };
}
