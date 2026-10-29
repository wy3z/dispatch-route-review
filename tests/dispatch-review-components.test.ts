import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DispatchDateGridCell,
  DispatchDatePicker,
} from "../modules/dispatch/ui/DispatchDatePicker";
import {
  isDispatchReviewDemandDateEligible,
} from "../modules/dispatch/state/use-dispatch-review-data";
import { dispatchCalendarDateForKey } from "../modules/dispatch/model/date-calendar";

test("embedded DispatchDatePicker renders an accessible six-week date grid", () => {
  const html = renderToStaticMarkup(
    createElement(DispatchDatePicker, {
      date: "2026-08-31",
      onChange: () => undefined,
    }),
  );

  assert.match(html, /role="group"[^>]*aria-label="Choose review date"/);
  assert.match(html, /role="grid"[^>]*aria-label="August 2026"/);
  assert.equal((html.match(/role="gridcell"/g) ?? []).length, 42);
  assert.match(
    html,
    /data-date="2026-08-31"[^>]*aria-selected="true"[^>]*tabindex="0"/,
  );
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1);
  assert.match(html, /aria-label="Previous month"/);
  assert.match(html, /aria-label="Next month"/);
});

test("date-grid keyboard navigation follows calendar semantics", () => {
  assert.equal(
    dispatchCalendarDateForKey("2026-08-31", "ArrowLeft"),
    "2026-08-30",
  );
  assert.equal(
    dispatchCalendarDateForKey("2026-08-31", "ArrowRight"),
    "2026-09-01",
  );
  assert.equal(
    dispatchCalendarDateForKey("2026-08-31", "ArrowUp"),
    "2026-08-24",
  );
  assert.equal(
    dispatchCalendarDateForKey("2026-08-31", "ArrowDown"),
    "2026-09-07",
  );
  assert.equal(dispatchCalendarDateForKey("2026-09-02", "Home"), "2026-08-31");
  assert.equal(dispatchCalendarDateForKey("2026-09-02", "End"), "2026-09-06");
  assert.equal(
    dispatchCalendarDateForKey("2026-03-31", "PageUp"),
    "2026-02-28",
  );
  assert.equal(
    dispatchCalendarDateForKey("2028-02-29", "PageDown", true),
    "2029-02-28",
  );
  assert.equal(dispatchCalendarDateForKey("2026-02-30", "ArrowRight"), null);
  assert.equal(dispatchCalendarDateForKey("2026-08-31", "Enter"), null);
});

test("date-grid cell wires keyboard movement into focus and visible month state", () => {
  const focusedDates: string[] = [];
  const visibleMonths: string[] = [];
  let prevented = false;
  let stopped = false;
  const cell = DispatchDateGridCell({
    day: { value: "2026-08-31", day: 31, inMonth: true },
    selectedDate: "2026-08-31",
    today: "2026-08-20",
    focusedDate: "2026-08-31",
    onChoose: () => undefined,
    onFocusedDateChange: (value) => focusedDates.push(value),
    onVisibleMonthChange: (value) => visibleMonths.push(value),
  });
  const props = cell.props as {
    tabIndex: number;
    onKeyDown: (event: {
      currentTarget: { dataset: { date: string } };
      key: string;
      shiftKey: boolean;
      preventDefault: () => void;
      stopPropagation: () => void;
    }) => void;
  };

  assert.equal(props.tabIndex, 0);
  props.onKeyDown({
    currentTarget: { dataset: { date: "2026-08-31" } },
    key: "ArrowRight",
    shiftKey: false,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  });

  assert.deepEqual(focusedDates, ["2026-09-01"]);
  assert.deepEqual(visibleMonths, ["2026-09"]);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

test("dispatch demand is limited to today and future London weekdays", () => {
  const now = new Date("2026-08-20T12:00:00Z");
  assert.equal(isDispatchReviewDemandDateEligible("2026-08-19", now), false);
  assert.equal(isDispatchReviewDemandDateEligible("2026-08-22", now), false);
  assert.equal(isDispatchReviewDemandDateEligible("2026-08-20", now), true);
  assert.equal(isDispatchReviewDemandDateEligible("2026-08-21", now), true);
});
