/**
 * A SessionLocks layer that plays other backends: a test puts a live or dead
 * foreign holder on a lock path, and the wrapped layer refuses or reclaims as
 * the Node locks would, with today's text. A live holder refuses at once (the
 * Node locks would wait the whole timeout first), so tests need no real wait.
 */
import assert from "node:assert";
import { Effect, Layer } from "effect";
import { SessionLocksTag } from "@/node/services/di/tags";
import {
  workspaceMutationInProgressMessage,
  workspaceMutationLockPath,
} from "@/node/services/workspaceUseLeases";
import { fileLockTimeoutMessage, type FileLockBlocker } from "@/node/utils/concurrency/fileLock";
import {
  CrossProcessLockTimeoutError,
  WorkspaceMutationInProgressError,
} from "@/node/utils/concurrency/lockErrors";
import { getSelfIdentity, type ProcessIdentity } from "@/node/utils/concurrency/processLiveness";
import {
  crossProcessLockTimeoutMessage,
  describeHolder,
  type CrossProcessLockHolder,
} from "@/node/utils/main/crossProcessLock";
import type { SessionLocks } from "./sessionLocks";

/**
 * The Node locks' reason for a live holder with a current record in this PID
 * domain (processLiveness.judgeHolder). A record without an identity takes the
 * legacy branch, which words it otherwise, so every fake holder has one.
 */
const LIVE_WHY = process.platform === "linux" ? "that process is running" : "that pid is running";

/**
 * The identity a fake foreign holder records: another backend on this host, so
 * the same platform, boot and PID namespace. It borrows this process's start
 * time, which only describeHolder prints.
 */
export function foreignIdentity(): ProcessIdentity {
  return getSelfIdentity();
}

/** A fake holder pid: n > 0 apart from this process, so it is never this process. */
export function foreignPid(n = 1): number {
  assert(Number.isInteger(n) && n > 0, "foreignPid needs a positive integer");
  return process.pid + n;
}

/** Why the Node locks refuse a live holder with this pid: the blocker of their timeout text. */
export function liveBlocker(
  pid: number,
  identity: ProcessIdentity = foreignIdentity()
): FileLockBlocker {
  return { holder: { pid, identity }, why: LIVE_WHY };
}

/** The record a live foreign holder would have written: describeHolder reads pid and identity. */
export function foreignRecord(
  pid: number,
  identity: ProcessIdentity = foreignIdentity()
): CrossProcessLockHolder {
  return { pid, token: `foreign-${pid}`, acquiredAt: 0, identity };
}

/** The error of a Node acquire whose signal is aborted: it checks the signal before any attempt. */
export function abortedAcquireError(): Error {
  return new Error("Lock acquisition was aborted");
}

/** The handle that the test keeps. It holds the foreign holders, not the locks. */
export interface ForeignHolders {
  /**
   * Another backend holds lockPath. live: refuse at once.
   * dead: the next acquire reclaims it, and inspect says "dead" until then.
   */
  hold(lockPath: string, state: "live" | "dead", holder?: { pid: number }): void;
  /** The foreign holder of lockPath released it cleanly. */
  release(lockPath: string): void;
  /** Paths whose dead holder an acquire reclaimed, in order. */
  readonly reclaimed: readonly string[];
}

interface Holder {
  state: "live" | "dead";
  pid: number;
}

/** The test's side of makeForeignHolders: wrapWithForeignHolders reads the same map. */
const holdersOf = new WeakMap<ForeignHolders, Map<string, Holder>>();

export function makeForeignHolders(): ForeignHolders {
  const table = new Map<string, Holder>();
  const reclaimed: string[] = [];
  const holders: ForeignHolders = {
    hold: (lockPath, state, holder) => {
      const pid = holder?.pid ?? foreignPid();
      assert(pid !== process.pid, "a foreign holder must not be this process");
      table.set(lockPath, { state, pid });
    },
    release: (lockPath) => {
      assert(table.delete(lockPath), `no foreign holder on ${lockPath}`);
    },
    reclaimed,
  };
  holdersOf.set(holders, table);
  return holders;
}

