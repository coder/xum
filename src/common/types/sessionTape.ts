/**
 * Session tape contract (experiment `sessionTapes`).
 *
 * A session tape is a JSONL file holding what one full-replay `workspace.onChat` subscription
 * delivered to the client, with original timing. The backend recorder
 * (`src/node/services/sessionTapes/`) writes it; perf replay and perf E2E harnesses read it.
 *
 * Privacy boundary: tapes are NOT masked. They contain the full chat as delivered: message and
 * reasoning text, tool inputs and outputs, attachments, errors and all metadata. Treat every tape
 * as fully sensitive. The boundary is that recording is off by default (experiment
 * `sessionTapes`) and tapes stay local and private (`<root>/perf/tapes/`, directory 0700, files
 * 0600). Tapes are never uploaded, never part of a diagnostics bundle (including the planned
 * "Report slowness" bundle), and never committed or attached to GitHub as evidence. Test
 * fixtures and evidence use synthetic sessions only. Turning the experiment off stops new tapes
 * but does not delete existing ones; delete the directory to remove them.
 *
 * What is captured:
 * - Only full replays: a subscription whose `mode` is `since` or `live` is never recorded (it is
 *   a delta on client state no tape holds). Every tape stands alone, with its own `tapeId`;
 *   tapes are not chained.
 * - Capture starts on the first read from the subscription and ends when the subscription ends,
 *   when the recorder is explicitly stopped (reason `stopped`), or at the next delivered event
 *   after the experiment is turned off (also `stopped`; heartbeats arrive every few seconds).
 * - The tape is held in memory until it ends, then written once, atomically (temp file + rename).
 *   A normal quit writes open captures (bounded by about a second). A backend that dies, or a
 *   quit whose writes take longer, loses its open captures: there is no partial tape on disk.
 *
 * Files:
 * - Finalized tapes are `<startedAt>-<workspaceIdHash>-<tapeId>.jsonl`. Loaders read only names
 *   ending in `.jsonl`; a name with anything after `.jsonl` (e.g. `.jsonl.<hex>`) is an
 *   unfinished temp file and must be rejected.
 * - Retention runs after each tape is written. It keeps the 20 most recently written tapes within
 *   200 MiB and deletes older ones. A temp file left by a crash during a write is deleted by a
 *   later retention run once it is 10 minutes old.
 *
 * File layout, one JSON object per line:
 * 1. Header (`SessionTapeHeaderSchema`): always the first line.
 * 2. Zero or more event lines (`SessionTapeEventLineSchema`), in delivery order.
 *    - `t`: milliseconds from the first read to the moment the recorder saw the event, taken
 *      before that event's own capture work. The recorder sees an event when the consumer pulls
 *      it, so events the runtime had buffered (replay bursts, backpressure) get closely spaced
 *      offsets. Capture work (one serialization) runs before the event reaches the consumer, so
 *      later offsets also include the capture time of earlier events.
 *    - `event` and optional `meta`: the onChat event in oRPC's RPC JSON encoding
 *      (`RPCJsonSerializer` from `@orpc/client`, with undefined-valued properties kept): `event`
 *      is the `json` part, `meta` lists the paths of values JSON cannot carry (Dates, undefined,
 *      BigInt, NaN, Map, Set, URL, RegExp).
 *    - `bytes`: UTF-8 byte length of the stored `event` JSON on this line (without `meta`).
 * 3. The trailer (`SessionTapeTrailerSchema`), always the last line of a finalized tape.
 *    `reason` is `closed` (the subscription ended), `stopped` (explicit stop or experiment off
 *    while the subscription went on) or `error` (the subscription failed, or an event could not
 *    be serialized). `truncated` means a size cap was hit: the events before the first one that
 *    did not fit are complete and gap-free, and `droppedEvents` counts what was delivered
 *    afterwards but not recorded.
 *
 * Replay contract (what a replay loader, e.g. T2, must do):
 * - Check the header first: reject a tape whose `tape` version or `masking` value it does not
 *   support. Version 3 tapes have `masking: "none"` (full content).
 * - Parse every line with the line schemas below, decode each event with
 *   `new RPCJsonSerializer().deserialize({ json: line.event, meta: line.meta })`, and validate
 *   the result with `WorkspaceChatMessageSchema`.
 * - Validate every event. If any line or event is invalid, or the trailer is missing, reject the
 *   tape or flag it as invalid. Never drop individual events silently. Flag `truncated`,
 *   `stopped` and `error` tapes explicitly.
 * - Reproduce every recorded event in order and at its `t` offset: history rows (`message` and
 *   `message-batch`), `caught-up`, `delete`, stream, tool-call and reasoning events, queue,
 *   usage and other live events, and heartbeats. History the client loads later through
 *   `loadOlderHistory` (with `replayWindow`) is a separate request and is not on the tape.
 * - Never execute recorded tools or contact recorded provider endpoints or URLs.
 */
import { z } from "zod";

export const SESSION_TAPE_VERSION = 3;
/** Version 3 tapes hold full, unmasked content; the field lets a loader refuse to confuse them. */
export const SESSION_TAPE_MASKING = "none";

/** An onChat event: any object with its `type` discriminator. */
const TypedObjectSchema = z.looseObject({ type: z.string() });

export const SessionTapeHeaderSchema = z.object({
  tape: z.literal(SESSION_TAPE_VERSION),
  xumVersion: z.string(),
  /** Random id of this tape; every tape stands alone. */
  tapeId: z.string().min(1),
  /**
   * Truncated sha256 of the subscription's workspace id, for grouping and file names. Events
   * carry workspace ids verbatim.
   */
  workspaceIdHash: z.string().min(1),
  startedAt: z.iso.datetime(),
  masking: z.literal(SESSION_TAPE_MASKING),
  /** Subscription input flags (the mode is always a full replay, so it is omitted). */
  subscription: z.object({
    batchReplay: z.boolean().optional(),
    replayWindow: z.boolean().optional(),
    validateOutput: z.boolean(),
  }),
});

export const SessionTapeEventLineSchema = z.object({
  t: z.number().nonnegative(),
  bytes: z.number().int().nonnegative(),
  event: TypedObjectSchema,
  /** oRPC RPC JSON meta: `[type, ...path]` entries for values JSON cannot carry. */
  meta: z.array(z.array(z.union([z.string(), z.number()]))).optional(),
});

export const SessionTapeEndReasonSchema = z.enum(["closed", "stopped", "error"]);

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
