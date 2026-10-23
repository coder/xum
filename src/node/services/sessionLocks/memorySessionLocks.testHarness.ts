/**
 * SessionLocks in memory: the lock files and records live in a table, and a
 * waiter waits on the HostClock, so under a TestClock a test moves time
 * instead of waiting. Refusals use today's text (fileLockTimeoutMessage,
 * crossProcessLockTimeoutMessage). Three parts stay on the Node locks:
 * - Init-record locks: InitStateManager lists their folder (initStateManager.ts
 *   isRecordLockHeld), so a holder in memory would leave no file, and a live
 *   init would look abandoned.
 * - Record locks with createParentDirectory false: WorkflowRunStore needs their
 *   acquire to fail with ENOENT once the run directory is gone, with no window
 *   between a check and the take. Only the Node lock's own write gives that.
 * - The use leases: the mutation gate, isHeld and taskService read other
 *   backends' lease files. Phase 5 moves them.
 */
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { SessionLocksTag } from "@/node/services/di/tags";
import { HostClockTag } from "@/node/services/di/hostClockLive";
import type { HostClock } from "@/node/utils/hostClock";
import type { ProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { fileLockTimeoutMessage } from "@/node/utils/concurrency/fileLock";
import { CrossProcessLockTimeoutError } from "@/node/utils/concurrency/lockErrors";
import { getSelfIdentity, type ProcessIdentity } from "@/node/utils/concurrency/processLiveness";
import {
  crossProcessLockTimeoutMessage,
  describeHolder,
  type CrossProcessLockState,
} from "@/node/utils/main/crossProcessLock";
import { nodeSessionLocks } from "./nodeSessionLocks";
import type { SessionLocks } from "./sessionLocks";
import {
  abortedAcquireError,
  foreignIdentity,
  foreignPid,
  foreignRecord,
  liveBlocker,
} from "./foreignHolders.testHarness";

/** Who holds a lock in the table. */
interface Entry {
  pid: number;
  identity?: ProcessIdentity;
  /** A foreign holder whose process is gone: the next acquire reclaims it. */
  dead: boolean;
}

/** Why an acquire did not get the lock: the blocker of the timeout text. */
interface Blocker {
  pid: number;
  identity?: ProcessIdentity;
  why: string;
}

interface Waiter {
  take(entry: Entry): void;
}

/** The lock state of one build of the memory layer. */
export class MemoryLockTable {
  private readonly held = new Map<string, Entry>();
  /** FIFO per lock path: a release hands the lock to the first waiter. */
  private readonly waiters = new Map<string, Waiter[]>();

  /** Another backend holds lockPath (pid foreignPid() unless given). */
  hold(lockPath: string, state: "live" | "dead", holder?: { pid: number }): void {
    assert(!this.held.has(lockPath), `${lockPath} is already held`);
    const pid = holder?.pid ?? foreignPid();
    assert(pid !== process.pid, "a foreign holder must not be this process");
    this.held.set(lockPath, { pid, identity: foreignIdentity(), dead: state === "dead" });
  }

  /** The foreign holder of lockPath released it cleanly. */
  release(lockPath: string): void {
    const entry = this.held.get(lockPath);
    assert(entry !== undefined && entry.pid !== process.pid, `no foreign holder on ${lockPath}`);
    this.free(lockPath, entry);
  }

  owner(lockPath: string): Entry | undefined {
    return this.held.get(lockPath);
  }

  /** Takes a free or dead lock now. Else null, and the caller waits or refuses. */
  tryTake(lockPath: string): Entry | null {
    const entry = this.held.get(lockPath);
    if (entry !== undefined && !entry.dead) return null;
    const own: Entry = { pid: process.pid, identity: getSelfIdentity(), dead: false };
    this.held.set(lockPath, own);
    return own;
  }

  /** Queues a waiter. The returned function takes it out again (timeout, abort). */
  wait(lockPath: string, waiter: Waiter): () => void {
    const queue = this.waiters.get(lockPath) ?? [];
    queue.push(waiter);
    this.waiters.set(lockPath, queue);
    return () => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0 && this.waiters.get(lockPath) === queue) this.waiters.delete(lockPath);
    };
  }

  /** Frees lockPath if entry still holds it, and hands it to the first waiter. */
  free(lockPath: string, entry: Entry): void {
    if (this.held.get(lockPath) !== entry) return;
    this.held.delete(lockPath);
    const queue = this.waiters.get(lockPath);
    const next = queue?.shift();
    if (queue?.length === 0) this.waiters.delete(lockPath);
    if (next === undefined) return;
    const own = this.tryTake(lockPath);
    assert(own !== null, "a freed lock is free");
    next.take(own);
  }
}

/** The Node locks' reason for a holder (processLiveness.judgeHolder). */
function blockerOf(entry: Entry): Blocker {
  if (entry.pid === process.pid) {
    return { pid: entry.pid, identity: entry.identity, why: "it is held by this process" };
  }
  const { holder, why } = liveBlocker(entry.pid, entry.identity);
  assert(holder !== undefined);
  return { pid: holder.pid, identity: holder.identity, why };
}

