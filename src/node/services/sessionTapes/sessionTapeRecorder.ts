/**
 * Session tape recorder (experiment `sessionTapes`): captures one full-replay `workspace.onChat`
 * subscription into a JSONL tape under `<root>/perf/tapes/`. The format, privacy boundary and
 * replay contract live in `src/common/types/sessionTape.ts`. Tapes are not masked: they hold the
 * full chat, so they are private (0700/0600), local, and off by default.
 *
 * Invariants:
 * - Nothing happens when the experiment is off at subscription start, or for a `since`/`live`
 *   subscription (only standalone full replays are captured): the original generator is
 *   returned untouched (no recorder work, no fs).
 * - Capture starts on the first read from the iterator, not when the iterator is created, so an
 *   iterator that is never read costs nothing and offsets start when the client starts reading.
 * - Capture is a snapshot, not a held reference: when an event is delivered, the recorder takes
 *   `t`, serializes the event once, and keeps only that immutable string. Holding the event
 *   object is not safe: `unknown`-typed tool input/output values reach the wire by reference
 *   (zod `$ZodUnknown`), and a tool could change its returned object later. The serialization
 *   runs before the event reaches the consumer, so later `t` offsets include it.
 * - Nothing touches disk before finalization. A capture holds its serialized lines in memory,
 *   bounded per event (4 MiB), per tape (32 MiB) and across ALL captures of this process
 *   (64 MiB). The first event that does not fit truncates that tape (gap-free); the bytes stay
 *   accounted until the tape is written. The caps count the held lines: while a tape is being
 *   written its joined copy and write buffer exist too (up to about 3x), and each header and
 *   trailer (well under 1 KiB) is added without a cap check.
 * - A capture is finalized (written whole, atomically) when its subscription ends, when
 *   `stopSessionTapeCaptures()` is called (also on a normal quit, bounded by
 *   SESSION_TAPE_FLUSH_TIMEOUT_MS), or at the next delivered event after the experiment is turned
 *   off. A process that dies before finalization loses its open captures; a write that never
 *   settles keeps its bytes counted against the global cap.
 * - Any recording failure (serialization, fs) ends that tape with one `log.warn` and never throws
 *   into the subscription.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { RPCJsonSerializer } from "@orpc/client";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { getXumPerfTapesDir } from "@/common/constants/paths";
import assert from "@/common/utils/assert";
import type { OnChatMode, WorkspaceChatMessage } from "@/common/orpc/types";
import {
  SESSION_TAPE_MASKING,
  SESSION_TAPE_VERSION,
  type SessionTapeEndReason,
  type SessionTapeHeader,
  type SessionTapeTrailer,
} from "@/common/types/sessionTape";
import { getErrorMessage } from "@/common/utils/errors";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import { log } from "@/node/services/log";
import { ensurePrivateDir } from "@/node/utils/fs";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import { VERSION } from "@/version";

/** Largest single stored event JSON line; a larger one truncates the tape. */
const EVENT_CAP_BYTES = 4 * 1024 * 1024;
/**
 * Largest tape (all lines); the first event that would pass it truncates the tape. Readers
 * refuse larger files (readSessionTapeFile).
 */
export const SESSION_TAPE_CAP_BYTES = 32 * 1024 * 1024;
/** Serialized lines held by all captures of this process, until their tapes are written. */
const GLOBAL_CAP_BYTES = 64 * 1024 * 1024;
/** Room kept under every cap so a truncated tape can still end with its trailer. */
const TRAILER_RESERVE_BYTES = 4 * 1024;
/**
 * oRPC's RPC JSON encoding (the wire's), but keeping undefined-valued properties: the onChat
 * schema requires some keys whose value can be undefined (e.g. usage token counts), and Dates
 * need a type tag. A loader decodes `{json: event, meta}` with the same class.
 */
const TAPE_JSON_SERIALIZER = new RPCJsonSerializer({ omitUndefinedProperties: false });
const RETENTION_MAX_TAPES = 20;
const RETENTION_MAX_BYTES = 200 * 1024 * 1024;
const TAPE_FILE_SUFFIX = ".jsonl";
/** writeFileAtomic's temp files: `<target>.<12 hex>`. */
const TEMP_FILE_PATTERN = /\.jsonl\.[0-9a-f]{12}$/;
/**
 * A temp file older than this is a crash leftover: a write of at most SESSION_TAPE_CAP_BYTES finishes
 * in seconds, and writeFileAtomic removes its temp file on failure and on normal exit.
 */
