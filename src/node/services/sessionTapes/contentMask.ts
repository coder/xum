/**
 * "content-v1" masking for session tapes (contract: `src/common/types/sessionTape.ts`).
 *
 * This is content masking, NOT anonymization. One table below names, per onChat event type, the
 * fields that carry prose or payload content: message and reasoning text, streamed text deltas,
 * tool input/output payloads, error and free-text messages, queued/held prompt text, review note
 * text, todo text and data-URL attachment payloads. Only those are masked. Everything else is
 * structural and kept verbatim: ids, enums, timestamps, URLs and origins, model names, usage,
 * metadata (including `muxMetadata`, provider metadata, snapshots and workflow run records).
 * URLs and metadata can still hold sensitive values, so real tapes stay private and local: never
 * commit, attach or upload them.
 *
 * Masking: every Unicode letter becomes `x` and every decimal digit `0`, keeping the UTF-16
 * length; whitespace, punctuation, symbols and Markdown syntax stay. Payloads (`unknown`-typed
 * tool arguments/results) are masked deeply: keys, numbers, booleans and null stay, every string
 * is masked. Masked tool arguments can fail a renderer's per-tool argument validation: that is a
 * replay limitation (production validation is unchanged, and there are no per-tool maskers).
 *
 * The table is a `Record` over the event union, so a new onChat event type does not compile until
 * someone decides which of its fields are content.
 */
import type { WorkspaceChatMessage } from "@/common/orpc/types";

type ChatEventType = WorkspaceChatMessage["type"];
type JsonRecord = Record<string, unknown>;
type Mask = (value: unknown) => unknown;
type FieldMasks = Readonly<Record<string, Mask>>;

const UNICODE_LETTER_PATTERN = /[\p{L}\p{M}]/gu;
const UNICODE_DIGIT_PATTERN = /\p{Nd}/gu;
const ASCII_LETTER_PATTERN = /[A-Za-z]/g;
const ASCII_DIGIT_PATTERN = /[0-9]/g;
const NON_ASCII_PATTERN = /[^\x00-\x7F]/; // eslint-disable-line no-control-regex

/** The event's content alone exceeds the caller's size budget; nothing was serialized. */
export class TapeEventTooLargeError extends Error {}

/**
 * Remaining content characters for the event being masked. Content dominates large events
 * (history boundary rows can reach 64 MiB), so checking it before the regex work lets the
 * recorder refuse such an event without masking or serializing it. Reset per maskTapeEvent call;
 * masking is synchronous, so no other call can interleave.
 */
let contentBudget = Number.POSITIVE_INFINITY;

/** Letters → `x`, digits → `0`, UTF-16 length preserved (a supplementary letter becomes `xx`). */
function maskText(text: string): string {
  contentBudget -= text.length;
  if (contentBudget < 0) throw new TapeEventTooLargeError("Event content exceeds the size budget");
  if (!NON_ASCII_PATTERN.test(text)) {
    return text.replace(ASCII_LETTER_PATTERN, "x").replace(ASCII_DIGIT_PATTERN, "0");
  }
  return text
    .replace(UNICODE_LETTER_PATTERN, (match) => "x".repeat(match.length))
    .replace(UNICODE_DIGIT_PATTERN, (match) => "0".repeat(match.length));
}

function isRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

const maskString: Mask = (value) => (typeof value === "string" ? maskText(value) : value);

/** Deep copy of an `unknown` payload with every string masked; keys and non-strings kept. */
const maskPayload: Mask = (value) => {
  if (typeof value === "string") return maskText(value);
  if (Array.isArray(value)) return value.map(maskPayload);
  if (isRecord(value)) {
    const out: JsonRecord = {};
    for (const [key, child] of Object.entries(value)) out[key] = maskPayload(child);
    return out;
  }
  return value;
};

/** Copy `record` with each present field in `masks` replaced by its masked value. */
function maskFields(record: JsonRecord, masks: FieldMasks): JsonRecord {
  const out = { ...record };
  for (const [field, mask] of Object.entries(masks)) {
    if (out[field] !== undefined) out[field] = mask(out[field]);
  }
  return out;
}

/** Mask the given fields of a record value; non-records pass through. */
const inRecord =
  (masks: FieldMasks): Mask =>
  (value) =>
    isRecord(value) ? maskFields(value, masks) : value;

/** Mask each item of an array value; non-arrays pass through. */
const each =
  (mask: Mask): Mask =>
  (value) =>
    Array.isArray(value) ? value.map(mask) : value;

