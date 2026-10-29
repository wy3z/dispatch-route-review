function stringValue(value: unknown) {
  return String(value ?? "").trim();
}

export function postcodeKey(value: string) {
  return value.toUpperCase().replace(/\s+/g, "");
}

export function locationPostcode(location: Record<string, unknown>) {
  const combined = [
    location.postalCode,
    location.address1,
    location.address2,
    location.city,
    location.state,
  ]
    .map(stringValue)
    .filter(Boolean)
    .join(" ");
  const ukMatch = combined.match(
    /\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i,
  )?.[0];
  if (!ukMatch) return stringValue(location.postalCode);
  const compact = postcodeKey(ukMatch);
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}
