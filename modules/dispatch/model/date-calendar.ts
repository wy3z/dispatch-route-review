const DAY_MS = 86_400_000;

export function formatYmd(value: Date) {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseYmd(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return formatYmd(parsed) === value ? parsed : null;
}

function shiftMonthClamped(value: Date, monthOffset: number) {
  const targetMonthStart = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + monthOffset, 1),
  );
  const lastDay = new Date(
    Date.UTC(
      targetMonthStart.getUTCFullYear(),
      targetMonthStart.getUTCMonth() + 1,
      0,
    ),
  ).getUTCDate();
  return new Date(
    Date.UTC(
      targetMonthStart.getUTCFullYear(),
      targetMonthStart.getUTCMonth(),
      Math.min(value.getUTCDate(), lastDay),
    ),
  );
}

/** Resolve the next focused calendar date for an accessible date-grid key. */
export function dispatchCalendarDateForKey(
  currentDate: string,
  key: string,
  shiftKey = false,
) {
  const current = parseYmd(currentDate);
  if (!current) return null;

  let next: Date | null = null;
  if (key === "ArrowLeft") {
    next = new Date(current.getTime() - DAY_MS);
  } else if (key === "ArrowRight") {
    next = new Date(current.getTime() + DAY_MS);
  } else if (key === "ArrowUp") {
    next = new Date(current.getTime() - 7 * DAY_MS);
  } else if (key === "ArrowDown") {
    next = new Date(current.getTime() + 7 * DAY_MS);
  } else if (key === "Home" || key === "End") {
    const mondayOffset = (current.getUTCDay() + 6) % 7;
    const offset = key === "Home" ? -mondayOffset : 6 - mondayOffset;
    next = new Date(current.getTime() + offset * DAY_MS);
  } else if (key === "PageUp" || key === "PageDown") {
    const monthOffset = key === "PageUp" ? -1 : 1;
    next = shiftMonthClamped(current, shiftKey ? monthOffset * 12 : monthOffset);
  }

  return next ? formatYmd(next) : null;
}
