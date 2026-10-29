"use client";

import { useEffect, useState } from "react";
import type { EngineerRosterEntry } from "../contracts";

/** Load the managed roster used by booked routes, idle engineers and capacity. */
export function useEngineerRoster() {
  const [engineers, setEngineers] = useState<EngineerRosterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoading(true);
      setError("");
      void fetch("/api/engineers", {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = (await response.json().catch(() => null)) as
            | { engineers?: EngineerRosterEntry[]; message?: string }
            | null;
          if (!response.ok || !payload?.engineers) {
            throw new Error(
              payload?.message ?? `Engineer roster request failed (${response.status}).`,
            );
          }
          setEngineers(payload.engineers);
        })
        .catch((loadError) => {
          if (loadError instanceof DOMException && loadError.name === "AbortError") {
            return;
          }
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    });
    return () => controller.abort();
  }, []);

  return { engineers, loading, error };
}
