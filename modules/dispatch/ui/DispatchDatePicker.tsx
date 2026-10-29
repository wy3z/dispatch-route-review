"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { dispatchCalendarDateForKey, formatYmd } from "../model/date-calendar";
import { londonCalendarDate } from "../../../shared/calendar";

const dayFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", dateStyle: "full" });

const monthFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});

type Props = {
  date: string;
  onChange: (date: string) => void;
  onDismiss?: () => void;
};

type ScheduleDaySummary = {
  date: string;
  complete: number;
  scheduled: number;
};

type CalendarDay = {
  value: string;
  day: number;
  inMonth: boolean;
};

type DateGridCellProps = {
  day: CalendarDay;
  selectedDate: string;
  today: string;
  focusedDate: string;
  summary?: ScheduleDaySummary;
  onChoose: (date: string) => void;
  onFocusedDateChange: (date: string) => void;
  onVisibleMonthChange: (month: string) => void;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function parseYmd(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function DispatchDateGridCell({
  day,
  selectedDate,
  today,
  focusedDate,
  summary,
  onChoose,
  onFocusedDateChange,
  onVisibleMonthChange,
}: DateGridCellProps) {
  const totalsTooltip = summary
    ? `Booked: ${summary.scheduled}\nCompleted: ${summary.complete}`
    : undefined;

  function moveFocusedDate(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const currentDate = event.currentTarget.dataset.date;
    if (!currentDate) return;
    const nextDate = dispatchCalendarDateForKey(
      currentDate,
      event.key,
      event.shiftKey,
    );
    if (!nextDate) return;
    event.preventDefault();
    event.stopPropagation();
    onFocusedDateChange(nextDate);
    onVisibleMonthChange(nextDate.slice(0, 7));
  }

  return (
    <button
      type="button"
      role="gridcell"
      className={`${day.inMonth ? "" : " outside"}${day.value === selectedDate ? " selected" : ""}${day.value === today ? " today" : ""}`}
      data-date={day.value}
      aria-label={dayFormatter.format(parseYmd(day.value))}
      aria-selected={day.value === selectedDate}
      aria-current={day.value === today ? "date" : undefined}
      title={totalsTooltip}
      tabIndex={day.value === focusedDate ? 0 : -1}
      onKeyDown={moveFocusedDate}
      onClick={() => onChoose(day.value)}
    >
      {day.day}
    </button>
  );
}

export function DispatchDatePicker({
  date,
  onChange,
  onDismiss,
}: Props) {
  const [visibleMonth, setVisibleMonth] = useState(() => date.slice(0, 7));
  const [focusedDate, setFocusedDate] = useState(date);
  const [scheduleDays, setScheduleDays] = useState<ReadonlyMap<string, ScheduleDaySummary>>(
    () => new Map(),
  );
  const calendarRef = useRef<HTMLDivElement>(null);

  const calendarDays = useMemo(() => {
    const [year, month] = visibleMonth.split("-").map(Number);
    const first = new Date(Date.UTC(year, month - 1, 1));
    const mondayOffset = (first.getUTCDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, index): CalendarDay => {
      const value = new Date(Date.UTC(year, month - 1, index - mondayOffset + 1));
      return {
        value: formatYmd(value),
        day: value.getUTCDate(),
        inMonth: value.getUTCMonth() === month - 1,
      };
    });
  }, [visibleMonth]);

  const monthLabel = useMemo(() => {
    const [year, month] = visibleMonth.split("-").map(Number);
    return monthFormatter.format(new Date(Date.UTC(year, month - 1, 1)));
  }, [visibleMonth]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/autotask-schedule?month=${encodeURIComponent(visibleMonth)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Calendar totals could not be loaded.");
        return response.json() as Promise<{ days?: ScheduleDaySummary[] }>;
      })
      .then(({ days }) => {
        if (controller.signal.aborted) return;
        setScheduleDays(new Map((days ?? []).map((day) => [day.date, day])));
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setScheduleDays(new Map());
      });
    return () => controller.abort();
  }, [visibleMonth]);

  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => {
      calendarRef.current
        ?.querySelector<HTMLButtonElement>(`button[data-date="${focusedDate}"]`)
        ?.focus();
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [focusedDate, visibleMonth]);

  function moveMonth(offset: number) {
    const [year, month] = visibleMonth.split("-").map(Number);
    const next = new Date(Date.UTC(year, month - 1 + offset, 1));
    setVisibleMonth(formatYmd(next).slice(0, 7));
  }

  function chooseDate(nextDate: string) {
    onChange(nextDate);
    setVisibleMonth(nextDate.slice(0, 7));
    setFocusedDate(nextDate);
    onDismiss?.();
  }

  const today = londonCalendarDate();

  const calendar = (
    <div
      className="dispatch-date-popover"
      id="dispatch-date-calendar"
      ref={calendarRef}
      role="group"
      aria-label="Choose review date"
    >
      <header>
        <button type="button" aria-label="Previous month" onClick={() => moveMonth(-1)}>‹</button>
        <strong aria-live="polite">{monthLabel}</strong>
        <button type="button" aria-label="Next month" onClick={() => moveMonth(1)}>›</button>
      </header>
      <div className="dispatch-date-weekdays" role="row" aria-hidden="true">
        {WEEKDAYS.map((weekday) => <span role="columnheader" key={weekday}>{weekday}</span>)}
      </div>
      <div className="dispatch-date-days" role="grid" aria-label={monthLabel}>
        {calendarDays.map((day) => (
          <DispatchDateGridCell
            key={day.value}
            day={day}
            selectedDate={date}
            today={today}
            focusedDate={focusedDate}
            summary={day.inMonth ? scheduleDays.get(day.value) : undefined}
            onChoose={chooseDate}
            onFocusedDateChange={setFocusedDate}
            onVisibleMonthChange={setVisibleMonth}
          />
        ))}
      </div>
      <footer>
        <button type="button" onClick={() => chooseDate(today)}>Today</button>
      </footer>
    </div>
  );

  return (
    <div className="dispatch-date-picker embedded">
      {calendar}
    </div>
  );
}
