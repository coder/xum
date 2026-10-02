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
 * - Wire-schema enums: after the key rules run, an onChat event is checked against
 *   `WorkspaceChatMessageSchema`. Wherever the schema rejects a masked string because it expects
 *   an enum or literal (e.g. `runtimeType`, message `metadata.compacted`), the original value is
 *   restored, but only when the schema itself lists that value. This keeps redacted events
 *   schema-valid without a hand-maintained enum key list, and it can never restore free text.
 * - Exact protocol paths with format constraints keep a valid shape: ISO timestamps in a
 *   workflow run record (of a `workflow-run-attached` event or a tool part's `workflowRun`) stay
 *   as they are (strict ISO-8601 only); in an MCP tool
 *   display snapshot (`mcpServer`), the session-local `iconRef` hash is kept and URL fields
 *   (`app.resourceUri`, `connection.origin`, `identity.websiteUrl`) keep their scheme while the
 *   rest is masked.
 * - Anything else the schema still rejects, or that its `.catch()` fallbacks would silently drop,
 *   is unsupported: `redactChatEvent` throws and the recorder ends that tape. Redaction never
 *   falls back to unredacted data.
 * - Every workspace id (any key ending in `workspaceId`, such as `sourceWorkspaceId`) becomes the
 *   truncated sha256 of its own value, in structural and opaque subtrees alike. The subscription
 *   workspace's id therefore equals the header `workspaceIdHash`; ids of other workspaces get
 *   their own hashes, so sub-agent and source-workspace references stay distinct.
 */

import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas";
import { MCPToolCallDisplaySchema } from "@/common/orpc/schemas/mcp";

export type HashWorkspaceId = (workspaceId: string) => string;

/** An event that shape-v1 cannot redact into a schema-valid, lossless event. */
export class UnsupportedTapeRedactionError extends Error {}

type RedactContext = "default" | "workflowRun";

/** IsoDateTimeSchema fields of WorkflowRunRecordSchema (src/common/orpc/schemas/workflow.ts). */
const WORKFLOW_RUN_TIMESTAMP_KEYS: ReadonlySet<string> = new Set([
  "at",
  "startedAt",
  "completedAt",
  "createdAt",
  "updatedAt",
  "executionStartedAt",
  "softDeadlineAt",
  "hardDeadlineAt",
  "softTimedOutAt",
  "finalizationPromptSentAt",
  "hardTimedOutAt",
]);
const ISO_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** MCPIconRefSchema: a session-local hash, never content. */
const MCP_ICON_REF_PATTERN = /^[a-f0-9]{32}$/;

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
  // Free-form JSON on workflow run events (`run.events[].data` / `.details`).
  "data",
  "details",
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

// No `/` or `.`: a single-token path or file name (`/home/alice/x.txt`) under `reason` must still
// be masked. Enum values here are snake/kebab/camel case (model names use PRESERVED_STRING_KEYS).
const TOKEN_PATTERN = /^[A-Za-z0-9_:-]{1,64}$/;
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
  return redactNode(event, undefined, false, hashWorkspaceId, "default");
}

/**
 * Redact one onChat event: `redactTapeEvent`, then restore the wire-schema enum values the key
 * rules masked (see the module doc), so the result still parses as `WorkspaceChatMessage`.
 */
