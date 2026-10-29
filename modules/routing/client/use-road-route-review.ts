"use client";

import { useEffect, useMemo, useState } from "react";
import { findRouteIssues } from "../issues";
import { loadRoadRoutes } from "./road-routes";
import type { EngineerRoute, RoadRoute, RouteIssue } from "../contracts";

type RoadRouteReviewState = {
  inputKey: string;
  roadRoutes: RoadRoute[];
  loading: boolean;
};

type RoadRouteReview = RoadRouteReviewState & {
  issues: RouteIssue[];
};

const EMPTY_REVIEW: RoadRouteReviewState = {
  inputKey: "",
  roadRoutes: [],
  loading: false,
};

export function roadRouteReviewInputKey(routes: readonly EngineerRoute[]) {
  return JSON.stringify(
    [...routes]
      .sort((first, second) => first.id.localeCompare(second.id))
      .map((route) => ({
        id: route.id,
        coordinates: route.coordinates,
        returnLegIndex: route.returnLegIndex,
        inboundLegs: route.stops.map((stop) => [stop.id, stop.inboundLegIndex]),
      })),
  );
}

export function currentRoadRouteReview(
  review: RoadRouteReviewState,
  canonicalRoutes: readonly EngineerRoute[],
): RoadRouteReview {
  const inputKey = roadRouteReviewInputKey(canonicalRoutes);
  const current = review.inputKey === inputKey
    ? review
    : {
        inputKey,
        roadRoutes: [],
        loading: canonicalRoutes.some((route) => route.coordinates.length >= 2),
      };
  return {
    ...current,
    issues: findRouteIssues([...canonicalRoutes], current.roadRoutes),
  };
}

/** Load road facts and publish each final review result through one state owner. */
export function useRoadRouteReview(canonicalRoutes: EngineerRoute[]) {
  const [review, setReview] = useState<RoadRouteReviewState>(EMPTY_REVIEW);
  const inputKey = roadRouteReviewInputKey(canonicalRoutes);
  const currentReview = useMemo(
    () => currentRoadRouteReview(review, canonicalRoutes),
    [canonicalRoutes, review],
  );

  useEffect(() => {
    const controller = new AbortController();
    const reviewRoutes = canonicalRoutes;
    const routable = reviewRoutes.filter(
      (route) => route.coordinates.length >= 2,
    );

    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      if (!routable.length) {
        setReview({
          inputKey,
          roadRoutes: [],
          loading: false,
        });
        return;
      }

      setReview({ inputKey, roadRoutes: [], loading: true });
      void loadRoadRoutes(routable, controller.signal)
        .then((roadRoutes) => {
          if (controller.signal.aborted) return;
          setReview({
            inputKey,
            roadRoutes,
            loading: false,
          });
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          if (controller.signal.aborted) return;
          setReview({
            inputKey,
            roadRoutes: [],
            loading: false,
          });
        });
    });

    return () => controller.abort();
  // Route objects are rebuilt when a schedule or roster response is published.
  // Restart network work only when the routing facts changed, not merely when
  // React receives a semantically equivalent array with a new identity.
  }, [inputKey]); // eslint-disable-line react-hooks/exhaustive-deps -- inputKey contains every fact needed for the geometry request.

  return currentReview;
}
