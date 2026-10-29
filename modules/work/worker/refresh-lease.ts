import { waitForAbort } from "./request-lifecycle";

export type CacheRefreshLeaseLossReason =
  | "renewal_rejected"
  | "renewal_expired";

export class CacheRefreshLeaseLostError extends Error {
  constructor(readonly reason: CacheRefreshLeaseLossReason) {
    super(`Cache refresh lease lost: ${reason}.`);
    this.name = "CacheRefreshLeaseLostError";
  }
}

export function isCacheRefreshLeaseLostError(
  error: unknown,
): error is CacheRefreshLeaseLostError {
  return error instanceof CacheRefreshLeaseLostError;
}

type WaitForAbort = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

function signalPromise<T>(signal: AbortSignal, value: T) {
  return new Promise<T>((resolve) => {
    const finish = () => resolve(value);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export async function loadWithCacheRefreshLease<T>(args: {
  leaseDurationMilliseconds: number;
  shutdownSignal: AbortSignal;
  renewLease: () => Promise<boolean>;
  load: (signal: AbortSignal) => Promise<T>;
  onRenewed?: () => void;
  onRenewalError?: (error: unknown) => void;
  onLeaseLost?: (reason: CacheRefreshLeaseLossReason) => void;
  wait?: WaitForAbort;
  now?: () => number;
}) {
  const now = args.now ?? Date.now;
  const wait = args.wait ?? waitForAbort;
  const leaseDurationMilliseconds = Math.max(
    1,
    Math.floor(args.leaseDurationMilliseconds),
  );
  const renewalIntervalMilliseconds = Math.max(
    1,
    Math.floor(leaseDurationMilliseconds / 3),
  );
  const renewalRetryMilliseconds = Math.max(
    1,
    Math.min(30_000, Math.floor(renewalIntervalMilliseconds / 6)),
  );
  const leaseSafetyMarginMilliseconds = Math.max(
    1,
    Math.min(5_000, Math.floor(leaseDurationMilliseconds / 10)),
  );

  const stopRenewing = new AbortController();
  const work = new AbortController();
  const leaseLost = new AbortController();
  let lastConfirmedAt = now();
  let leaseLostError: CacheRefreshLeaseLostError | null = null;
  let leaseDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

  const abortForShutdown = () => work.abort(args.shutdownSignal.reason);
  args.shutdownSignal.addEventListener("abort", abortForShutdown, { once: true });
  if (args.shutdownSignal.aborted) abortForShutdown();

  function clearLeaseDeadline() {
    if (leaseDeadlineTimer !== null) {
      clearTimeout(leaseDeadlineTimer);
      leaseDeadlineTimer = null;
    }
  }

  function markLeaseLost(reason: CacheRefreshLeaseLossReason) {
    if (leaseLostError) return;
    leaseLostError = new CacheRefreshLeaseLostError(reason);
    clearLeaseDeadline();
    args.onLeaseLost?.(reason);
    leaseLost.abort(leaseLostError);
    work.abort(leaseLostError);
  }

  function armLeaseDeadline() {
    clearLeaseDeadline();
    const safeDeadline =
      lastConfirmedAt +
      leaseDurationMilliseconds -
      leaseSafetyMarginMilliseconds;
    const remainingMilliseconds = Math.max(0, safeDeadline - now());
    leaseDeadlineTimer = setTimeout(
      () => markLeaseLost("renewal_expired"),
      remainingMilliseconds,
    );
  }

  armLeaseDeadline();
  const stoppedOutcome = signalPromise(stopRenewing.signal, {
    kind: "stopped" as const,
  });
  const leaseLostOutcome = signalPromise(leaseLost.signal, {
    kind: "lease_lost" as const,
  });

  const renewal = (async () => {
    let nextWaitMilliseconds = renewalIntervalMilliseconds;
    while (!stopRenewing.signal.aborted && !leaseLost.signal.aborted) {
      await wait(nextWaitMilliseconds, stopRenewing.signal);
      if (stopRenewing.signal.aborted || leaseLost.signal.aborted) return;

      const safeDeadline =
        lastConfirmedAt +
        leaseDurationMilliseconds -
        leaseSafetyMarginMilliseconds;
      if (now() >= safeDeadline) {
        markLeaseLost("renewal_expired");
        return;
      }

      const renewalAttempt = args.renewLease().then(
        (renewed) => ({ kind: "result" as const, renewed }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const outcome = await Promise.race([
        renewalAttempt,
        stoppedOutcome,
        leaseLostOutcome,
      ]);
      if (outcome.kind === "stopped" || outcome.kind === "lease_lost") return;

      if (outcome.kind === "result") {
        if (!outcome.renewed) {
          markLeaseLost("renewal_rejected");
          return;
        }
        lastConfirmedAt = now();
        armLeaseDeadline();
        nextWaitMilliseconds = renewalIntervalMilliseconds;
        args.onRenewed?.();
        continue;
      }

      args.onRenewalError?.(outcome.error);
      const remainingMilliseconds = safeDeadline - now();
      if (remainingMilliseconds <= 0) {
        markLeaseLost("renewal_expired");
        return;
      }
      nextWaitMilliseconds = Math.min(
        renewalRetryMilliseconds,
        remainingMilliseconds,
      );
    }
  })();

  try {
    try {
      const result = await args.load(work.signal);
      if (leaseLostError) throw leaseLostError;
      args.shutdownSignal.throwIfAborted();
      return result;
    } catch (error) {
      if (leaseLostError) throw leaseLostError;
      throw error;
    }
  } finally {
    clearLeaseDeadline();
    stopRenewing.abort();
    await renewal;
    args.shutdownSignal.removeEventListener("abort", abortForShutdown);
  }
}