export function redactChatEvent(
  event: unknown,
  hashWorkspaceId: HashWorkspaceId,
  options: {
    /**
     * Also reject fields the schema's `.catch()` fallbacks drop on re-parse. Only sound when
     * `event` is itself schema parse output (the validated onChat wire path); otherwise unknown
     * keys the schema strips would look like dropped fields.
     */
    detectDroppedFields: boolean;
  }
): unknown {
  const redacted = redactTapeEvent(event, hashWorkspaceId);
  let result = WorkspaceChatMessageSchema.safeParse(redacted);
  if (!result.success) {
    for (const issue of result.error.issues) {
      restoreSchemaEnum(issue, event, redacted);
    }
    result = WorkspaceChatMessageSchema.safeParse(redacted);
  }
  if (!result.success) {
    // Paths and codes only: messages can quote values.
    const where = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.code} at ${issue.path.join(".")}`)
      .join("; ");
    throw new UnsupportedTapeRedactionError(`Redacted event fails the onChat schema: ${where}`);
  }
  if (options.detectDroppedFields) {
    const dropped = findDroppedPath(redacted, result.data, []);
    if (dropped !== null) {
      throw new UnsupportedTapeRedactionError(
        `Redaction breaks a field the onChat schema would drop: ${dropped.join(".")}`
      );
    }
  }
  return redacted;
}

/** First path present in `redacted` but missing (`undefined`) in the schema's parse output. */
function findDroppedPath(redacted: unknown, parsed: unknown, at: string[]): string[] | null {
  if (typeof redacted !== "object" || redacted === null) return null;
  if (typeof parsed !== "object" || parsed === null) return at;
  for (const [key, value] of Object.entries(redacted)) {
    if (value === undefined) continue;
    const parsedValue = (parsed as Record<string, unknown>)[key];
    if (parsedValue === undefined) return [...at, key];
    const dropped = findDroppedPath(value, parsedValue, [...at, key]);
    if (dropped !== null) return dropped;
  }
  return null;
}

interface SchemaIssue {
  code: string;
  path: PropertyKey[];
  values?: unknown[];
  errors?: SchemaIssue[][];
}

/** Put back the original string at `issue.path` when the schema enumerates exactly that value. */
function restoreSchemaEnum(issue: SchemaIssue, original: unknown, redacted: unknown): void {
  const allowed = enumValuesOf(issue);
  if (allowed === null || issue.path.length === 0) return;
  const originalValue = valueAt(original, issue.path);
  if (typeof originalValue !== "string" || !allowed.has(originalValue)) return;
  const parent = valueAt(redacted, issue.path.slice(0, -1));
  const leaf = issue.path[issue.path.length - 1];
  if (typeof parent === "object" && parent !== null && typeof leaf !== "symbol") {
    if (typeof (parent as Record<PropertyKey, unknown>)[leaf] === "string") {
      (parent as Record<PropertyKey, unknown>)[leaf] = originalValue;
    }
  }
}

/**
 * The values an enum/literal issue accepts: `invalid_value` lists them directly; a union of
 * literals (and primitives) reports `invalid_union` whose every branch failed at the same path.
 * Anything else (object unions, nested failures) is not an enum and returns null.
 */
function enumValuesOf(issue: SchemaIssue): Set<unknown> | null {
  if (issue.code === "invalid_value") return new Set(issue.values ?? []);
  if (issue.code !== "invalid_union" || !issue.errors) return null;
  const values = new Set<unknown>();
  for (const branch of issue.errors) {
    for (const branchIssue of branch) {
      if (branchIssue.path.length > 0) return null;
      if (branchIssue.code === "invalid_value") {
        for (const value of branchIssue.values ?? []) values.add(value);
      } else if (branchIssue.code !== "invalid_type") {
        return null;
      }
    }
  }
  return values;
}

function valueAt(root: unknown, keyPath: PropertyKey[]): unknown {
  let current = applyToJson(root, undefined);
  for (const key of keyPath) {
    if (typeof current !== "object" || current === null || typeof key === "symbol") {
      return undefined;
    }
    current = applyToJson((current as Record<PropertyKey, unknown>)[key], String(key));
  }
  return current;
}

function redactNode(
  rawValue: unknown,
  key: string | undefined,
  opaque: boolean,
  hashWorkspaceId: HashWorkspaceId,
  context: RedactContext
): unknown {
  const value = applyToJson(rawValue, key);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (
      context === "workflowRun" &&
      !opaque &&
      key !== undefined &&
      WORKFLOW_RUN_TIMESTAMP_KEYS.has(key) &&
      ISO_DATETIME_PATTERN.test(value)
    ) {
      return value;
    }
    return redactString(value, key, opaque, hashWorkspaceId);
  }
  if (typeof value === "number") return opaque ? 0 : value;
  if (Array.isArray(value)) {
    // Elements inherit the array's key, so e.g. `requestPreludeMessageIds` keeps its ids.
    return value.map((item) => redactNode(item, key, opaque, hashWorkspaceId, context) ?? null);
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
      const childContext: RedactContext =
        context === "workflowRun" ||
        (!opaque &&
          childKey === "run" &&
          // The run record of a workflow-run-attached event or of a tool part's `workflowRun`.
          (record.type === "workflow-run-attached" || key === "workflowRun"))
          ? "workflowRun"
          : "default";
      const redacted =
        !childOpaque && childKey === "mcpServer"
          ? redactMcpDisplay(child, hashWorkspaceId)
          : redactNode(child, childKey, childOpaque, hashWorkspaceId, childContext);
      if (redacted !== undefined) out[childKey] = redacted;
    }
    return out;
  }
  // undefined, functions, symbols, bigint: JSON.stringify omits or rejects these.
  return undefined;
}

/**
 * MCPToolCallDisplaySchema snapshot: masked like any structure, then its format-constrained
 * protocol references get valid shapes so the schema's `.catch()` does not drop them.
 */
function redactMcpDisplay(display: unknown, hashWorkspaceId: HashWorkspaceId): unknown {
  const redacted = redactNode(display, "mcpServer", false, hashWorkspaceId, "default");
  const source = applyToJson(display, "mcpServer");
  if (!isRecord(redacted) || !isRecord(source)) return redacted;
  if (typeof source.iconRef === "string" && MCP_ICON_REF_PATTERN.test(source.iconRef)) {
    redacted.iconRef = source.iconRef;
  }
  keepScheme(source.app, redacted.app, "resourceUri", "ui://");
  keepScheme(source.connection, redacted.connection, "origin", "https://");
  keepScheme(source.identity, redacted.identity, "websiteUrl", "https://");
  // The onChat schema wraps this snapshot in `.catch(undefined)`, which hides enum issues from
  // redactChatEvent; restore them against the snapshot schema itself.
  const result = MCPToolCallDisplaySchema.safeParse(redacted);
  if (!result.success) {
    for (const issue of result.error.issues) restoreSchemaEnum(issue, source, redacted);
  }
  return redacted;
}

/** `scheme` + masked remainder, when the original value starts with `scheme`. */
function keepScheme(source: unknown, redacted: unknown, key: string, scheme: string): void {
  if (!isRecord(source) || !isRecord(redacted)) return;
  const value = source[key];
  if (typeof value === "string" && value.startsWith(scheme) && typeof redacted[key] === "string") {
    redacted[key] = scheme + maskTapeText(value.slice(scheme.length));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
