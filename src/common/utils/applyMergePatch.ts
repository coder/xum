import { isPlainObject } from "@/common/utils/isPlainObject";

/** A typed RFC 7386 merge patch of `T`: every field optional, `null` deletes it. */
export type MergePatch<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: MergePatch<T[K]> | null }
    : T;

/** RFC 7386 JSON merge patch: objects merge recursively, `null` deletes, anything else replaces. */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) {
    return patch;
  }

  const result: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    // A JSON "__proto__" key would replace the result's prototype instead of adding a field.
    if (key === "__proto__") {
      continue;
    }
    if (value === null) {
      delete result[key];
    } else {
      result[key] = applyMergePatch(result[key], value);
    }
  }
  return result;
}
