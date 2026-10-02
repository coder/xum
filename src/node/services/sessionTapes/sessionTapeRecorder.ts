/**
 * Session tape recorder (experiment `sessionTapes`): writes one content-masked JSONL tape per
 * `workspace.onChat` subscription under `<root>/perf/tapes/`. The format and replay contract
 * live in `src/common/types/sessionTape.ts`; masking lives in `./contentMask.ts`.
 *
 * Invariants:
 * - Experiment off at subscription start: the original generator is returned untouched (no
 *   recorder work, no fs). The flag is read once per subscription, so toggling it affects only
 *   subscriptions opened afterwards.
 * - Capture is a measured snapshot, not a queued reference: when an event is delivered, the
 *   recorder takes `t`, masks the event and serializes it once, and keeps only that immutable
 *   string. Queuing the event object itself is not safe: on the router path zod copies all
 *   checked structure (zod `$ZodObject`/`$ZodArray` build new values) and replay rows are freshly
 *   parsed per subscription (agentSession.ts replayHistory), but `unknown`-typed tool
 *   input/output/args/result values are passed through by reference (zod `$ZodUnknown`), and an
 *   arbitrary tool could still change its returned object later. This snapshot work runs before
 *   the event reaches the consumer, so later `t` offsets include it (see the overhead numbers in
 *   the PR that introduced the recorder).
 * - No schema validation and no file I/O on the delivery path. Appends run in small batches with
 *   an event-loop yield (`setImmediate`) between them; that keeps each turn short but still runs
 *   on the backend thread.
 * - Memory and disk are bounded by bytes: queued plus in-flight lines ≤ 8 MiB, one event ≤ 4 MiB,
 *   one tape ≤ 50 MiB. The first event that does not fit truncates the tape (never with gaps).
 *   Masking stops as soon as an event's content passes the per-event cap, so an oversized event
 *   (history boundary rows can reach 64 MiB) is refused before most of the work; only an event
 *   whose bulk is structural (not content) is fully serialized before the size check. Retention
 *   keeps the newest 20 tapes within 200 MiB.
 * - Any recording failure (masking, serialization, fs) stops that tape with one `log.warn` and
 *   never throws into the subscription.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { getXumPerfTapesDir } from "@/common/constants/paths";
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
import type { AgentSession } from "@/node/services/agentSession";
import type { AIService } from "@/node/services/aiService";
import { log } from "@/node/services/log";
import { VERSION } from "@/version";
import { maskTapeEvent, TapeEventTooLargeError } from "./contentMask";

const MEMORY_CAP_BYTES = 8 * 1024 * 1024;
/** Largest single stored event (masked JSON); a larger one truncates the tape. */
const EVENT_CAP_BYTES = 4 * 1024 * 1024;
/** Bytes appended per write; the drain yields to the event loop between writes. */
const WRITE_BATCH_BYTES = 256 * 1024;
const TAPE_CAP_BYTES = 50 * 1024 * 1024;
/** Room kept free under both caps so a truncated tape can still end with its trailer. */
const TRAILER_RESERVE_BYTES = 4 * 1024;
const RETENTION_MAX_TAPES = 20;
const RETENTION_MAX_BYTES = 200 * 1024 * 1024;
const TAPE_FILE_SUFFIX = ".jsonl";
/**
 * Best effort for a second backend on the same root, which only XUM_ALLOW_MULTIPLE_INSTANCES
 * allows (server.lock normally gives one backend per root): retention never deletes a tape it
 * did not write and that was modified this recently, because `activeTapePaths` only knows this
 * process's writers. An open recording appends at least every SUBSCRIPTION_HEARTBEAT_INTERVAL_MS
 * (heartbeats are recorded). Tapes this process closed are deletable at once, so a burst of
 * short subscriptions cannot outgrow the caps.
 */
const RETENTION_ACTIVE_GRACE_MS = 60_000;
/** Upper bound on remembered closed tape paths (they are also forgotten when deleted). */
const CLOSED_TAPE_MEMORY = RETENTION_MAX_TAPES * 4;

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

/** Tapes currently being written by this process; retention never deletes them. */
const activeTapePaths = new Set<string>();
/** Tapes this process finished writing (handle closed); retention may delete them at once. */
const closedTapePaths = new Set<string>();