/**
 * The locks that check the foreign holders before each call. A dead holder is
 * reclaimed by the acquire that meets it: it leaves the table, the path goes to
 * `reclaimed`, and the call goes on to the inner locks.
 */
export function wrapWithForeignHolders(inner: SessionLocks, holders: ForeignHolders): SessionLocks {
  const table = holdersOf.get(holders);
  assert(table !== undefined, "holders must come from makeForeignHolders");
  const reclaimed = holders.reclaimed as string[];
  /** The live holder of lockPath, after it reclaims a dead one. */
  const liveHolder = (lockPath: string): Holder | undefined => {
    const holder = table.get(lockPath);
    if (holder?.state === "dead") {
      table.delete(lockPath);
      reclaimed.push(lockPath);
      return undefined;
    }
    return holder;
  };
  // One object per config, as workspaceUseLeasesFor gives.
  const leasesByConfig = new WeakMap<object, ReturnType<SessionLocks["useLeasesFor"]>>();
  return {
    workspaceFiles: inner.workspaceFiles,
    acquireProcessFileLock: async (options) => {
      const holder = liveHolder(options.lockPath);
      if (holder !== undefined) {
        throw new Error(
          fileLockTimeoutMessage(
            options.label,
            options.lockPath,
            options.timeoutMs,
            liveBlocker(holder.pid)
          )
        );
      }
      return await inner.acquireProcessFileLock(options);
    },
    acquireCrossProcessLock: async (options) => {
      // crossProcessLock.ts checks the signal before each attempt: abort wins over a holder.
      if (options.signal?.aborted) throw abortedAcquireError();
      const holder = liveHolder(options.lockPath);
      if (holder !== undefined) {
        throw new CrossProcessLockTimeoutError(
          crossProcessLockTimeoutMessage(options.timeoutMessage, options.lockPath, {
            holder: foreignRecord(holder.pid),
            why: LIVE_WHY,
          })
        );
      }
      return await inner.acquireCrossProcessLock(options);
    },
    // A probe never reclaims: it reports what an acquire would do.
    inspectCrossProcessLock: async (lockPath) => {
      const holder = table.get(lockPath);
      if (holder === undefined) return await inner.inspectCrossProcessLock(lockPath);
      if (holder.state === "dead") return { state: "dead" };
      return { state: "held", holder: describeHolder(foreignRecord(holder.pid)), why: LIVE_WHY };
    },
    useLeasesFor: (config) => {
      const cached = leasesByConfig.get(config);
      if (cached !== undefined) return cached;
      const leases = inner.useLeasesFor(config);
      const wrapped: ReturnType<SessionLocks["useLeasesFor"]> = {
        // A live foreign mutator holds the gate. The inner hold reads the gate on
        // disk, where a fake holder leaves no file. Like WorkspaceUseLeases.hold, the
        // lease is published first and the gate probed second, so a mutator that
        // takes the gate meanwhile is not missed.
        hold: async (workspaceId, kind) => {
          const lease = await leases.hold(workspaceId, kind);
          const gate = table.get(workspaceMutationLockPath(config.rootDir, workspaceId));
          if (gate?.state === "live") {
            await lease.release();
            throw new WorkspaceMutationInProgressError(
              workspaceMutationInProgressMessage(workspaceId, {
                holder: describeHolder(foreignRecord(gate.pid)),
                why: LIVE_WHY,
              })
            );
          }
          return lease;
        },
        isHeld: (workspaceId, kind) => leases.isHeld(workspaceId, kind),
      };
      leasesByConfig.set(config, wrapped);
      return wrapped;
    },
  };
}

/** A layer that builds inner, then checks the foreign holders before each call. */
export function withForeignHolders(
  inner: Layer.Layer<SessionLocksTag>,
  holders: ForeignHolders
): Layer.Layer<SessionLocksTag> {
  return Layer.effect(
    SessionLocksTag,
    Effect.map(SessionLocksTag, (locks) => wrapWithForeignHolders(locks, holders))
  ).pipe(Layer.provide(inner));
}