const TEMP_LEFTOVER_AGE_MS = 10 * 60 * 1000;

/**
 * Header `workspaceIdHash`: 16 hex chars of sha256 of the TRIMMED workspace id, the id the
 * session layer resolves (WorkspaceService trims it), so a padded subscription id records and
 * replays under the same hash.
 */
export function hashSessionTapeWorkspaceId(workspaceId: string): string {
  return createHash("sha256").update(workspaceId.trim()).digest("hex").slice(0, 16);
}

export interface SessionTapeDeps {
  aiService: Pick<AIService, "isExperimentEnabled">;
  config: Pick<Config, "rootDir">;
}

export interface SessionTapeSubscriptionInput {
  workspaceId: string;
  mode?: OnChatMode;
  batchReplay?: boolean;
  replayWindow?: boolean;
  validateOutput: boolean;
}

/** Bytes of serialized lines held by all captures, released when each tape is written. */
let globalRetainedBytes = 0;
/** Captures that have started and are not finalized yet. */
const activeCaptures = new Set<TapeCapture>();
/** Tape writes in progress. */
const pendingWrites = new Set<Promise<boolean>>();

function isRecordingEnabled(deps: SessionTapeDeps): boolean {
  try {
    return deps.aiService.isExperimentEnabled(EXPERIMENT_IDS.SESSION_TAPES);
  } catch {
    // The recorder must never break a subscription; without readable experiment state it is off.
    return false;
  }
}

/**
 * Resolves once every finalized tape has been written (or failed). Captures of still-open
 * subscriptions are not finalized by this. Perf harnesses use it to time the write separately
 * from delivery.
 */
export async function flushSessionTapes(): Promise<void> {
  while (pendingWrites.size > 0) await Promise.all([...pendingWrites]);
}

/**
 * Explicit stop: finalizes every active capture now (its subscription keeps running, unrecorded)
 * and resolves once the tapes are written. Returns how many tapes THIS call finalized and wrote
 * successfully (the "Save open session tapes" command reports it).
 */
export async function stopSessionTapeCaptures(): Promise<number> {
  // Snapshot before any await so captures started meanwhile are left alone. Every snapshot
  // capture is still open here (finalize removes it from the set synchronously), so this call
  // finalizes each one.
  const writes = [...activeCaptures].map((capture) => {
    capture.finalize("stopped");
    assert(capture.written, "a finalized session tape capture has a write");
    return capture.written;
  });
  const results = await Promise.all(writes);
  await flushSessionTapes();
  return results.filter(Boolean).length;
}

/**
 * Wrap a `workspace.onChat` generator (after `mapValue`, so the recorded value equals the wire
 * value) with a lazy tape capture when the `sessionTapes` experiment is on and the subscription
 * is a full replay.
 */
export function maybeRecordWorkspaceChat(
  deps: SessionTapeDeps,
  input: SessionTapeSubscriptionInput,
  events: AsyncGenerator<WorkspaceChatMessage>
): AsyncGenerator<WorkspaceChatMessage> {
  if (!isRecordingEnabled(deps)) return events;
  // Only standalone full replays: a since/live subscription is a delta on top of client state
  // that no tape holds, so it cannot be replayed on its own.
  if (input.mode !== undefined && input.mode.type !== "full") return events;

  let capture: TapeCapture | undefined;
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    try {
      capture = new TapeCapture(deps, input);
    } catch (error) {
      log.warn("Session tape recording disabled for this subscription", {
        error: getErrorMessage(error),
      });
    }
  };
  const observe = (result: IteratorResult<WorkspaceChatMessage>) => {
    if (result.done) capture?.finalize("closed");
    else capture?.record(result.value);
    return result;
  };
  const fail = (error: unknown): never => {
    capture?.finalize("error");
    throw error;
  };
  // Pass-through iterator: delegates next/return/throw to the inner generator unchanged and
  // only observes settled results, so cleanup and error semantics stay the inner generator's.
  const wrapped: AsyncGenerator<WorkspaceChatMessage> = {
    next: (...args) => {
      start();
      return events.next(...args).then(observe, fail);
    },
    // A return/throw before the first read never starts a capture.
    return: (value) => events.return(value).then(observe, fail),
    throw: (error) => events.throw(error).then(observe, fail),
    [Symbol.asyncIterator]: () => wrapped,
    // Same as an async generator's built-in disposer: return() and discard the result.
    [Symbol.asyncDispose]: async () => {
      await wrapped.return(undefined);
    },
  };
  return wrapped;
}