function rememberClosedTape(filePath: string): void {
  closedTapePaths.add(filePath);
  for (const oldest of closedTapePaths) {
    if (closedTapePaths.size <= CLOSED_TAPE_MEMORY) break;
    closedTapePaths.delete(oldest);
  }
}
/** Completion promises of tapes whose subscription ended but whose writes may be pending. */
const closingTapes = new Set<Promise<void>>();
/**
 * Reconnect correlation: one random sessionId per AgentSession object, so reconnect tapes of a
 * workspace share it within this process. A WeakMap keeps no entry alive after the session is
 * disposed.
 */
const sessionCorrelation = new WeakMap<AgentSession, { sessionId: string; lastSeq: number }>();

function hashTapeWorkspaceId(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
}

/**
 * Resolves once every tape whose subscription has ended has finished writing (trailer included).
 * Tapes of still-open subscriptions are not awaited. Perf harnesses use it to time the flush
 * separately from delivery.
 */
export async function flushSessionTapes(): Promise<void> {
  await Promise.all([...closingTapes]);
}

/**
 * Wrap a `workspace.onChat` generator (after `mapValue`, so the recorded value equals the wire
 * value) with a tape recorder when the `sessionTapes` experiment is on.
 */
export function maybeRecordWorkspaceChat(
  deps: SessionTapeDeps,
  session: AgentSession,
  input: SessionTapeSubscriptionInput,
  events: AsyncGenerator<WorkspaceChatMessage>
): AsyncGenerator<WorkspaceChatMessage> {
  let enabled: boolean;
  try {
    enabled = deps.aiService.isExperimentEnabled(EXPERIMENT_IDS.SESSION_TAPES);
  } catch {
    // The recorder must never break a subscription; without readable experiment state it is off.
    enabled = false;
  }
  if (!enabled) return events;

  let writer: SessionTapeWriter;
  try {
    writer = openTape(deps.config.rootDir, session, input);
  } catch (error) {
    log.warn("Session tape recording disabled for this subscription", {
      error: getErrorMessage(error),
    });
    return events;
  }
  return recordingIterator(events, writer);
}

function openTape(
  rootDir: string,
  session: AgentSession,
  input: SessionTapeSubscriptionInput
): SessionTapeWriter {
  let correlation = sessionCorrelation.get(session);
  if (!correlation) {
    correlation = { sessionId: randomUUID(), lastSeq: 0 };
    sessionCorrelation.set(session, correlation);
  }
  correlation.lastSeq += 1;
  const startMs = performance.now();
  const startedAt = new Date().toISOString();
  const workspaceIdHash = hashTapeWorkspaceId(input.workspaceId);
  const header: SessionTapeHeader = {
    tape: SESSION_TAPE_VERSION,
    xumVersion: VERSION.git_describe,
    sessionId: correlation.sessionId,
    subscriptionSeq: correlation.lastSeq,
    workspaceIdHash,
    startedAt,
    masking: SESSION_TAPE_MASKING,
    subscription: {
      // Structural (a replay strategy and history cursor ids), so it is kept verbatim.
      mode: input.mode,
      batchReplay: input.batchReplay,
      replayWindow: input.replayWindow,
      validateOutput: input.validateOutput,
    },
  };
  const dir = getXumPerfTapesDir(rootDir);
  const fileName = [
    startedAt.replace(/[-:.]/g, ""),
    workspaceIdHash,
    correlation.sessionId.slice(0, 8),
    // Zero-padded so tapes started in the same millisecond still sort (and retire) in order.
    String(correlation.lastSeq).padStart(6, "0"),
  ].join("-");
  return new SessionTapeWriter(dir, path.join(dir, fileName + TAPE_FILE_SUFFIX), header, startMs);
}

/**
 * Pass-through iterator: delegates next/return/throw to the inner generator unchanged and only
 * observes settled results, so cleanup and error semantics stay the inner generator's.
 */