/** Data URLs carry attachment bytes: keep `data:<type>;base64,` and mask the payload. */
const maskFileUrl: Mask = (value) => {
  if (typeof value !== "string" || !value.startsWith("data:")) return value;
  const comma = value.indexOf(",");
  return comma < 0 ? maskText(value) : value.slice(0, comma + 1) + maskText(value.slice(comma + 1));
};

const maskFilePart = inRecord({ url: maskFileUrl, filename: maskString });
const maskReview = inRecord({
  selectedCode: maskString,
  selectedDiff: maskString,
  userNote: maskString,
});
const maskToolCall = inRecord({ input: maskPayload, output: maskPayload });

/** Message parts: text/reasoning text, tool input/output (incl. nested calls), file data. */
const maskPart: Mask = (part) => {
  if (!isRecord(part)) return part;
  switch (part.type) {
    case "text":
    case "reasoning":
      return maskFields(part, { text: maskString });
    case "file":
      return maskFilePart(part);
    case "dynamic-tool":
      return maskFields(part, {
        input: maskPayload,
        output: maskPayload,
        nestedCalls: each(maskToolCall),
      });
    default:
      // Not a schema part type: mask it whole rather than guess which fields are content.
      return { ...(maskPayload(part) as JsonRecord), type: part.type };
  }
};

const maskParts = each(maskPart);

const MESSAGE_FIELDS: FieldMasks = {
  parts: maskParts,
  metadata: inRecord({
    error: maskString,
    contextBudgetRejectedMessage: inRecord({ parts: maskParts }),
  }),
};
const maskMessage = inRecord(MESSAGE_FIELDS);

/** `null`: the event type carries no content fields and is recorded verbatim. */
const CONTENT_FIELDS: Record<ChatEventType, FieldMasks | null> = {
  "prefix-swap-invalidated": null,
  heartbeat: null,
  "caught-up": {
    windowSeed: inRecord({
      todos: each(inRecord({ content: maskString })),
      assistedReview: each(inRecord({ comment: maskString })),
    }),
  },
  "stream-error": { error: maskString },
  delete: null,
  "stream-lifecycle": null,
  "stream-start": null,
  "stream-delta": { delta: maskString },
  "stream-end": { parts: maskParts },
  "stream-abort": null,
  "tool-call-start": { args: maskPayload },
  "tool-call-execution-start": null,
  "tool-call-delta": { delta: maskPayload },
  "tool-call-end": { result: maskPayload },
  "bash-output": { text: maskString },
  "advisor-phase": null,
  "advisor-output": { text: maskString },
  "advisor-reasoning-output": { text: maskString },
  "task-created": null,
  "workflow-run-attached": null,
  "reasoning-delta": { delta: maskString },
  "reasoning-end": null,
  error: { error: maskString },
  "session-usage-delta": null,
  "usage-delta": null,
  "init-start": null,
  "init-output": { line: maskString },
  "init-progress": null,
  "init-end": null,
  message: MESSAGE_FIELDS,
  "message-batch": { messages: each(maskMessage) },
  "goal-budget-limited": { message: maskString },
  "queued-message-changed": {
    displayText: maskString,
    queuedMessages: each(maskString),
    fileParts: each(maskFilePart),
    reviews: each(maskReview),
  },
  "restore-to-input": {
    text: maskString,
    fileParts: each(maskFilePart),
    reviews: each(maskReview),
  },
  "held-inputs-changed": { heldInputs: each(inRecord({ displayText: maskString })) },
  "auto-compaction-triggered": null,
  "auto-compaction-completed": null,
  "auto-retry-scheduled": null,
  "auto-retry-starting": null,
  "auto-retry-abandoned": { reason: maskString },
  "runtime-status": { detail: maskString },
};

/**
 * Mask one onChat event. Returns new objects along every masked path and shares the untouched
 * structure with `event`. Unknown event types (outside the schema) are masked whole, keeping
 * only `type`. Throws TapeEventTooLargeError as soon as the masked content passes
 * `maxContentChars` (UTF-16 units).
 */
export function maskTapeEvent(event: WorkspaceChatMessage, maxContentChars: number): JsonRecord {
  contentBudget = maxContentChars;
  const record: JsonRecord = event;
  const type = record.type;
  if (typeof type === "string" && Object.hasOwn(CONTENT_FIELDS, type)) {
    const masks = CONTENT_FIELDS[type as ChatEventType];
    return masks ? maskFields(record, masks) : record;
  }
  return { ...(maskPayload(record) as JsonRecord), type };
}
