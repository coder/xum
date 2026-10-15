/**
 * Whether persisted `metadata.stepStartPartIndices` can be trusted: safe integers in strictly
 * ascending order that start at 0. Every producer seeds the list with 0 (the first step), so a
 * list without it is corrupted.
 */
export function isTrustedStepStartList(indices: unknown): indices is number[] {
  return (
    Array.isArray(indices) &&
    indices[0] === 0 &&
    indices.every(
      (index: unknown, position) =>
        typeof index === "number" &&
        Number.isSafeInteger(index) &&
        index >= 0 &&
        (position === 0 || index > (indices[position - 1] as number))
    )
  );
}
