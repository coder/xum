/**
 * Session tape contract (experiment `sessionTapes`).
 *
 * A session tape is a JSONL file holding what one `workspace.onChat` subscription delivered to
 * the client, with original timing. The backend recorder (`src/node/services/sessionTapes/`)
 * writes it; perf replay and perf E2E harnesses read it.
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
 * Files:
 * - A tape being written is named `<stem>.open`; the recorder renames it to `<stem>.jsonl` after
 *   it closes the file. Loaders read only `.jsonl` files. The stem ends with the writer's host tag
 *   and process id, which retention uses to find crash leftovers.
 * - Retention keeps the newest 20 `.jsonl` tapes within 200 MiB and deletes older ones. It never
 *   deletes an `.open` tape. An `.open` tape whose writer is gone (same host tag, process no
 *   longer exists) is renamed to `.jsonl` and then counts like any closed tape; `.open` tapes from
 *   another host tag are kept.
 *
 * File layout, one JSON object per line:
 * 1. Header (`SessionTapeHeaderSchema`): always the first line.
 * 2. Zero or more event lines (`SessionTapeEventLineSchema`), in delivery order.
 *    - `t`: milliseconds from subscription start to the moment the recorder saw the event, taken
 *      before that event's own capture work. The recorder sees an event when the consumer pulls
 *      it, so events the runtime had buffered (replay bursts, backpressure) get closely spaced
 *      offsets. Capture work (one serialization) runs before the event reaches the consumer, so
 *      later offsets also include the capture time of earlier events.
 *    - `event` and optional `meta`: the onChat event in oRPC's RPC JSON encoding
 *      (`RPCJsonSerializer` from `@orpc/client`, with undefined-valued properties kept): `event`
 *      is the `json` part, `meta` lists the paths of values JSON cannot carry (Dates, undefined,
 *      BigInt, NaN, Map, Set, URL, RegExp).
 *    - `bytes`: UTF-8 byte length of the stored `event` JSON on this line (without `meta`).
 * 3. An optional trailer (`SessionTapeTrailerSchema`): `reason` is `closed`, `truncated` (a size
 *    cap was hit: the events before the first one that did not fit are complete and gap-free, and
 *    `droppedEvents` counts what was delivered afterwards but not recorded) or `error` (the
 *    subscription failed, or an event could not be serialized; the prefix is still gap-free).
 *    A missing trailer or a partial final line means the tape is incomplete (the process died or
 *    a write failed).
 *
 * Replay contract (what a replay loader, e.g. T2, must do):
 * - Check the header first: reject a tape whose `tape` version or `masking` value it does not
 *   support. Version 2 tapes have `masking: "none"` (full content); version 1 tapes were masked.
 * - Parse every line with the line schemas below, decode each event with
 *   `new RPCJsonSerializer().deserialize({ json: line.event, meta: line.meta })`, and validate
 *   the result with `WorkspaceChatMessageSchema`.
 * - Validate every event. If any line or event is invalid, reject the tape or flag it as
 *   invalid. Never drop individual events silently. Flag incomplete (no trailer or a partial
 *   line), `truncated` and `error` tapes the same explicit way.
 * - Reproduce every recorded event in order and at its `t` offset: history rows (`message` and
 *   `message-batch`), `caught-up`, `delete`, stream, tool-call and reasoning events, queue,
 *   usage and other live events, and heartbeats.
 * - A tape whose header `subscription.mode` is `since` or `live` is a delta on top of the client
 *   state its earlier tapes built: replay it only after the earlier `subscriptionSeq` tapes of
 *   the same `sessionId`, or flag it as dependent. History the client loads later through
 *   `loadOlderHistory` (with `replayWindow`) is a separate request and is not on the tape.
 * - Never execute recorded tools or contact recorded provider endpoints or URLs.
 * - A reconnect is a new tape file with the same `sessionId` and the next `subscriptionSeq`.
 *   Tapes contain no synthetic reconnect events. `sessionId` belongs to one in-memory workspace
 *   session, so correlation ends when that session is recreated or the backend restarts.
 *   `subscriptionSeq` is allocated when the subscription starts, so a missing seq means the tape
 *   was deleted (retention or by hand) or its recording failed before anything reached disk; a
 *   failed recording is logged as a "Session tape recording stopped" warning that names the tape
 *   path.
 */
import { z } from "zod";

export const SESSION_TAPE_VERSION = 2;
/** Version 2 tapes hold full, unmasked content; the field lets a loader refuse to confuse them. */
export const SESSION_TAPE_MASKING = "none";

/** An onChat event (or subscription mode): any object with its `type` discriminator. */
const TypedObjectSchema = z.looseObject({ type: z.string() });

export const SessionTapeHeaderSchema = z.object({
  tape: z.literal(SESSION_TAPE_VERSION),
  xumVersion: z.string(),
  /** Stable for one workspace session within one backend process; shared by reconnect tapes. */
  sessionId: z.string().min(1),
  /** 1 for the first subscription of `sessionId`, then incremented per subscription. */
  subscriptionSeq: z.number().int().positive(),
  /**
   * Truncated sha256 of the subscription's workspace id, for grouping and file names. Events
   * carry workspace ids verbatim.
   */
  workspaceIdHash: z.string().min(1),
  startedAt: z.iso.datetime(),
  masking: z.literal(SESSION_TAPE_MASKING),
  /** Subscription input flags; `mode` is the replay strategy and its history cursor ids. */
  subscription: z.object({
    mode: TypedObjectSchema.optional(),
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
