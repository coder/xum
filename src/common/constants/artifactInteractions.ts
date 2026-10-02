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
 *
 * Work is bounded too: structured clone keeps shared references, so a tiny posted graph (each
 * level holding the previous one twice) expands exponentially and would freeze the renderer
 * (Codex r10). Every JSON node serializes to at least one byte, so a value with more nodes than
 * ARTIFACT_JSON_MAX_BYTES is over the size cap anyway and is refused after that many visits.
 */
export function isJsonValue(value: unknown): boolean {
  let nodesLeft = ARTIFACT_JSON_MAX_BYTES;
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 64 || --nodesLeft < 0) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (Array.isArray(item)) {
      // Structured clone keeps holes, so `length` can be 2^32 - 1 for a tiny message, and
      // `every` would still walk every hole. Charge each slot up front: a slot (hole or not)
      // serializes to at least one byte plus its comma, so the count stays under the size cap
      // for any value that fits it.
      nodesLeft -= item.length;
      if (nodesLeft < 0) return false;
      return item.every((child) => visit(child, depth + 1));
    }
    if (typeof item !== "object") return false;
    const proto: unknown = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(item).every((child) => visit(child, depth + 1));
  };
  return visit(value, 0);
}

/** Generic sends that carry `muxMetadata.artifactInteraction` are refused with this. */
export const ARTIFACT_INTERACTION_METADATA_RESERVED_MESSAGE =
  "Artifact interaction metadata is reserved for messages sent from the Artifacts tab.";
