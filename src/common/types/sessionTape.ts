/**
 * Session tape contract (experiment `sessionTapes`).
 *
 * A session tape is a JSONL file holding what one `workspace.onChat` subscription delivered to
 * the client, with original timing and content masking. The backend recorder
 * (`src/node/services/sessionTapes/`) writes it; perf replay and perf E2E harnesses read it.
 *
 * Privacy boundary: tapes are private (directory 0700, files 0600), local (`<root>/perf/tapes/`),
 * and recorded only while the experiment is on (off by default). Turning the experiment off stops
 * new tapes but does not delete existing ones (retention runs when a tape opens or closes);
 * delete the directory to remove them. Masking is NOT anonymization (see below). Real tapes must
 * never be committed, attached to GitHub, or uploaded, and they are excluded from any diagnostics
 * bundle, including the planned "Report slowness" bundle. Fixtures and evidence use synthetic
 * sessions only.
 *
 * File layout, one JSON object per line:
 * 1. Header (`SessionTapeHeaderSchema`): always the first line.
 * 2. Zero or more event lines (`SessionTapeEventLineSchema`), in delivery order.
 *    - `t`: milliseconds from subscription start to the moment the recorder saw the event, taken
 *      before that event's own capture work. The recorder sees an event when the consumer pulls
 *      it, so events the runtime had buffered (replay bursts, backpressure) get closely spaced
 *      offsets. Capture work (masking and one serialization) runs before the event reaches the
 *      consumer, so later offsets also include the capture time of earlier events.
 *    - `event` and optional `meta`: the masked onChat event in oRPC's RPC JSON encoding
 *      (`RPCJsonSerializer` from `@orpc/client`, with undefined-valued properties kept): `event`
 *      is the `json` part, `meta` lists the paths of values JSON cannot carry (Dates, undefined,
 *      BigInt, NaN, Map, Set, URL, RegExp).
 *    - `bytes`: UTF-8 byte length of the stored `event` JSON on this line (without `meta`). Masked
 *      text keeps its UTF-16 length, not its UTF-8 length, so non-ASCII content is smaller than
 *      live.
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
 * text, todo text, data-URL attachment payloads, and the user-typed text inside `muxMetadata`
 * (`rawCommand`, skill `arguments`, compaction follow-up content). In masked text every letter becomes `x` and
 * every digit `0` with the UTF-16 length kept, so Markdown structure, whitespace and punctuation
 * survive. All structural fields are verbatim: ids (`id`, `messageId`, `toolCallId`,
 * `historyId`, workspace ids, ...), `historySequence`, `type`, `role`, part `state`, `toolName`,
 * enums, timestamps, URLs, origins and file paths (e.g. `init-start.hookPath`), model names,
 * usage, and the rest of the metadata (provider metadata, snapshots, MCP display data, workflow
 * run records). URLs, paths and metadata can still hold sensitive values; that is why the
 * privacy boundary above applies.
 *
 * Replay contract (what a replay loader, e.g. T2, must do):
 * - Check the header first: reject a tape whose `tape` version or `masking` value it does not
 *   support.
 * - Parse every line with the line schemas below, decode each event with
 *   `new RPCJsonSerializer().deserialize({ json: line.event, meta: line.meta })`, and validate
 *   the result with `WorkspaceChatMessageSchema`.
 * - Validate every event. If any line or event is invalid, reject the tape or flag it as
 *   invalid. Never drop individual events silently. Flag incomplete (no trailer or a partial
 *   line), `truncated` and `error` tapes the same explicit way.
 * - Reproduce every recorded event in order and at its `t` offset: history rows (`message` and
 *   `message-batch`), `caught-up`, `delete`, stream, tool-call and reasoning events, queue,
 *   usage and other live events, and heartbeats. Ids are verbatim, so the real reducer sees the
 *   same structure as live.
 * - Known limitations: masked tool arguments can fail a renderer's per-tool argument validation,
 *   so such tool cards may render in their fallback state on replay, and state the renderer
 *   derives from tool payloads (todos, review pins, agent status, skill reads) is not reproduced.
 *   Tool payloads are masked as JSON values: a non-JSON object inside one (Map, Set, URL) is
 *   stored as its enumerable own properties, usually `{}`.
 * - A tape whose header `subscription.mode` is `since` or `live` is a delta on top of the client
 *   state its earlier tapes built: replay it only after the earlier `subscriptionSeq` tapes of
 *   the same `sessionId`, or flag it as dependent. History the client loads later through
 *   `loadOlderHistory` (with `replayWindow`) is a separate request and is not on the tape.
 * - Never execute recorded tools, contact recorded provider endpoints or URLs, or treat masked
 *   text as real content.
 * - A reconnect is a new tape file with the same `sessionId` and the next `subscriptionSeq`.
 *   Tapes contain no synthetic reconnect events. `sessionId` belongs to one in-memory workspace
 *   session, so correlation ends when that session is recreated or the backend restarts. `subscriptionSeq` is allocated when the subscription starts, so a missing seq means
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
  /** oRPC RPC JSON meta: `[type, ...path]` entries for values JSON cannot carry. */
  meta: z.array(z.array(z.union([z.string(), z.number()]))).optional(),
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
