const londonTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder}m`;
  return `${hours}h${remainder ? ` ${remainder}m` : ""}`;
}

export function formatTime(value: string) {
  return londonTimeFormatter.format(new Date(value));
}
