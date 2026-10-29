const londonCalendarFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const londonDateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function londonCalendarDate(value = new Date()) {
  return londonCalendarFormatter.format(value);
}

export function isIsoCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function addIsoCalendarDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

export function londonLocalMidnightUtc(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = londonDateTimeFormatter.formatToParts(new Date(instant));
    const byType = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    const rendered = Date.UTC(
      Number(byType.year),
      Number(byType.month) - 1,
      Number(byType.day),
      Number(byType.hour),
      Number(byType.minute),
      Number(byType.second),
    );
    const adjustment = target - rendered;
    instant += adjustment;
    if (!adjustment) break;
  }
  return instant;
}
