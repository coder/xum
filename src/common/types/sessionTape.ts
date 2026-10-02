/**
 * Session tape contract (experiment `sessionTapes`).
 *
 * A session tape is a JSONL file holding what one `workspace.onChat` subscription delivered to
 * the client, with original timing and content masking. The backend recorder
 * (`src/node/services/sessionTapes/`) writes it; perf replay and perf E2E harnesses read it.
 *
 * Privacy boundary: tapes are private, local (`<root>/perf/tapes/`), and recorded only while the
 * experiment is on (off by default). Masking is NOT anonymization (see below). Real tapes must
 * never be committed, attached to GitHub, or uploaded, and they are excluded from any diagnostics
 * bundle, including the planned "Report slowness" bundle. Fixtures and evidence use synthetic
 * sessions only.
 *
 * File layout, one JSON object per line:
 * 1. Header (`SessionTapeHeaderSchema`): always the first line.
 * 2. Zero or more event lines (`SessionTapeEventLineSchema`), in delivery order.
 *    - `t`: milliseconds from subscription start to the moment the recorder saw the event, taken
 *      before that event's own capture work. Capture work (masking and one serialization) runs
 *      before the event reaches the consumer, so later offsets include the capture time of
 *      earlier events. Offsets are original timing plus that measured instrumentation overhead.
 *    - `bytes`: UTF-8 byte length of the stored `event` JSON (the masked event exactly as written
 *      on this line).
 *    - `event`: the masked onChat event.
 * 3. An optional trailer (`SessionTapeTrailerSchema`): `reason` is `closed`, `truncated` (a size
 *    cap was hit: the events before the first one that did not fit are complete and gap-free, and
 *    `droppedEvents` counts what was delivered afterwards but not recorded) or `error` (the
 *    subscription failed, or an event could not be captured; the prefix is still gap-free).
 *    A missing trailer or a partial final line means the tape is incomplete (the process died or
 *    a write failed).
 *
 * Masking ("content-v1", `src/node/services/sessionTapes/contentMask.ts`): only content fields
 * are masked, per event type: message and reasoning text, streamed text deltas, tool
 * input/output payloads, error and free-text messages, queued/held prompt text, review note
 * text, todo text, and data-URL attachment payloads. In masked text every letter becomes `x` and
 * every digit `0` with the UTF-16 length kept, so Markdown structure, whitespace and punctuation
 * survive. All structural fields are verbatim: ids (`id`, `messageId`, `toolCallId`,
 * `historyId`, workspace ids, ...), `historySequence`, `type`, `role`, part `state`, `toolName`,
 * enums, timestamps, URLs and origins, model names, usage, metadata (including `muxMetadata`,
 * provider metadata, snapshots, MCP display data and workflow run records). URLs and metadata can
 * still hold sensitive values; that is why the privacy boundary above applies.
 *
 * Replay contract (what a replay loader, e.g. T2, must do):
 * - Check the header first: reject a tape whose `tape` version or `masking` value it does not
 *   support.
 * - Parse every line with the line schemas below. Before parsing an event with
 *   `WorkspaceChatMessageSchema`, revive Date-typed fields from their ISO strings (message
 *   `createdAt`, also inside `message-batch` rows): JSON has no Date type.
 * - Validate every event. If any line or event is invalid, reject the tape or flag it as
 *   invalid. Never drop individual events silently. Flag incomplete (no trailer or a partial
 *   line), `truncated` and `error` tapes the same explicit way.
 * - Reproduce every recorded event in order and at its `t` offset: history rows (`message` and
 *   `message-batch`), `caught-up`, `delete`, stream, tool-call and reasoning events, queue,
 *   usage and other live events, and heartbeats. Ids are verbatim, so the real reducer sees the
 *   same structure as live.
 * - Known limitation: masked tool arguments can fail a renderer's per-tool argument validation,
 *   so such tool cards may render in their fallback state on replay.
 * - Never execute recorded tools, contact recorded provider endpoints or URLs, or treat masked
 *   text as real content.
 * - A reconnect is a new tape file with the same `sessionId` and the next `subscriptionSeq`.
 *   Tapes contain no synthetic reconnect events, and `sessionId` correlation ends at a backend
 *   restart. `subscriptionSeq` is allocated when the subscription starts, so a missing seq means
 *   the tape was deleted (retention or by hand) or its recording failed before anything reached
 *   disk; a failed recording is logged as a "Session tape recording stopped" warning that names
 *   the tape path.
 */
import { z } from "zod";

export const SESSION_TAPE_VERSION = 1;
export const SESSION_TAPE_MASKING = "content-v1";

/** A masked onChat event (or subscription mode): any object with its `type` discriminator. */
const RedactedTypedObjectSchema = z.looseObject({ type: z.string() });

export const SessionTapeHeaderSchema = z.object({
  tape: z.literal(SESSION_TAPE_VERSION),
  xumVersion: z.string(),
  /** Stable for one workspace session within one backend process; shared by reconnect tapes. */
  sessionId: z.string().min(1),
  /** 1 for the first subscription of `sessionId`, then incremented per subscription. */
  subscriptionSeq: z.number().int().positive(),
  /**
   * Truncated sha256 of the subscription's workspace id, for grouping and file names. Events
   * carry workspace ids verbatim (they are structural).
   */
  workspaceIdHash: z.string().min(1),
  startedAt: z.iso.datetime(),
  masking: z.literal(SESSION_TAPE_MASKING),
  /** Subscription input flags; `mode` (replay strategy and cursor ids) is kept verbatim. */
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