class TapeCapture {
  private readonly header: SessionTapeHeader;
  private readonly startMs = performance.now();
  private readonly filePath: string;
  private readonly lines: string[] = [];
  /** Bytes held by this capture (header and lines), counted in `globalRetainedBytes`. */
  private retainedBytes = 0;
  private accepting = true;
  private truncated = false;
  /** Set when an event could not be serialized; reason "error". */
  private captureFailed = false;
  private droppedEvents = 0;
  private finalized = false;
  /** Set by finalize: true once the tape is on disk, false when the write failed. */
  written: Promise<boolean> | undefined;

  constructor(
    private readonly deps: SessionTapeDeps,
    input: SessionTapeSubscriptionInput
  ) {
    const tapeId = randomUUID();
    const startedAt = new Date().toISOString();
    const workspaceIdHash = hashSessionTapeWorkspaceId(input.workspaceId);
    this.header = {
      tape: SESSION_TAPE_VERSION,
      xumVersion: VERSION.git_describe,
      tapeId,
      workspaceIdHash,
      startedAt,
      masking: SESSION_TAPE_MASKING,
      subscription: {
        batchReplay: input.batchReplay,
        replayWindow: input.replayWindow,
        validateOutput: input.validateOutput,
      },
    };
    const dir = getXumPerfTapesDir(deps.config.rootDir);
    const fileName = `${startedAt.replace(/[-:.]/g, "")}-${workspaceIdHash}-${tapeId}`;
    this.filePath = path.join(dir, fileName + TAPE_FILE_SUFFIX);
    // The header is small and fixed-size (no client-provided strings), so it always fits.
    this.retain(JSON.stringify(this.header) + "\n");
    activeCaptures.add(this);
  }

  /** Never throws and never awaits: runs synchronously on the event path. */
  record(event: WorkspaceChatMessage): void {
    if (this.finalized) return;
    if (!isRecordingEnabled(this.deps)) {
      // Turned off mid-subscription: keep what was captured and stop here.
      this.finalize("stopped");
      return;
    }
    if (!this.accepting) {
      this.droppedEvents += 1;
      return;
    }
    // Capture timing before any recorder work so this event's offset excludes its own snapshot.
    const t = performance.now() - this.startMs;
    try {
      // The one serialization: the stored event JSON is also what `bytes` measures.
      const encoded = TAPE_JSON_SERIALIZER.serialize(event);
      if ("maps" in encoded) throw new Error("Session tapes cannot store Blob values");
      const eventJson = JSON.stringify(encoded.json);
      const bytes = Buffer.byteLength(eventJson);
      const metaJson = encoded.meta ? `,"meta":${JSON.stringify(encoded.meta)}` : "";
      const prefix = `{"t":${JSON.stringify(t)},"bytes":${bytes},"event":`;
      // prefix is ASCII; then the meta part, `}` and `\n`.
      const lineBytes = prefix.length + bytes + Buffer.byteLength(metaJson) + 2;
      if (
        lineBytes > EVENT_CAP_BYTES ||
        this.retainedBytes + lineBytes > SESSION_TAPE_CAP_BYTES - TRAILER_RESERVE_BYTES ||
        globalRetainedBytes + lineBytes > GLOBAL_CAP_BYTES - TRAILER_RESERVE_BYTES
      ) {
        // Truncate at the first event that does not fit (no gaps): everything after is dropped.
        this.accepting = false;
        this.truncated = true;
        this.droppedEvents = 1;
        return;
      }
      this.retain(prefix + eventJson + metaJson + "}\n", lineBytes);
    } catch (error) {
      // Keep the gap-free prefix and end the capture here.
      this.accepting = false;
      this.captureFailed = true;
      this.droppedEvents = 1;
      log.warn("Session tape recording stopped", {
        tape: this.filePath,
        error: getErrorMessage(error),
      });
    }
  }

