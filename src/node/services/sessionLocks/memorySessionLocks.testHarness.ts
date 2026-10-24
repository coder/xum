/**
 * SessionLocks in memory: the lock files, records and use leases live in a
 * table, and a waiter waits on the HostClock, so under a TestClock a test moves
 * time instead of waiting. Refusals use today's text (fileLockTimeoutMessage,
 * crossProcessLockTimeoutMessage, workspaceMutationInProgressMessage). The lock
 * folders go to the injected HostFiles: the memory volume in the in-memory
 * loop, so a lock writes nothing on the disk. Two parts stay on the Node locks:
 * - Init-record locks: InitStateManager lists their folder (initStateManager.ts
 *   isRecordLockHeld), so a holder in memory would leave no file, and a live
 *   init would look abandoned.
 * - Record locks with createParentDirectory false: WorkflowRunStore needs their
 *   acquire to fail with ENOENT once the run directory is gone, with no window
 *   between a check and the take. Only the Node lock's own write gives that.
 * A memory use lease leaves no lease file, so only this table sees it: the Node
 * mutation gate (WorkspaceUseLeases.withMutationGate) and taskService's
 * findForeignUse read lease files, and they are not SessionLocks members.
 */
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { HostFilesTag, SessionLocksTag } from "@/node/services/di/tags";
import type { HostFiles } from "@/node/services/hostFiles/hostFiles";
import {
  workspaceMutationInProgressMessage,
  workspaceMutationLockPath,
  workspaceUseLockDir,
} from "@/node/services/workspaceUseLeases";
import { HostClockTag } from "@/node/services/di/hostClockLive";
import type { HostClock } from "@/node/utils/hostClock";
import type { ProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { fileLockTimeoutMessage } from "@/node/utils/concurrency/fileLock";
import {
  CrossProcessLockTimeoutError,
  WorkspaceMutationInProgressError,
} from "@/node/utils/concurrency/lockErrors";
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

  /** Whether a live holder (this process or a foreign one) holds a path that matches. */
  anyLive(matches: (lockPath: string) => boolean): boolean {
    for (const [lockPath, entry] of this.held) {
      if (!entry.dead && matches(lockPath)) return true;
    }
    return false;
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

/**
 * Takes the lock's place in the FIFO at once, then creates the lock's folder: the Node locks
 * create it before they try, and a caller may write into the folder once it holds the lock
 * (branchSummary and refinementRollback lock inside the session folder). The place comes first
 * because HostFiles has only an async mkdir: a later caller's folder can be ready first, and it
 * would take the earlier caller's place (phase 4 saw that in 14 of 1500 runs). A failed mkdir
 * rejects as the Node locks do, and gives up the place or the lock. So does an abort of signal
 * (the caller's) during the mkdir: the Node locks check it after their mkdir.
 */
async function acquireAfterFolder(
  table: MemoryLockTable,
  files: HostFiles,
  lockPath: string,
  acquire: (giveUp: AbortSignal) => Promise<Entry>,
  signal?: AbortSignal
): Promise<Entry> {
  const giveUp = new AbortController();
  // Settled into a value at once: an early refusal must not reject unhandled during the mkdir.
  const acquired = acquire(giveUp.signal).then(
    (entry) => ({ entry }),
    (error: unknown) => ({ error })
  );
  /** Gives up the place, or frees the lock that the place already took, and throws error. */
  const abandon = async (error: unknown): Promise<never> => {
    giveUp.abort();
    const result = await acquired;
    if ("entry" in result) table.free(lockPath, result.entry);
    throw error;
  };
  try {
    await files.promises.mkdir(path.dirname(lockPath), { recursive: true });
  } catch (error) {
    return await abandon(error);
  }
  if (signal?.aborted) return await abandon(abortedAcquireError());
  const result = await acquired;
  if ("error" in result) throw result.error;
  return result.entry;
}

type UseLeases = ReturnType<SessionLocks["useLeasesFor"]>;

/**
 * The use leases of one backend, as WorkspaceUseLeases keeps them, with each lease file an entry
 * of the table: the same path, so isHeld of every backend on the table sees it. The gate is the
 * table's entry at workspaceMutationLockPath. Nothing here awaits, so a hold needs no transition
 * lock: no other call runs between its publication and its probe.
 */
function memoryLeases(table: MemoryLockTable, rootDir: string): UseLeases {
  const token = randomUUID();
  const held = new Map<string, { count: number; entry: Entry }>();
  return {
    hold: (workspaceId, kind) => {
      const leasePath = path.join(
        workspaceUseLockDir(rootDir, workspaceId),
        `${token}.${kind}.lock`
      );
      const existing = held.get(leasePath);
      const entry = existing?.entry ?? table.tryTake(leasePath);
      assert(entry !== null, "a lease path belongs to one backend");
      // Publish first, probe second (WorkspaceUseLeases.hold). A nested hold probes too.
      const gate = inspectInMemory(table, workspaceMutationLockPath(rootDir, workspaceId));
      if (gate.state === "held") {
        if (existing === undefined) table.free(leasePath, entry);
        return Promise.reject(
          new WorkspaceMutationInProgressError(
            workspaceMutationInProgressMessage(workspaceId, gate)
          )
        );
      }
      if (existing === undefined) held.set(leasePath, { count: 1, entry });
      else existing.count++;
      let released = false;
      return Promise.resolve({
        // Idempotent: a second call never releases another holder's share.
        release: () => {
          if (released) return Promise.resolve();
          released = true;
          const file = held.get(leasePath);
          assert(file !== undefined && file.count > 0, `use lease ${kind} over-released`);
          file.count--;
          if (file.count === 0) {
            held.delete(leasePath);
            table.free(leasePath, file.entry);
          }
          return Promise.resolve();
        },
      });
    },
    // Every backend's live lease of that kind, as WorkspaceUseLeases.isHeld lists the folder.
    isHeld: (workspaceId, kind) => {
      const dir = workspaceUseLockDir(rootDir, workspaceId);
      return Promise.resolve(
        table.anyLive(
          (lockPath) => path.dirname(lockPath) === dir && lockPath.endsWith(`.${kind}.lock`)
        )
      );
    },
  };
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

/**
 * The memory locks over one table. SessionLocksMemory gives each build its own. files gets the
 * lock folders: nodeHostFiles makes them on the disk as the Node locks do.
 */
export function memorySessionLocks(
  clock: HostClock,
  table: MemoryLockTable,
  files: HostFiles
): SessionLocks {
  // One object per config, as workspaceUseLeasesFor gives.
  const leasesByConfig = new WeakMap<object, UseLeases>();
  return {
    // Pure memory already: every session-file service shares this one FIFO.
    workspaceFiles: nodeSessionLocks.workspaceFiles,
    acquireProcessFileLock: async (options): Promise<ProcessFileLock> => {
      const { lockPath, label, timeoutMs } = options;
      // The same argument checks as fileLock.ts acquireProcessFileLock.
      assert(lockPath.length > 0, "acquireProcessFileLock requires a lock path");
      assert(timeoutMs > 0, "acquireProcessFileLock timeoutMs must be positive");
      // The folder as fileLock.ts makes it, but no lock file.
      const entry = await acquireAfterFolder(table, files, lockPath, (giveUp) =>
        acquireInMemory(
          table,
          lockPath,
          timeoutMs,
          clock,
          (blocker) => {
            const { why, ...holder } = blocker;
            return new Error(fileLockTimeoutMessage(label, lockPath, timeoutMs, { holder, why }));
          },
          giveUp
        )
      );
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
      const refusal = (blocker: Blocker) =>
        new CrossProcessLockTimeoutError(
          crossProcessLockTimeoutMessage(timeoutMessage, lockPath, {
            holder: foreignRecord(blocker.pid, blocker.identity),
            why: blocker.why,
          })
        );
      // The folder as crossProcessLock.ts makes it, but no lock record.
      const entry = await acquireAfterFolder(
        table,
        files,
        lockPath,
        (giveUp) =>
          acquireInMemory(
            table,
            lockPath,
            acquireTimeoutMs,
            clock,
            refusal,
            signal === undefined ? giveUp : AbortSignal.any([signal, giveUp])
          ),
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
    useLeasesFor: (config) => {
      let leases = leasesByConfig.get(config);
      if (leases === undefined) {
        leases = memoryLeases(table, config.rootDir);
        leasesByConfig.set(config, leases);
      }
      return leases;
    },
  };
}

/** Each build gets fresh lock tables: no lock state outlives a test's layer. */
export const SessionLocksMemory: Layer.Layer<SessionLocksTag, never, HostClockTag | HostFilesTag> =
  Layer.effect(
    SessionLocksTag,
    Effect.gen(function* () {
      const clock = yield* HostClockTag;
      const files = yield* HostFilesTag;
      return memorySessionLocks(clock, new MemoryLockTable(), files);
    })
  );
