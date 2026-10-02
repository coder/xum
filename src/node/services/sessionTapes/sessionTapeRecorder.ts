/**
 * Session tape recorder (experiment `sessionTapes`): writes one redacted JSONL tape per
 * `workspace.onChat` subscription under `<root>/perf/tapes/`. The format and replay contract
 * live in `src/common/types/sessionTape.ts`; redaction lives in `./redact.ts`.
 *
 * Invariants:
 * - Experiment off at subscription start: the original generator is returned untouched (no
 *   recorder work, no fs). The flag is read once per subscription, so toggling it affects only
 *   subscriptions opened afterwards.
 * - The recorder never slows or breaks the subscription: events are yielded as soon as the inner
 *   generator produces them, no open/append/flush is awaited on the event path, and any
 *   recording failure (redaction, serialization, fs) stops that tape with one `log.warn`.
 * - Memory and disk stay bounded: queued + in-flight bytes ≤ 8 MiB, ≤ 50 MiB per tape (the tape
 *   is truncated at the first event that does not fit, never with gaps), and retention keeps the
 *   newest 20 tapes within 200 MiB.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { getXumPerfTapesDir } from "@/common/constants/paths";
import type { OnChatMode, WorkspaceChatMessage } from "@/common/orpc/types";
import {
  SESSION_TAPE_REDACTION,
  SESSION_TAPE_VERSION,
  type SessionTapeEndReason,
  type SessionTapeEventLine,
  type SessionTapeHeader,
  type SessionTapeTrailer,
} from "@/common/types/sessionTape";
import { getErrorMessage } from "@/common/utils/errors";
import type { Config } from "@/node/config";
import type { AgentSession } from "@/node/services/agentSession";
import type { AIService } from "@/node/services/aiService";
import { log } from "@/node/services/log";
import { VERSION } from "@/version";
import { redactTapeEvent } from "./redact";

const MEMORY_CAP_BYTES = 8 * 1024 * 1024;
const TAPE_CAP_BYTES = 50 * 1024 * 1024;
/** Room kept free under both caps so a truncated tape can still end with its trailer. */
const TRAILER_RESERVE_BYTES = 4 * 1024;
const RETENTION_MAX_TAPES = 20;
const RETENTION_MAX_BYTES = 200 * 1024 * 1024;
const TAPE_FILE_SUFFIX = ".jsonl";

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
    redaction: SESSION_TAPE_REDACTION,
    subscription: {
      // `mode` can carry a history cursor; shape-redact it like an event.
      mode: input.mode
        ? (redactTapeEvent(
            input.mode,
            hashTapeWorkspaceId
          ) as SessionTapeHeader["subscription"]["mode"])
        : undefined,
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
    String(correlation.lastSeq),
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
  /** Bytes in `lines`. */
  private queuedBytes = 0;
  /** Bytes of the batch currently being appended. */
  private inFlightBytes = 0;
  /** Bytes accepted into this tape so far (written or queued). */
  private tapeBytes = 0;
  private accepting = true;
  private truncated = false;
  private droppedEvents = 0;
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
      if (this.truncated) this.droppedEvents += 1;
      return;
    }
    // Capture timing before any recorder work so redaction cost does not skew offsets.
    const t = performance.now() - this.startMs;
    try {
      const original = JSON.stringify(event);
      const eventLine: SessionTapeEventLine = {
        t,
        bytes: Buffer.byteLength(original),
        event: redactTapeEvent(event, hashTapeWorkspaceId) as SessionTapeEventLine["event"],
      };
      const line = JSON.stringify(eventLine) + "\n";
      const lineBytes = Buffer.byteLength(line);
      const overMemory =
        this.queuedBytes + this.inFlightBytes + lineBytes >
        MEMORY_CAP_BYTES - TRAILER_RESERVE_BYTES;
      const overTape = this.tapeBytes + lineBytes > TAPE_CAP_BYTES - TRAILER_RESERVE_BYTES;
      if (overMemory || overTape) {
        // Truncate at the first overflow (no gaps): everything after this event is dropped.
        this.accepting = false;
        this.truncated = true;
        this.droppedEvents = 1;
        return;
      }
      this.enqueue(line);
    } catch (error) {
      this.fail(error);
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
          reason: reason === "closed" && this.truncated ? "truncated" : reason,
          truncated: this.truncated,
          droppedEvents: this.droppedEvents,
        },
      };
      this.enqueue(JSON.stringify(trailer) + "\n");
    }
    this.notifyDrain();
  }

  private enqueue(line: string): void {
    const bytes = Buffer.byteLength(line);
    this.lines.push(line);
    this.queuedBytes += bytes;
    this.tapeBytes += bytes;
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
        const batch = this.lines.splice(0).join("");
        this.inFlightBytes = this.queuedBytes;
        this.queuedBytes = 0;
        await handle.appendFile(batch);
        this.inFlightBytes = 0;
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
  }
}

/**
 * Keep the newest RETENTION_MAX_TAPES tapes within RETENTION_MAX_BYTES; once the newest-first
 * running totals exceed either cap, every older tape is deleted. Tapes this process is writing
 * are counted but never deleted. Best effort: failures are logged at debug level.
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
      try {
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) continue;
        size = stats.size;
      } catch {
        continue;
      }
      count += 1;
      totalBytes += size;
      overCap ||= count > RETENTION_MAX_TAPES || totalBytes > RETENTION_MAX_BYTES;
      if (overCap && !activeTapePaths.has(filePath)) {
        await fs.rm(filePath, { force: true });
      }
    }
  } catch (error) {
    log.debug("Session tape retention failed", { dir, error: getErrorMessage(error) });
  }
}