  /** Idempotent. Ends the capture and writes the whole tape in the background (`written`). */
  finalize(reason: SessionTapeEndReason): void {
    if (this.finalized) return;
    this.finalized = true;
    this.accepting = false;
    activeCaptures.delete(this);
    const trailer: SessionTapeTrailer = {
      t: performance.now() - this.startMs,
      end: {
        reason: this.captureFailed ? "error" : reason,
        truncated: this.truncated,
        droppedEvents: this.droppedEvents,
      },
    };
    // The trailer reserve keeps this inside every cap.
    this.retain(JSON.stringify(trailer) + "\n");
    const write: Promise<boolean> = this.write(this.lines.splice(0)).finally(() => {
      globalRetainedBytes -= this.retainedBytes;
      this.retainedBytes = 0;
      pendingWrites.delete(write);
    });
    pendingWrites.add(write);
    this.written = write;
  }

  private retain(line: string, bytes = Buffer.byteLength(line)): void {
    this.lines.push(line);
    this.retainedBytes += bytes;
    globalRetainedBytes += bytes;
  }

  /** Never rejects: true when the tape was written (retention is best effort and ignored). */
  private async write(lines: string[]): Promise<boolean> {
    const dir = path.dirname(this.filePath);
    try {
      // Tapes hold the full chat: owner-only, and an existing looser directory is tightened.
      await ensurePrivateDir(dir);
      // Joined after the first await, so finalizing never builds the whole tape on the event path.
      await writeFileAtomic(this.filePath, lines.join(""), { mode: 0o600 });
    } catch (error) {
      log.warn("Session tape could not be written", {
        tape: this.filePath,
        error: getErrorMessage(error),
      });
      return false;
    }
    await enforceTapeRetention(dir);
    return true;
  }
}

/**
 * Runs after each tape is written. Keeps the most recently written RETENTION_MAX_TAPES tapes
 * within RETENTION_MAX_BYTES: once the newest-first running totals exceed either cap, every
 * older tape is deleted. Temp files that writeFileAtomic left behind (crash during a write) are
 * deleted once they are older than TEMP_LEFTOVER_AGE_MS; loaders never read them. Best effort:
 * failures are logged at debug level.
 */
async function enforceTapeRetention(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    for (const name of entries.filter((entry) => TEMP_FILE_PATTERN.test(entry))) {
      const filePath = path.join(dir, name);
      try {
        const stats = await fs.stat(filePath);
        if (Date.now() - stats.mtimeMs > TEMP_LEFTOVER_AGE_MS) {
          await fs.rm(filePath, { force: true });
        }
      } catch (error) {
        log.debug("Session tape retention could not remove a temp file", {
          filePath,
          error: getErrorMessage(error),
        });
      }
    }
    // Newest by write time, so a long capture is not pruned right after it is written just
    // because shorter tapes started after it. Ties fall back to the name (start time).
    const tapes: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
    for (const name of entries.filter((entry) => entry.endsWith(TAPE_FILE_SUFFIX))) {
      const filePath = path.join(dir, name);
      try {
        const stats = await fs.stat(filePath);
        if (stats.isFile()) tapes.push({ filePath, size: stats.size, mtimeMs: stats.mtimeMs });
      } catch {
        // Deleted meanwhile (another backend's retention): nothing to count.
      }
    }
    tapes.sort((a, b) => b.mtimeMs - a.mtimeMs || b.filePath.localeCompare(a.filePath));
    let count = 0;
    let totalBytes = 0;
    for (const { filePath, size } of tapes) {
      count += 1;
      totalBytes += size;
      if (count <= RETENTION_MAX_TAPES && totalBytes <= RETENTION_MAX_BYTES) continue;
      try {
        await fs.rm(filePath, { force: true });
      } catch (error) {
        // One undeletable tape (locked, foreign permissions) must not stop the sweep, or every
        // older tape would stay on disk past the caps.
        log.debug("Session tape retention could not delete a tape", {
          filePath,
          error: getErrorMessage(error),
        });
      }
    }
  } catch (error) {
    log.debug("Session tape retention failed", { dir, error: getErrorMessage(error) });
  }
}
