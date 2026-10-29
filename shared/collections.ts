/** Group into newly owned arrays without copying a growing bucket on each item. */
export function groupBy<T, K>(items: readonly T[], keyFor: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

export function chunks<T>(values: readonly T[], size: number) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("Chunk size must be a positive integer.");
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}
