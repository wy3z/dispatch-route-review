import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { describeCacheFreshness } from "../modules/work/freshness";
import { londonCalendarDate } from "../shared/calendar";
import type { PlanningDemandSnapshot } from "../modules/work/demand/model";
import {
  watchPlanningDemandCache,
  watchScheduleCache,
} from "../modules/work/client/review-cache-view";
import type { ReviewCacheState } from "../modules/work/client/review-cache-view";
import { readScheduleSnapshot, writeScheduleSnapshot } from "../modules/work/client/schedule-cache";
import type { ScheduleSnapshot } from "../modules/work/contracts";

type Kind = "schedule" | "planning_demand";
type Snapshot = ScheduleSnapshot | PlanningDemandSnapshot;
let clockSequence = 0;

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function fixture(t: TestContext) {
  // Admission is deliberately module-local across owners. Each test advances
  // beyond earlier tests' claims, as a browser session does over time.
  const now = Date.parse("2026-09-07T10:00:00Z") + clockSequence++ * 86_400_000;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const document = Object.assign(new EventTarget(), { hidden: false });
  const storage = new Map<string, string>();
  const window = Object.assign(new EventTarget(), {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
  });
  const originals = ["window", "document", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  const calls: { url: string; init: RequestInit }[] = [];
  let respond: (url: string, init: RequestInit) => Promise<Response> = async () => { throw new Error("Unexpected request"); };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  } });
  const owners: { dispose(): void }[] = [];
  t.after(() => {
    for (const owner of owners) owner.dispose();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const date = londonCalendarDate();
  function snapshot(kind: Kind): Snapshot {
    const generatedAt = new Date().toISOString();
    return kind === "schedule"
      ? { source: "autotask", date, generatedAt, visits: [], warnings: [] }
      : { source: "postgres-planning-demand-cache", scopeDate: date, generatedAt, warnings: [], items: [],
        counts: { total: 0, mapped: 0, unmapped: 0, eligible: 0, blocked: 0, aged: 0, overdue: 0 } };
  }
  function response(kind: Kind, payload = snapshot(kind), etag = '"v1"', refreshedAt = payload.generatedAt) {
    const cache = describeCacheFreshness(kind, date, {
      sourceRefreshedAt: refreshedAt, refreshedAt, expiresAt: new Date(Date.now() + 300_000).toISOString(),
      lastError: null, consecutiveFailures: 0, stale: false,
    });
    return Response.json({ ...payload, cache }, { headers: { ETag: etag } });
  }
  function start(kind: Kind) {
    const updates: ReviewCacheState<Snapshot>[] = [];
    const accepted: ScheduleSnapshot[] = [];
    const observe = (state: ReviewCacheState<Snapshot>) => { updates.push(state); };
    const view = kind === "schedule"
      ? watchScheduleCache(date, observe, snapshot => { accepted.push(snapshot); })
      : watchPlanningDemandCache(observe);
    view.setActive(true);
    owners.push(view);
    return { view, updates, accepted, state: () => updates.at(-1)! };
  }
  return {
    date, calls, storage, document, window, snapshot, response, start,
    respond: (next: typeof respond) => { respond = next; },
    tick: async (ms: number) => { t.mock.timers.tick(ms); await flush(); },
  };
}

for (const kind of ["schedule", "planning_demand"] as const) {
  test(`${kind} automatically publishes changed snapshots and keeps unchanged snapshot identity`, async t => {
    const f = fixture(t);
    const original = f.snapshot(kind);
    f.respond(async () => f.response(kind, original));
    const owner = f.start(kind);
    await flush();
    const published = owner.state().snapshot;
    assert.deepEqual(published, original);
    assert.equal(owner.state().loading, false);
    f.respond(async () => new Response(null, { status: 304 }));
    await f.tick(29_999);
    assert.equal(f.calls.length, 1);
    await f.tick(1);
    assert.equal(f.calls.length, 2);
    assert.equal(new Headers(f.calls[1].init.headers).get("If-None-Match"), '"v1"');
    assert.equal(owner.state().snapshot, published);
    f.respond(async () => f.response(kind, original));
    await f.tick(30_000);
    assert.equal(owner.state().snapshot, published, "equal 200 version must not rebuild derived routes");
    const changed = { ...f.snapshot(kind), warnings: ["Updated cached results"] };
    f.respond(async () => f.response(kind, changed, '"v2"'));
    await f.tick(30_000);
    assert.deepEqual(owner.state().snapshot, changed);
    assert.notEqual(owner.state().snapshot, published);
    if (kind === "schedule") assert.equal(owner.accepted.length, 2);
    assert.ok(f.calls.every(call => call.init.cache === "no-store" && call.init.redirect === "error"));
  });

  test(`${kind} removes expired data while hidden and automatically recovers`, async t => {
    const f = fixture(t);
    const old = f.snapshot(kind);
    f.respond(async () => f.response(kind, old, '"old"', new Date(Date.now() - 1_790_000).toISOString()));
    const owner = f.start(kind);
    await flush();
    f.document.hidden = true;
    f.document.dispatchEvent(new Event("visibilitychange"));
    await f.tick(10_000);
    assert.equal(owner.state().snapshot, null);
    assert.match(owner.state().error, /too old/);
    if (kind === "schedule") assert.equal(readScheduleSnapshot(f.date), null);
    await f.tick(30_000);
    assert.equal(f.calls.length, 1, "hidden pages must not poll");
    const fresh = f.snapshot(kind);
    f.respond(async () => f.response(kind, fresh, '"new"'));
    f.document.hidden = false;
    f.document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    assert.equal(f.calls.length, 2, "expiry must not prevent checking for a fresh snapshot");
    assert.equal(new Headers(f.calls[1].init.headers).has("If-None-Match"), false);
    assert.deepEqual(owner.state().snapshot, fresh);
    assert.equal(owner.state().error, "");
  });

  test(`${kind} retries a missing cache and respects Retry-After across focus`, async t => {
    const f = fixture(t);
    f.respond(async () => Response.json({ cache: describeCacheFreshness(kind, f.date, null) },
      { status: 503, headers: { "Retry-After": "120" } }));
    const owner = f.start(kind);
    await flush();
    assert.equal(owner.state().snapshot, null);
    if (kind === "planning_demand") assert.equal(owner.state().warming, true);
    await f.tick(30_000);
    f.window.dispatchEvent(new Event("focus"));
    await flush();
    assert.equal(f.calls.length, 1);
    f.respond(async () => f.response(kind));
    await f.tick(90_000);
    assert.equal(f.calls.length, 2);
    assert.ok(owner.state().snapshot);
    assert.equal(owner.state().warming, false);
    assert.equal(owner.state().error, "");
  });
}

test("rapid remounts are bounded and schedule and demand claims stay independent", async t => {
  const f = fixture(t);
  f.respond(async url => f.response(url.includes("planning-demand") ? "planning_demand" : "schedule"));
  const first = f.start("schedule");
  await flush();
  first.view.dispose();
  const remounted = f.start("schedule");
  const demand = f.start("planning_demand");
  await flush();
  assert.equal(f.calls.length, 2);
  assert.ok(remounted.state().snapshot, "schedule remount hydrates from session storage");
  assert.ok(demand.state().snapshot);
  await f.tick(30_000);
  assert.equal(f.calls.length, 4);
});

test("demand pause retains valid data and validators, but expiry still clears it", async t => {
  const f = fixture(t);
  f.respond(async () => f.response("planning_demand"));
  const owner = f.start("planning_demand");
  await flush();
  const retained = owner.state().snapshot;
  owner.view.setActive(false);
  await flush();
  assert.equal(owner.state().snapshot, retained);
  assert.equal(owner.state().loading, false);
  await f.tick(30_000);
  assert.equal(f.calls.length, 1);
  f.respond(async () => new Response(null, { status: 304 }));
  owner.view.setActive(true);
  await flush();
  assert.equal(f.calls.length, 2);
  assert.equal(owner.state().snapshot, retained);
  assert.equal(new Headers(f.calls[1].init.headers).get("If-None-Match"), '"v1"');
  owner.view.setActive(false);
  await flush();
  await f.tick(1_770_000);
  assert.equal(owner.state().snapshot, null);
  assert.equal(f.calls.length, 2);
});

test("Retry-After without freshness and repeated focus cannot amplify requests", async t => {
  const f = fixture(t);
  f.respond(async () => Response.json({ message: "Rate limited" }, { status: 429, headers: { "Retry-After": new Date(Date.now() + 120_000).toUTCString() } }));
  const owner = f.start("schedule");
  await flush();
  for (let i = 0; i < 3; i++) {
    await f.tick(30_000);
    f.window.dispatchEvent(new Event("focus"));
    await flush();
  }
  assert.equal(f.calls.length, 1);
  assert.equal(owner.state().error, "Rate limited");
  f.respond(async () => f.response("schedule"));
  await f.tick(30_000);
  assert.equal(f.calls.length, 2);
  assert.ok(owner.state().snapshot);
});

test("timeout reports an error and retries; disposal aborts without late publication", async t => {
  const f = fixture(t);
  f.respond((_url, init) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  const owner = f.start("schedule");
  await flush();
  await f.tick(45_000);
  assert.match(owner.state().error, /too long/);
  f.respond(async () => f.response("schedule"));
  await f.tick(30_000);
  assert.ok(owner.state().snapshot);
  let deliver!: (response: Response) => void;
  f.respond(() => new Promise(resolve => { deliver = resolve; }));
  await f.tick(30_000);
  owner.view.dispose();
  const updateCount = owner.updates.length;
  assert.equal(f.calls.at(-1)!.init.signal!.aborted, true);
  deliver(f.response("schedule"));
  await flush();
  await f.tick(120_000);
  f.window.dispatchEvent(new Event("focus"));
  await flush();
  assert.equal(owner.updates.length, updateCount);
  assert.equal(f.calls.length, 3);
});

test("an obsolete response body cannot publish into a reactivated demand view", async t => {
  const f = fixture(t);
  let deliverBody!: (body: unknown) => void;
  const delayed = f.response("planning_demand");
  delayed.json = () => new Promise(resolve => { deliverBody = resolve; });
  f.respond(async () => delayed);
  const owner = f.start("planning_demand");
  await flush();
  owner.view.setActive(false);
  await flush();
  await f.tick(30_000);
  const latest = f.snapshot("planning_demand");
  f.respond(async () => f.response("planning_demand", latest));
  owner.view.setActive(true);
  await flush();
  assert.deepEqual(owner.state().snapshot, latest);
  const count = owner.updates.length;
  deliverBody(await f.response("planning_demand", { ...latest, generatedAt: "obsolete" }).json());
  await flush();
  assert.equal(owner.updates.length, count);
  assert.deepEqual(owner.state().snapshot, latest);
});

test("unchanged hydrated schedule still notifies selection on its first successful response", async t => {
  const f = fixture(t);
  const snapshot = f.snapshot("schedule") as ScheduleSnapshot;
  writeScheduleSnapshot(snapshot);
  f.respond(async () => f.response("schedule", snapshot));
  const owner = f.start("schedule");
  await flush();
  assert.equal(owner.accepted.length, 1);
  assert.deepEqual(owner.accepted[0], snapshot);
});
