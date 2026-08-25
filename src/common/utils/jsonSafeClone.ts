/**
 * Clone a value into the exact shape `JSON.parse(JSON.stringify(value))` would
 * produce: `undefined`/function/symbol array elements become `null`, object
 * properties holding them are dropped, non-finite numbers become `null`, and
 * `toJSON` is honored. A defensive fallback covers values JSON.stringify
 * cannot serialize at all (BigInt, circular references, throwing getters).
 *
 * Why this exists: tool outputs are persisted as JSON and rehydrated on
 * reload, but the SAME in-memory object is also embedded in the next step's
 * tool-result model message, which the AI SDK validates against a strict
 * JSONValue schema. A non-JSON value that serialization would silently
 * normalize (e.g. `undefined` inside an array) instead fails that validation
 * and kills the live stream with AI_InvalidPromptError — while the retry,
 * rebuilt from rehydrated history, succeeds. Normalizing up front keeps the
 * live and rehydrated shapes identical.
 */
export function jsonSafeClone(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : JSON.parse(serialized);
  } catch {
    // JSON.stringify throws on BigInt, cycles, and throwing getters/toJSON.
    return scrubToJsonSafe(value, new WeakSet());
  }
}

/**
 * Best-effort manual walk for values JSON.stringify rejects. Mirrors JSON
 * semantics where possible; unserializable leaves are replaced instead of
 * thrown on (BigInt → decimal string, revisited ancestor → "[Circular]").
 */
function scrubToJsonSafe(value: unknown, ancestors: WeakSet<object>): unknown {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      // undefined, function, symbol: dropped by the caller (object property)
      // or converted to null (array element), matching JSON.stringify.
      return undefined;
  }
  if (value === null) return null;
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  try {
    const withToJson = value as { toJSON?: unknown };
    if (typeof withToJson.toJSON === "function") {
      try {
        return scrubToJsonSafe((withToJson.toJSON as (key?: string) => unknown)(), ancestors);
      } catch {
        return undefined;
      }
    }
    if (Array.isArray(value)) {
      return value.map((element) => scrubToJsonSafe(element, ancestors) ?? null);
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      let element: unknown;
      try {
        element = (value as Record<string, unknown>)[key];
      } catch {
        continue; // Throwing getter: drop the property, keep the rest.
      }
      const scrubbed = scrubToJsonSafe(element, ancestors);
      if (scrubbed !== undefined) result[key] = scrubbed;
    }
    return result;
  } finally {
    // Remove on the way out so shared (non-cyclic) references still clone;
    // only genuine ancestor revisits are treated as cycles.
    ancestors.delete(value);
  }
}
