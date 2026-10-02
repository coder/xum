/**
 * "shape-v1" redaction for session tapes (see `src/common/types/sessionTape.ts`).
 *
 * This is NOT anonymization. It keeps structure, lengths and protocol metadata so perf replay
 * exercises the same reducer, layout and virtualization paths, but it changes what tokenizers
 * and highlighters see. Real tapes must never be committed or attached to GitHub; fixtures and
 * UAT evidence use synthetic sessions only.
 *
 * Rules:
 * - Text: every Unicode letter (and combining mark) becomes `x`, every decimal digit `0`, with
 *   the UTF-16 length preserved (a supplementary-plane letter becomes `xx`). Whitespace,
 *   punctuation, symbols and Markdown syntax stay as they are.
 * - Keys, booleans, null and array lengths stay as they are.
 * - Schema-aware preservation instead of a global key allowlist: protocol fields (ids, `type`,
 *   `role`, `state`, `model`, timestamps, enum-like tokens, numbers) are kept only on the
 *   event/message/part structure. That structure includes the `metadata` of messages and of
 *   `stream-end`/`stream-abort` events (model, agentId, thinkingLevel, usage, historySequence),
 *   so redacted events still parse against `WorkspaceChatMessageSchema`. Inside opaque payload subtrees (tool input/output, error
 *   payloads, provider metadata, free-form metadata blobs) every string is masked even under an
 *   `id`/`type`/`model` key, and every number becomes 0.
 * - Every `workspaceId` (any key ending in `workspaceId`) becomes the same truncated hash as the
 *   tape header, in structural and opaque subtrees alike.
 */

export type HashWorkspaceId = (workspaceId: string) => string;

/** Keys whose subtree is an opaque payload rather than protocol structure. */
const OPAQUE_KEYS: ReadonlySet<string> = new Set([
  "input",
  "args",
  "output",
  "result",
  "error",
  "errors",
  "providerMetadata",
  "contextProviderMetadata",
  "callProviderMetadata",
  "providerOptions",
  "muxMetadata",
  "cmuxMetadata",
  "toolPolicy",
  "retrySendOptions",
]);

/** Structural string fields kept verbatim (ids, discriminators, model names, timestamps). */
const PRESERVED_STRING_KEYS: ReadonlySet<string> = new Set([
  "type",
  "role",
  "state",
  "toolName",
  "model",
  "metadataModel",
  "requestedModel",
  "requestedFallbackModel",
  "refusedModels",
  "routeProvider",
  "mediaType",
  "createdAt",
  "startedAt",
  "updatedAt",
  "timestamp",
  "compactionReplacementNonce",
  "compactionPublicationGeneration",
  "rangeFingerprint",
  "priorHistoryFingerprint",
]);

/**
 * Structural enum-like fields. Kept only when the value looks like a single token, because some
 * of these keys carry an enum in one event and free text in another (e.g. `reason`).
 */
const TOKEN_STRING_KEYS: ReadonlySet<string> = new Set([
  "errorType",
  "reason",
  "abortReason",
  "downgradeReason",
  "decision",
  // Thinking-level escalations on `autoModelRouting` records.
  "from",
  "to",
  "status",
  "phase",
  "kind",
  "source",
  "mode",
  "finishReason",
  "stopReason",
  "queueDispatchMode",
  "thinkingLevel",
  "reasoningMode",
  "replay",
  "historyReplayStatus",
  "action",
  "contextBoundaryKind",
]);

const TOKEN_PATTERN = /^[A-Za-z0-9_.:/-]{1,64}$/;
/** `id`, `ids`, and camelCase id fields such as `messageId`, `toolCallId`, `requestIds`. */
const ID_KEY_PATTERN = /^(?:id|ids|.+Ids?)$/;
const WORKSPACE_ID_KEY_PATTERN = /workspaceId$/i;
const NON_ASCII_PATTERN = /[^\x00-\x7F]/; // eslint-disable-line no-control-regex
const ASCII_LETTER_PATTERN = /[A-Za-z]/g;
const ASCII_DIGIT_PATTERN = /[0-9]/g;
const UNICODE_LETTER_PATTERN = /[\p{L}\p{M}]/gu;
const UNICODE_DIGIT_PATTERN = /\p{Nd}/gu;

/** Mask text: letters → `x`, digits → `0`, preserving UTF-16 length. */
function maskTapeText(text: string): string {
  if (!NON_ASCII_PATTERN.test(text)) {
    return text.replace(ASCII_LETTER_PATTERN, "x").replace(ASCII_DIGIT_PATTERN, "0");
  }
  return text
    .replace(UNICODE_LETTER_PATTERN, (match) => "x".repeat(match.length))
    .replace(UNICODE_DIGIT_PATTERN, (match) => "0".repeat(match.length));
}

/**
 * Redact one onChat event (or the subscription `mode`) into a plain JSON value. Follows
 * `JSON.stringify` semantics for non-JSON values: `toJSON()` is applied (so Dates become ISO
 * strings), and `undefined`, functions and symbols are omitted (or `null` inside arrays).
 */
export function redactTapeEvent(event: unknown, hashWorkspaceId: HashWorkspaceId): unknown {
  return redactNode(event, undefined, false, hashWorkspaceId);
}

function redactNode(
  rawValue: unknown,
  key: string | undefined,
  opaque: boolean,
  hashWorkspaceId: HashWorkspaceId
): unknown {
  const value = applyToJson(rawValue, key);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return redactString(value, key, opaque, hashWorkspaceId);
  if (typeof value === "number") return opaque ? 0 : value;
  if (Array.isArray(value)) {
    // Elements inherit the array's key, so e.g. `requestPreludeMessageIds` keeps its ids.
    return value.map((item) => redactNode(item, key, opaque, hashWorkspaceId) ?? null);
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // The `metadata` of a message or of a stream-end/stream-abort event is protocol structure
    // (historySequence, model, usage); any other `metadata` is a free-form blob. Opaque keys
    // inside it (providerMetadata, muxMetadata) stay opaque.
    const hasStructuralMetadata =
      !opaque &&
      (typeof record.role === "string" ||
        record.type === "stream-end" ||
        record.type === "stream-abort");
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(record)) {
      const childOpaque =
        opaque || OPAQUE_KEYS.has(childKey) || (childKey === "metadata" && !hasStructuralMetadata);
      const redacted = redactNode(child, childKey, childOpaque, hashWorkspaceId);
      if (redacted !== undefined) out[childKey] = redacted;
    }
    return out;
  }
  // undefined, functions, symbols, bigint: JSON.stringify omits or rejects these.
  return undefined;
}

function applyToJson(value: unknown, key: string | undefined): unknown {
  if (typeof value === "object" && value !== null) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return (toJSON as (key: string) => unknown).call(value, key ?? "");
    }
  }
  return value;
}

function redactString(
  value: string,
  key: string | undefined,
  opaque: boolean,
  hashWorkspaceId: HashWorkspaceId
): string {
  if (key === undefined) return maskTapeText(value);
  if (WORKSPACE_ID_KEY_PATTERN.test(key)) return hashWorkspaceId(value);
  if (!opaque) {
    if (PRESERVED_STRING_KEYS.has(key) || ID_KEY_PATTERN.test(key)) return value;
    if (TOKEN_STRING_KEYS.has(key) && TOKEN_PATTERN.test(value)) return value;
  }
  return maskTapeText(value);
}
