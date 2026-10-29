import assert from "node:assert/strict";
import test from "node:test";
import {
  isCacheRefreshLeaseLostError,
  loadWithCacheRefreshLease,
} from "../modules/work/worker/refresh-lease";

function rejectWhenAborted(signal: AbortSignal, onAbort?: () => void) {
  return new Promise<never>((_resolve, reject) => {
    const rejectAborted = () => {
      onAbort?.();
      reject(signal.reason);
    };
    signal.addEventListener("abort", rejectAborted, { once: true });
    if (signal.aborted) rejectAborted();
  });
}

test("definitive lease loss aborts an in-flight refresh load", async () => {
  let loadAborted = false;
  const result = loadWithCacheRefreshLease({
    leaseDurationMilliseconds: 60_000,
    shutdownSignal: new AbortController().signal,
    renewLease: async () => false,
    load: (signal) =>
      rejectWhenAborted(signal, () => {
        loadAborted = true;
      }),
    wait: async () => {},
  });

  await assert.rejects(result, (error: unknown) => {
    assert.equal(isCacheRefreshLeaseLostError(error), true);
    if (isCacheRefreshLeaseLostError(error)) {
      assert.equal(error.reason, "renewal_rejected");
    }
    return true;
  });
  assert.equal(loadAborted, true);
});

test("transient renewal failure retries while the lease is still safe", async () => {
  let now = 0;
  let renewCalls = 0;
  let renewalErrors = 0;
  let leaseLosses = 0;
  let finishLoad = () => {};
  const loadMayFinish = new Promise<void>((resolve) => {
    finishLoad = resolve;
  });

  const result = loadWithCacheRefreshLease({
    leaseDurationMilliseconds: 60_000,
    shutdownSignal: new AbortController().signal,
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
    renewLease: async () => {
      renewCalls += 1;
      if (renewCalls === 1) throw new Error("temporary database error");
      finishLoad();
      return true;
    },
    load: async (signal) => {
      await loadMayFinish;
      signal.throwIfAborted();
      return "loaded";
    },
    onRenewalError: () => {
      renewalErrors += 1;
    },
    onLeaseLost: () => {
      leaseLosses += 1;
    },
  });

  assert.equal(await result, "loaded");
  assert.equal(renewCalls, 2);
  assert.equal(renewalErrors, 1);
  assert.equal(leaseLosses, 0);
});

test("repeated renewal errors abort once the lease is no longer safe", async () => {
  let now = 0;
  let renewCalls = 0;
  const result = loadWithCacheRefreshLease({
    leaseDurationMilliseconds: 60_000,
    shutdownSignal: new AbortController().signal,
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
    renewLease: async () => {
      renewCalls += 1;
      throw new Error("database still unavailable");
    },
    load: rejectWhenAborted,
  });

  await assert.rejects(result, (error: unknown) => {
    assert.equal(isCacheRefreshLeaseLostError(error), true);
    if (isCacheRefreshLeaseLostError(error)) {
      assert.equal(error.reason, "renewal_expired");
    }
    return true;
  });
  assert.ok(renewCalls > 1);
  assert.ok(now >= 55_000);
});

test("a hung renewal cannot keep provider work alive past the safe lease deadline", async () => {
  let loadAborted = false;
  const startedAt = Date.now();
  const result = loadWithCacheRefreshLease({
    leaseDurationMilliseconds: 50,
    shutdownSignal: new AbortController().signal,
    wait: async () => {},
    renewLease: () => new Promise<boolean>(() => {}),
    load: (signal) =>
      rejectWhenAborted(signal, () => {
        loadAborted = true;
      }),
  });

  await assert.rejects(result, (error: unknown) => {
    assert.equal(isCacheRefreshLeaseLostError(error), true);
    if (isCacheRefreshLeaseLostError(error)) {
      assert.equal(error.reason, "renewal_expired");
    }
    return true;
  });
  assert.equal(loadAborted, true);
  assert.ok(Date.now() - startedAt < 1_000);
});
