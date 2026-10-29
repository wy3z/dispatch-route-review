"use client";

import type { RouteFilterRegion } from "../model/regions";
import styles from "./RouteScopeControls.module.css";

type RegionCount = {
  engineers: number;
};

type Props = {
  regions: readonly RouteFilterRegion[];
  selectedRegions: ReadonlySet<RouteFilterRegion>;
  counts: ReadonlyMap<RouteFilterRegion, RegionCount>;
  onToggle: (region: RouteFilterRegion) => void;
};

export function RouteScopeControls({
  regions,
  selectedRegions,
  counts,
  onToggle,
}: Props) {

  return (
    <section className={styles.root} aria-labelledby="route-scope-title">
      <div className={styles.heading}>
        <span id="route-scope-title">Route region</span>
      </div>
      <div
        className={styles.options}
        role="group"
        aria-label="Engineer route regions"
        data-keyboard-group="route-regions"
      >
        {regions.map((region) => {
          const selected = selectedRegions.has(region);
          const count = counts.get(region)?.engineers ?? 0;
          return (
            <button
              key={region}
              type="button"
              data-filter-item
              role="checkbox"
              aria-checked={selected}
              className={selected ? styles.selected : undefined}
              onClick={() => onToggle(region)}
            >
              <span>{region}</span>
              <b>{count}</b>
            </button>
          );
        })}
      </div>
    </section>
  );
}
