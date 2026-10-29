"use client";

import type { ReactNode } from "react";

type Props = {
  centre: ReactNode;
  actions: ReactNode;
};

export function DispatchHeader({ centre, actions }: Props) {
  return (
    <header className="dispatch-review-topbar map-glass-surface">
      <div className="dispatch-review-brand">
        <strong>Dispatch Route Review</strong>
      </div>
      {centre}
      <div className="dispatch-review-header-actions">{actions}</div>
    </header>
  );
}