function recordingIterator(
  events: AsyncGenerator<WorkspaceChatMessage>,
  writer: SessionTapeWriter
): AsyncGenerator<WorkspaceChatMessage> {
  const observe = (result: IteratorResult<WorkspaceChatMessage>) => {
    if (result.done) writer.close("closed");
    else writer.record(result.value);
    return result;
  };
  const fail = (error: unknown): never => {
    writer.close("error");
    throw error;
  };
  const wrapped: AsyncGenerator<WorkspaceChatMessage> = {
    next: (...args) => events.next(...args).then(observe, fail),
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

class SessionTapeWriter {
  private readonly lines: string[] = [];
  /** UTF-8 size of each queued line, parallel to `lines`. */
  private readonly lineBytes: number[] = [];
  /** Bytes in `lines`. */
  private queuedBytes = 0;
  /** Bytes of the batch currently being appended. */
  private inFlightBytes = 0;
  /** Bytes accepted into this tape so far (written or queued). */
  private tapeBytes = 0;
  private accepting = true;
  private truncated = false;
  private droppedEvents = 0;
  /** Set when an event could not be captured (masking/serialization threw); reason "error". */
  private captureStopped = false;
  private recordedEvents = 0;
  private peakRetainedBytes = 0;
  private failed = false;
  private closed = false;
  private wakeDrain: (() => void) | undefined;
  private drainEnded = false;
  private readonly completion: Promise<void>;

  constructor(
    private readonly dir: string,
    private readonly filePath: string,
    header: SessionTapeHeader,
    private readonly startMs: number
  ) {
    activeTapePaths.add(filePath);
    this.enqueue(JSON.stringify(header) + "\n");
    const completion: Promise<void> = this.drain().then(() => {
      this.drainEnded = true;
      activeTapePaths.delete(filePath);
      closingTapes.delete(completion);
    });
    this.completion = completion;
  }

  /** Never throws and never awaits: runs synchronously on the event path. */
  record(event: WorkspaceChatMessage): void {
    if (!this.accepting) {
      if (this.truncated || this.captureStopped) this.droppedEvents += 1;
      return;
    }
    // Capture timing before any recorder work so this event's offset excludes its own snapshot.
    const t = performance.now() - this.startMs;
    try {
      // The one serialization: the stored event JSON is also what `bytes` measures.
      // The content budget refuses an oversized event before masking or serializing all of it.
      const eventJson = JSON.stringify(maskTapeEvent(event, EVENT_CAP_BYTES));
      const bytes = Buffer.byteLength(eventJson);
      const prefix = `{"t":${JSON.stringify(t)},"bytes":${bytes},"event":`;
      const lineBytes = prefix.length + bytes + 2; // prefix is ASCII; then `}` and `\n`
      const retained = this.queuedBytes + this.inFlightBytes + lineBytes;
      if (
        bytes > EVENT_CAP_BYTES ||
        retained > MEMORY_CAP_BYTES - TRAILER_RESERVE_BYTES ||
        this.tapeBytes + lineBytes > TAPE_CAP_BYTES - TRAILER_RESERVE_BYTES
      ) {
        // Truncate at the first event that does not fit (no gaps): everything after is dropped.
        this.accepting = false;
        this.truncated = true;
        this.droppedEvents = 1;
        return;
      }
      this.recordedEvents += 1;
      this.enqueue(prefix + eventJson + "}\n", lineBytes);
    } catch (error) {
      if (error instanceof TapeEventTooLargeError) {
        this.accepting = false;
        this.truncated = true;
        this.droppedEvents = 1;
        return;
      }
      // Never fall back to unmasked data: keep the gap-free prefix and end the tape here.
      this.accepting = false;
      this.captureStopped = true;
      this.droppedEvents = 1;
      log.warn("Session tape recording stopped", {
        tape: this.filePath,
        error: getErrorMessage(error),
      });
    }
  }

  /** Idempotent. Queues the trailer; the drain loop writes it and closes the file. */
  close(reason: Exclude<SessionTapeEndReason, "truncated">): void {
    if (this.closed) return;
    this.closed = true;
    this.accepting = false;
    // A drain that already ended (write failure) has nothing left to flush.
    if (!this.drainEnded) closingTapes.add(this.completion);
    if (!this.failed) {
      const trailer: SessionTapeTrailer = {
        t: performance.now() - this.startMs,
        end: {
          reason: this.captureStopped
            ? "error"
            : reason === "closed" && this.truncated
              ? "truncated"
              : reason,
          truncated: this.truncated,
          droppedEvents: this.droppedEvents,
        },
      };
      this.enqueue(JSON.stringify(trailer) + "\n");
    }
    this.notifyDrain();
  }

  private enqueue(line: string, bytes = Buffer.byteLength(line)): void {
    this.lines.push(line);
    this.lineBytes.push(bytes);
    this.queuedBytes += bytes;
    this.tapeBytes += bytes;
    this.peakRetainedBytes = Math.max(
      this.peakRetainedBytes,
      this.queuedBytes + this.inFlightBytes
    );
    this.notifyDrain();
  }

  private notifyDrain(): void {
    const wake = this.wakeDrain;
    this.wakeDrain = undefined;
    wake?.();
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.accepting = false;
    this.lines.length = 0;
    this.lineBytes.length = 0;
    this.queuedBytes = 0;
    log.warn("Session tape recording stopped", {
      tape: this.filePath,
      error: getErrorMessage(error),
    });
    this.notifyDrain();
  }

  /** The single writer loop: appends queued batches in order until closed or failed. */
  private async drain(): Promise<void> {
    let handle: fs.FileHandle | undefined;
    try {
      await fs.mkdir(this.dir, { recursive: true });
      handle = await fs.open(this.filePath, "a");
      await enforceTapeRetention(this.dir);
      while (!this.failed) {
        if (this.lines.length === 0) {
          if (this.closed) break;
          await new Promise<void>((resolve) => (this.wakeDrain = resolve));
          continue;
        }
        // A small batch per write, then a yield, so one tape never holds the loop for long.
        let count = 0;
        let batchBytes = 0;
        while (count < this.lines.length && (count === 0 || batchBytes < WRITE_BATCH_BYTES)) {
          batchBytes += this.lineBytes[count];
          count += 1;
        }
        const batch = this.lines.splice(0, count).join("");
        this.lineBytes.splice(0, count);
        this.queuedBytes -= batchBytes;
        this.inFlightBytes = batchBytes;
        await handle.appendFile(batch);
        this.inFlightBytes = 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.inFlightBytes = 0;
      try {
        await handle?.close();
      } catch (error) {
        this.fail(error);
      }
    }
    log.debug("Session tape closed", {
      tape: this.filePath,
      recordedEvents: this.recordedEvents,
      droppedEvents: this.droppedEvents,
      truncated: this.truncated,
      peakRetainedBytes: this.peakRetainedBytes,
    });
    if (handle) {
      // The file is complete (or abandoned after a failure): retention may now delete it, and
      // runs here too so tapes closed in a burst are pruned without waiting for the next open.
      activeTapePaths.delete(this.filePath);
      rememberClosedTape(this.filePath);
      await enforceTapeRetention(this.dir);
    }
  }
}

/**
 * Keep the newest RETENTION_MAX_TAPES tapes within RETENTION_MAX_BYTES; once the newest-first
 * running totals exceed either cap, every older tape is deleted. Tapes this process is writing,
 * and tapes it did not close that were modified within RETENTION_ACTIVE_GRACE_MS (possibly
 * another process's), are counted but never deleted. Best effort: failures are logged at debug level.
 */
async function enforceTapeRetention(dir: string): Promise<void> {
  try {
    // File names start with a compact UTC timestamp, so a reverse name sort is newest first.
    const names = (await fs.readdir(dir))
      .filter((name) => name.endsWith(TAPE_FILE_SUFFIX))
      .sort()
      .reverse();
    let count = 0;
    let totalBytes = 0;
    let overCap = false;
    for (const name of names) {
      const filePath = path.join(dir, name);
      let size: number;
      let recentlyModified: boolean;
      try {
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) continue;
        size = stats.size;
        recentlyModified = Date.now() - stats.mtimeMs < RETENTION_ACTIVE_GRACE_MS;
      } catch {
        closedTapePaths.delete(filePath);
        continue;
      }
      count += 1;
      totalBytes += size;
      overCap ||= count > RETENTION_MAX_TAPES || totalBytes > RETENTION_MAX_BYTES;
      const deletable = closedTapePaths.has(filePath) || !recentlyModified;
      if (overCap && !activeTapePaths.has(filePath) && deletable) {
        await fs.rm(filePath, { force: true });
        closedTapePaths.delete(filePath);
      }
    }
  } catch (error) {
    log.debug("Session tape retention failed", { dir, error: getErrorMessage(error) });
  }
}
