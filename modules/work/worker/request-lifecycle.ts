const OUTBOUND_REQUEST_TIMEOUT_MS = 15 * 1000;

export function outboundRequestSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Reject when provider work is cancelled. */
export function abortableWait(milliseconds: number, signal?: AbortSignal) {
  if (milliseconds <= 0) return Promise.resolve();
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    function finish() {
      cleanup();
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Resolve when a worker/renewal loop should stop waiting. */
export function waitForAbort(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) finish();
  });
}
