import { cacheFreshnessAt, cacheFreshnessWarning, cacheHardExpiryMilliseconds } from "../freshness";
import type { CacheFreshness } from "../freshness";
import type { PlanningDemandSnapshot } from "../demand/model";
import {
  readScheduleSnapshot,
  removeScheduleSnapshot,
  scheduleSnapshotHardExpiryMilliseconds,
  writeScheduleSnapshot,
} from "./schedule-cache";
import type { ScheduleSnapshot } from "../contracts";

const POLL_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 45_000;
const MINIMUM_RESUME_INTERVAL_MS = 5_000;
// Only request admission survives remounts; requests and snapshots have one owner.
const requestStartedAtByKey = new Map<string, number>();

type Snapshot = { generatedAt: string };
export type ReviewCacheState<T> = {
  snapshot: T | null;
  loading: boolean;
  warming: boolean;
  error: string;
};
type Observer<T> = (state: ReviewCacheState<T>) => void;
type Policy<T> = {
  key: string;
  url: string;
  label: string;
  failure: string;
  timeout: string;
  initial?: { snapshot: T; expiresAt: number | null };
  accepted?: (snapshot: T) => void;
  expired?: () => void;
  demand?: boolean;
};

function claimRequestWindow(key: string) {
  const now = Date.now();
  const previous = requestStartedAtByKey.get(key);
  if (previous !== undefined && now - previous < POLL_INTERVAL_MS) {
    return POLL_INTERVAL_MS - (now - previous);
  }
  requestStartedAtByKey.set(key, now);
  for (const [key, startedAt] of requestStartedAtByKey) {
    if (now - startedAt >= POLL_INTERVAL_MS) requestStartedAtByKey.delete(key);
  }
  return 0;
}

function retryAfterMilliseconds(response: Response) {
  const value = response.headers.get("Retry-After");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1_000);
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(1_000, retryAt - Date.now()) : undefined;
}

class CacheResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
    readonly freshness?: CacheFreshness,
  ) {
    super(message);
  }
}

/** Own polling, publication, expiry and cancellation for one cached review view. */
class CachedReviewView<T extends Snapshot> {
  private state: ReviewCacheState<T>;
  private freshness: CacheFreshness | null = null;
  private etag: string | null = null;
  private hardExpiresAt: number | null;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private request?: { controller: AbortController; timer: ReturnType<typeof setTimeout> };
  private generation = 0;
  private active = false;
  private disposed = false;
  private lastStartedAt = 0;
  private nextAllowedAt = 0;
  private firstRequest = true;

  constructor(private policy: Policy<T>, private observe: Observer<T>) {
    this.state = { snapshot: policy.initial?.snapshot ?? null, loading: false, warming: false, error: "" };
    this.hardExpiresAt = policy.initial?.expiresAt ?? null;
    this.armExpiry();
    document.addEventListener("visibilitychange", this.resume);
    window.addEventListener("focus", this.resume);
  }

  setActive(active: boolean) {
    if (this.disposed || this.active === active) return;
    this.active = active;
    const generation = ++this.generation;
    clearTimeout(this.pollTimer);
    this.cancelRequest();
    queueMicrotask(() => {
      if (this.disposed || generation !== this.generation) return;
      this.emit({ loading: active, warming: false, error: "" });
      if (active) this.resume();
    });
  }

  private emit(patch: Partial<ReviewCacheState<T>>) {
    if (this.disposed) return;
    const next = { ...this.state, ...patch };
    if (next.snapshot === this.state.snapshot && next.loading === this.state.loading &&
        next.warming === this.state.warming && next.error === this.state.error) return;
    this.state = next;
    this.observe(this.state);
  }

  private warning() {
    return this.freshness ? cacheFreshnessWarning(this.policy.label, this.freshness) : "";
  }

  private invalidateExpired() {
    if (this.freshness) this.freshness = cacheFreshnessAt(this.freshness);
    if (!(this.hardExpiresAt !== null && Date.now() >= this.hardExpiresAt) &&
        !(this.freshness && !this.freshness.usable)) return false;
    clearTimeout(this.expiryTimer);
    this.hardExpiresAt = null;
    this.etag = null;
    if (this.state.snapshot) this.policy.expired?.();
    this.emit({
      snapshot: null,
      warming: Boolean(this.policy.demand && this.freshness?.status === "missing" && this.freshness.lastError === null),
      error: this.warning() || `${this.policy.label} data is too old to use.`,
    });
    return true;
  }

  private armExpiry() {
    clearTimeout(this.expiryTimer);
    if (this.hardExpiresAt === null) return;
    this.expiryTimer = setTimeout(() => {
      if (!this.disposed) this.invalidateExpired();
    }, Math.max(0, this.hardExpiresAt - Date.now()));
  }

  private setFreshness(freshness: CacheFreshness) {
    this.freshness = cacheFreshnessAt(freshness);
    this.hardExpiresAt = cacheHardExpiryMilliseconds(this.freshness);
    this.armExpiry();
  }

