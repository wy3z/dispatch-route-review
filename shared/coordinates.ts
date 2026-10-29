const EARTH_RADIUS_KM = 6_371;

export const MILES_PER_KM = 0.621371;

export function kilometresToMiles(distanceKm: number) {
  return distanceKm * MILES_PER_KM;
}

export function formatMiles(distanceKm: number, digits = 1) {
  return `${kilometresToMiles(distanceKm).toFixed(digits)} mi`;
}

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two coordinates in kilometres. */
export function haversineKm(
  fromLatitude: number,
  fromLongitude: number,
  toLatitude: number,
  toLongitude: number,
): number {
  const latitudeDelta = toRadians(toLatitude - fromLatitude);
  const longitudeDelta = toRadians(toLongitude - fromLongitude);
  const from = toRadians(fromLatitude);
  const to = toRadians(toLatitude);
  const value =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(from) * Math.cos(to) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(value)));
}
