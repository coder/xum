/**
 * Session tape contract (experiment `sessionTapes`).
 *
 * A session tape is a JSONL file holding exactly what one `workspace.onChat` subscription
 * delivered to the client, with original timing and redacted text. The backend recorder
 * (`src/node/services/sessionTapes/`) writes it; perf replay and perf E2E harnesses read it.
 *
 * File layout, one JSON object per line:
 * 1. Header (`SessionTapeHeaderSchema`): always the first line.
 * 2. Zero or more event lines (`SessionTapeEventLineSchema`), in delivery order. `t` is the
 *    millisecond offset from subscription start, measured when the event left the backend and
 *    before redaction. `bytes` is the UTF-8 byte length of the ORIGINAL (unredacted) serialized
 *    event, so payload-size effects survive redaction.
 * 3. An optional trailer (`SessionTapeTrailerSchema`). A missing trailer or a partial final
 *    line means the tape is incomplete (the process died or a write failed; write failures cannot
 *    guarantee a trailer). Parsers must tolerate both and treat the tape as incomplete.
 *    `truncated: true` means the recorder hit a memory or size cap and stopped at the first
 *    event that did not fit: the events before it are complete and gap-free, and
 *    `droppedEvents` counts the events delivered after that point but not recorded.
 *
 * Replay contract:
 * - A replay must reproduce, in order and at the original `t` offsets, every recorded event:
 *   history replay rows (single `message` rows and `message-batch` rows), `caught-up`,
 *   `delete`, stream events (`stream-start`/`stream-delta`/`stream-end`/`stream-abort`/
 *   `stream-error`, tool-call events, reasoning events), queue, usage and other live events,
 *   and heartbeats.
 * - Redaction ("shape-v1") preserves protocol structure: event `type`, message ids,
 *   `historyId`/`historySequence`, `messageId`, `toolCallId`, `toolName`, part `type`/`state`,
 *   `role`, `model`, timestamps, enum-like fields (e.g. `abortReason`, `thinkingLevel`, and any
 *   value `WorkspaceChatMessageSchema` declares as an enum or literal, such as `runtimeType`) and
 *   numeric protocol metadata, including the `metadata` of messages and `stream-end`/
 *   `stream-abort` events. Redacted events therefore still parse against
 *   `WorkspaceChatMessageSchema`, and the real reducer must behave identically on a replayed
 *   tape. Text keeps its length and Markdown/punctuation
 *   structure but letters become `x` and digits `0`.
 * - JSON has no Date type: Date-typed fields (message `createdAt`, `z.date()` in the schema)
 *   are written as ISO strings, so a replay must revive them before parsing an event with
 *   `WorkspaceChatMessageSchema`.
 * - A reconnect is a new tape file with the same `sessionId` and the next `subscriptionSeq`.
 *   Tapes contain no synthetic reconnect events. `sessionId` correlation ends at a backend
 *   restart. `subscriptionSeq` is allocated when the subscription starts, so a missing seq
 *   means the tape was deleted (retention or by hand) or its recording failed before anything
 *   reached disk (e.g. an unwritable tapes dir); a failed recording is logged as a
 *   "Session tape recording stopped" warning that names the tape path.
 * - Replay consumers must NEVER execute recorded tools, contact recorded provider endpoints, or
 *   treat redacted text as real content.
 * - Redaction is NOT anonymization. Real tapes must never be committed or attached to GitHub;
 *   fixtures and evidence use synthetic sessions only.
 */
import { z } from "zod";

export const SESSION_TAPE_VERSION = 1;
export const SESSION_TAPE_REDACTION = "shape-v1";

/** A redacted object that still carries its protocol discriminator. */
const RedactedTypedObjectSchema = z.looseObject({ type: z.string() });

export const SessionTapeHeaderSchema = z.object({
  tape: z.literal(SESSION_TAPE_VERSION),
  xumVersion: z.string(),
  /** Stable for one workspace session within one backend process; shared by reconnect tapes. */
  sessionId: z.string().min(1),
  /** 1 for the first subscription of `sessionId`, then incremented per subscription. */
  subscriptionSeq: z.number().int().positive(),
  /**
   * Truncated sha256 of the subscription's workspace id. Recorded `workspaceId` fields of this
   * workspace carry the same hash; other workspace ids (e.g. `sourceWorkspaceId`) carry their own.
   */
  workspaceIdHash: z.string().min(1),
  startedAt: z.iso.datetime(),
  redaction: z.literal(SESSION_TAPE_REDACTION),
  /** Non-sensitive subscription input flags. `mode` is shape-redacted like events. */
  subscription: z.object({
    mode: RedactedTypedObjectSchema.optional(),
    batchReplay: z.boolean().optional(),
    replayWindow: z.boolean().optional(),
    validateOutput: z.boolean(),
  }),
});

export const SessionTapeEventLineSchema = z.object({
  t: z.number().nonnegative(),
  bytes: z.number().int().nonnegative(),
  event: RedactedTypedObjectSchema,
});

export const SessionTapeEndReasonSchema = z.enum(["closed", "truncated", "error"]);

export const SessionTapeTrailerSchema = z.object({
  t: z.number().nonnegative(),
  end: z.object({
    reason: SessionTapeEndReasonSchema,
    truncated: z.boolean(),
    droppedEvents: z.number().int().nonnegative(),
  }),
});

export const SessionTapeLineSchema = z.union([
  SessionTapeHeaderSchema,
  SessionTapeEventLineSchema,
  SessionTapeTrailerSchema,
]);

export type SessionTapeHeader = z.infer<typeof SessionTapeHeaderSchema>;
export type SessionTapeEventLine = z.infer<typeof SessionTapeEventLineSchema>;
export type SessionTapeEndReason = z.infer<typeof SessionTapeEndReasonSchema>;
export type SessionTapeTrailer = z.infer<typeof SessionTapeTrailerSchema>;
export type SessionTapeLine = z.infer<typeof SessionTapeLineSchema>;
