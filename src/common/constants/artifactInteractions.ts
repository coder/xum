/**
 * Limits for artifact interactions (Artifacts M5b). Shared by the frame bridge (renderer) and
 * the backend routes, which validate again: the renderer is not the trust boundary for the
 * session files.
 */
export const ARTIFACT_SEND_TEXT_MAX_CHARS = 4000;
/** Serialized JSON size cap for `send` data and `setState` state. */
export const ARTIFACT_JSON_MAX_BYTES = 16 * 1024;
/** artifact_list shows at most this much of the latest version's state. */
export const ARTIFACT_STATE_SUMMARY_MAX_CHARS = 2048;
/** Selected text captured by annotate mode inside a sandboxed frame. */
export const ARTIFACT_ANNOTATION_QUOTE_MAX_CHARS = 500;
/** Context kept on each side of an annotated quote, so the agent can find it again. */
export const ARTIFACT_ANNOTATION_CONTEXT_CHARS = 32;
/** CSS selector of the element a pin was dropped on (sandboxed frames). */
export const ARTIFACT_ANNOTATION_SELECTOR_MAX_CHARS = 200;

/** UTF-8 size of JSON.stringify(value); null when it is not JSON-serializable. */
export function jsonByteLength(value: unknown): number | null {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (text === undefined) return null;
  return new TextEncoder().encode(text).length;
}

/**
 * True for plain JSON data: null, booleans, finite numbers, strings, arrays and plain objects.
 * Structured clone (postMessage) also carries Maps, Dates, typed arrays and the like, which
 * JSON.stringify would silently reshape; those are refused. Depth is bounded so a hostile value
 * cannot exhaust the stack.
 */
export function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

/** Generic sends that carry `muxMetadata.artifactInteraction` are refused with this. */
export const ARTIFACT_INTERACTION_METADATA_RESERVED_MESSAGE =
  "Artifact interaction metadata is reserved for messages sent from the Artifacts tab.";