  private schedule(delay = POLL_INTERVAL_MS) {
    clearTimeout(this.pollTimer);
    if (this.disposed || !this.active || document.hidden) return;
    this.pollTimer = setTimeout(() => { void this.run(); }, delay);
  }

  private resume = () => {
    clearTimeout(this.pollTimer);
    if (this.disposed || !this.active || document.hidden || this.request) return;
    const delay = Math.max(0, this.lastStartedAt + MINIMUM_RESUME_INTERVAL_MS - Date.now(), this.nextAllowedAt - Date.now());
    if (delay) this.schedule(delay);
    else void this.run();
  };

  private async run() {
    if (this.disposed || !this.active || document.hidden || this.request) return;
    // Expiry controls what can be displayed, never whether a fresh cache may be read.
    this.invalidateExpired();
    const remountDelay = claimRequestWindow(this.policy.key);
    if (remountDelay) {
      this.emit({ loading: false });
      this.schedule(remountDelay);
      return;
    }
    this.lastStartedAt = Date.now();
    const generation = this.generation;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    const request = this.request = { controller, timer };
    const current = () => !this.disposed && this.active && generation === this.generation;
    let retryAfterMs: number | undefined;
    try {
      const response = await fetch(this.policy.url, {
        signal: controller.signal, cache: "no-store", redirect: "error",
        headers: this.etag ? { "If-None-Match": this.etag } : undefined,
      });
      if (!current()) return;
      if (response.status === 304) {
        if (!this.invalidateExpired()) this.emit({ warming: false, error: this.warning() });
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { cache?: CacheFreshness; detail?: string; message?: string };
        throw new CacheResponseError(body.detail || body.message || this.policy.failure,
          response.status, retryAfterMilliseconds(response), body.cache);
      }
      const { cache, ...payload } = await response.json() as T & { cache: CacheFreshness };
      if (!current()) return;
      this.setFreshness(cache);
      if (this.invalidateExpired()) return;
      const snapshot = payload as unknown as T;
      const changed = snapshot.generatedAt !== this.state.snapshot?.generatedAt;
      this.etag = response.headers.get("ETag");
      this.emit({ ...(changed ? { snapshot } : {}), warming: false, error: this.warning() });
      if (this.firstRequest || changed) this.policy.accepted?.(snapshot);
      this.firstRequest = false;
    } catch (error) {
      if (!current()) return;
      if (error instanceof CacheResponseError) {
        retryAfterMs = error.retryAfterMs;
        if (error.freshness) this.setFreshness(error.freshness);
      }
      if (this.invalidateExpired()) return;
      if (timedOut) this.emit({ warming: false, error: this.policy.timeout });
      else if (!(error instanceof DOMException && error.name === "AbortError")) {
        const warming = Boolean(this.policy.demand && error instanceof CacheResponseError &&
          (error.freshness ? error.freshness.status === "missing" && error.freshness.lastError === null : error.status === 503));
        this.emit({ warming, error: this.warning() || (error instanceof Error ? error.message : String(error)) });
      }
    } finally {
      clearTimeout(timer);
      if (this.request === request) this.request = undefined;
      if (current()) {
        this.emit({ loading: false });
        this.nextAllowedAt = retryAfterMs === undefined ? 0 : Date.now() + retryAfterMs;
        this.schedule(retryAfterMs);
      }
    }
  }

  private cancelRequest() {
    if (!this.request) return;
    clearTimeout(this.request.timer);
    this.request.controller.abort();
    this.request = undefined;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    clearTimeout(this.pollTimer);
    clearTimeout(this.expiryTimer);
    this.cancelRequest();
    document.removeEventListener("visibilitychange", this.resume);
    window.removeEventListener("focus", this.resume);
  }
}

/** Schedule hydration and selection notification stay specific to the selected date. */
export function watchScheduleCache(date: string, observe: Observer<ScheduleSnapshot>, onLoaded: (snapshot: ScheduleSnapshot) => void) {
  const cached = readScheduleSnapshot(date);
  const view = new CachedReviewView({
    key: `schedule:${date}`, url: `/api/autotask-schedule?date=${encodeURIComponent(date)}`,
    label: "Schedule", failure: "Sync failed.", timeout: "Loading the schedule took too long. Please retry.",
    initial: cached ? { snapshot: cached, expiresAt: scheduleSnapshotHardExpiryMilliseconds(cached) } : undefined,
    accepted: (snapshot) => { onLoaded(snapshot); writeScheduleSnapshot(snapshot); },
    expired: () => removeScheduleSnapshot(date),
  }, observe);
  view.setActive(true);
  return view;
}

/** Demand retains its snapshot and expiry while inactive, without reading or sharing requests. */
export function watchPlanningDemandCache(observe: Observer<PlanningDemandSnapshot>) {
  return new CachedReviewView({
    key: "planning-demand", url: "/api/planning-demand", demand: true,
    label: "Unassigned request", failure: "Unassigned requests could not be loaded.",
    timeout: "Loading unassigned requests took too long. Retrying.",
  }, observe);
}
