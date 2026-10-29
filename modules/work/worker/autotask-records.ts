export type AutotaskRecord = Record<string, unknown>;

export function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function stringValue(value: unknown) {
  return String(value ?? "").trim();
}

export function mapById(records: AutotaskRecord[]) {
  return new Map(records.map((record) => [numberValue(record.id), record]));
}
