import assert from "node:assert/strict";
import test from "node:test";
import { groupBy, chunks } from "../shared/collections";
import { jsonObject, readJsonObject, UUID } from "../shared/http";
import { abortableWait, waitForAbort, outboundRequestSignal } from "../modules/work/worker/request-lifecycle";
import { railTooltipPosition } from "../modules/dispatch/ui/RailTooltips";

test("grouping and batches preserve order without mutating caller-owned collections", () => {
  const items = Object.freeze([{ key: "b", value: 1 }, { key: "a", value: 2 }, { key: "b", value: 3 }]);
  const grouped = groupBy(items, item => item.key);
  assert.deepEqual([...grouped.keys()], ["b", "a"]);
  assert.deepEqual(grouped.get("b"), [items[0], items[2]]);
  grouped.get("b")!.pop();
  assert.equal(items.length, 3);
  assert.deepEqual(chunks(items, 2), [[items[0], items[1]], [items[2]]]);
  assert.deepEqual(chunks([], 2), []);
  for (const size of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => chunks(items, size), RangeError);
});

test("administrative JSON parsing rejects malformed and non-object bodies", async () => {
  for (const input of [null, [], 1, false, "text"]) assert.equal(jsonObject(input), null);
  const record = { role: "viewer" };
  assert.equal(jsonObject(record), record);
  for (const body of ["{", "null", "[]", "true"]) {
    assert.equal(await readJsonObject(new Request("https://test.invalid", { method: "POST", body })), null);
  }
  assert.deepEqual(await readJsonObject(new Request("https://test.invalid", { method: "POST", body: JSON.stringify(record) })), record);
  assert.equal(UUID.test("12345678-1234-4123-a123-123456789abc"), true);
  assert.equal(UUID.test("invalid-user-id"), false);
});

test("provider cancellation rejects while worker-loop cancellation resolves", async () => {
  const controller = new AbortController();
  const reason = new Error("stopped");
  const provider = abortableWait(60_000, controller.signal);
  const rejected = assert.rejects(provider, error => error === reason);
  const worker = waitForAbort(60_000, controller.signal);
  const request = outboundRequestSignal(controller.signal);
  controller.abort(reason);
  await rejected;
  await worker;
  await waitForAbort(60_000, controller.signal);
  assert.throws(() => abortableWait(1, controller.signal), error => error === reason);
  assert.equal(request.aborted, true);
  assert.equal(request.reason, reason);
  await abortableWait(0);
  await abortableWait(1);
  await waitForAbort(1, new AbortController().signal);
});

test("rail tooltips retain wide, narrow and viewport-edge positioning", () => {
  const rect = { left: 150, right: 250, top: 300 };
  assert.deepEqual(railTooltipPosition(rect, { right: 400, width: 400 }, { width: 1440, height: 1000 }), { left: 412, top: 300 });
  assert.deepEqual(railTooltipPosition(rect, { right: 700, width: 700 }, { width: 1440, height: 1000 }), { left: 262, top: 300 });
  assert.deepEqual(railTooltipPosition({ left: 1100, right: 1200, top: 950 }, undefined, { width: 1440, height: 1000 }), { left: 668, top: 610 });
  assert.deepEqual(railTooltipPosition(rect, undefined, { width: 390, height: 300 }), { left: 12, top: 12 });
});
