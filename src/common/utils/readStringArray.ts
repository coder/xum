/** The string entries of an untrusted value; anything that is not an array reads as empty. */
export function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