/**
 * Takes lockPath, or waits until a release hands it over, or refuses with
 * refusal(blocker) once timeoutMs passes on the clock (at once for 0).
 */
function acquireInMemory(
  table: MemoryLockTable,
  lockPath: string,
  timeoutMs: number,
  clock: HostClock,
  refusal: (blocker: Blocker) => Error,
  signal?: AbortSignal
): Promise<Entry> {
  if (signal?.aborted) return Promise.reject(abortedAcquireError());
  const taken = table.tryTake(lockPath);
  if (taken !== null) return Promise.resolve(taken);
  const holder = table.owner(lockPath);
  assert(holder !== undefined, "a lock that cannot be taken has a holder");
  if (timeoutMs <= 0) return Promise.reject(refusal(blockerOf(holder)));
  return new Promise<Entry>((resolve, reject) => {
    const settle = () => {
      leave();
      cancelTimer();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      settle();
      reject(abortedAcquireError());
    };
    const leave = table.wait(lockPath, {
      take: (entry) => {
        settle();
        resolve(entry);
      },
    });
    const cancelTimer = clock.setTimer(() => {
      settle();
      const current = table.owner(lockPath);
      assert(current !== undefined, "a waiter waits only on a held lock");
      reject(refusal(blockerOf(current)));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function inspectInMemory(table: MemoryLockTable, lockPath: string): CrossProcessLockState {
  const entry = table.owner(lockPath);
  if (entry === undefined) return { state: "absent" };
  if (entry.dead) return { state: "dead" };
  const { pid, identity, why } = blockerOf(entry);
  return { state: "held", holder: describeHolder(foreignRecord(pid, identity)), why };
}

/** An init-record lock: InitStateManager finds these by listing their folder. */
export function foundByReaddir(lockPath: string): boolean {
  return lockPath.split(path.sep).join("/").includes("/locks/init-record/");
}

/** The memory locks over one table. SessionLocksMemory gives each build its own. */
export function memorySessionLocks(clock: HostClock, table: MemoryLockTable): SessionLocks {
  return {
    // Pure memory already: every session-file service shares this one FIFO.
    workspaceFiles: nodeSessionLocks.workspaceFiles,
    acquireProcessFileLock: async (options): Promise<ProcessFileLock> => {
      const { lockPath, label, timeoutMs } = options;
      // The same argument checks as fileLock.ts acquireProcessFileLock.
      assert(lockPath.length > 0, "acquireProcessFileLock requires a lock path");
      assert(timeoutMs > 0, "acquireProcessFileLock timeoutMs must be positive");
      // As fileLock.ts does first: a caller may write into the folder once it holds the lock
      // (branchSummary and refinementRollback lock inside the session folder). No lock file.
      // Synchronous, so waiters queue in call order: with an awaited mkdir, a later caller's
      // mkdir could finish first and take its place in the FIFO.
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const entry = await acquireInMemory(table, lockPath, timeoutMs, clock, (blocker) => {
        const { why, ...holder } = blocker;
        return new Error(fileLockTimeoutMessage(label, lockPath, timeoutMs, { holder, why }));
      });
      return {
        assertStillOwned: () => {
          if (table.owner(lockPath) === entry) return Promise.resolve();
          // fileLock.ts assertStillOwned
          return Promise.reject(
            new Error(
              `${label} ${lockPath} is no longer owned by this holder (displaced or reclaimed); ` +
                `aborting before mutation`
            )
          );
        },
        [Symbol.asyncDispose]: () => {
          table.free(lockPath, entry);
          return Promise.resolve();
        },
      };
    },
    acquireCrossProcessLock: async (options) => {
      if (foundByReaddir(options.lockPath) || options.createParentDirectory === false) {
        return await nodeSessionLocks.acquireCrossProcessLock(options);
      }
      const { lockPath, acquireTimeoutMs, timeoutMessage, signal } = options;
      // As crossProcessLock.ts does first: a caller may write into the folder once it holds the lock.
      // Synchronous for the same FIFO reason as the file lock above.
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const refusal = (blocker: Blocker) =>
        new CrossProcessLockTimeoutError(
          crossProcessLockTimeoutMessage(timeoutMessage, lockPath, {
            holder: foreignRecord(blocker.pid, blocker.identity),
            why: blocker.why,
          })
        );
      const entry = await acquireInMemory(
        table,
        lockPath,
        acquireTimeoutMs,
        clock,
        refusal,
        signal
      );
      return () => {
        table.free(lockPath, entry);
        return Promise.resolve();
      };
    },
    // A path the table does not hold may be a Node lock (see the module doc).
    inspectCrossProcessLock: async (lockPath) =>
      table.owner(lockPath) === undefined
        ? await nodeSessionLocks.inspectCrossProcessLock(lockPath)
        : inspectInMemory(table, lockPath),
    useLeasesFor: (config) => nodeSessionLocks.useLeasesFor(config),
  };
}

/** Each build gets fresh lock tables: no lock state outlives a test's layer. */
export const SessionLocksMemory: Layer.Layer<SessionLocksTag, never, HostClockTag> = Layer.effect(
  SessionLocksTag,
  Effect.map(HostClockTag, (clock) => memorySessionLocks(clock, new MemoryLockTable()))
);
