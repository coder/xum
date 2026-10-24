/**
 * One contract for every SessionLocks layer (Node, memory, and each of them
 * with foreign holders), so the fakes cannot drift from the real locks. Each
 * case builds a fresh layer: no holders, clock or lock state is shared.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Layer } from "effect";
import type { SessionLocksTag } from "@/node/services/di/tags";
import {
  WorkspaceMutationInProgressError,
  workspaceMutationInProgressMessage,
  workspaceMutationLockPath,
  workspaceUseLockDir,
} from "@/node/services/workspaceUseLeases";
import type { ProcessIdentity } from "@/node/utils/concurrency/processLiveness";
import { CrossProcessLockTimeoutError } from "@/node/utils/concurrency/lockErrors";
import { describeHolder } from "@/node/utils/main/crossProcessLock";
import { foreignRecord, liveBlocker } from "./foreignHolders.testHarness";
import { buildSessionLocks } from "./buildSessionLocks.testHarness";
import type { SessionLocks } from "./sessionLocks";

/** Another backend that holds a lock, in the medium of the layer under test. */
export interface ForeignHolder {
  pid: number;
  /** The identity the holder recorded; null when the medium records none. */
  identity: ProcessIdentity | null;
  /** Frees the lock as a clean release would. */
  release(): Promise<void>;
}

/** What the contract needs from one layer under test. */
export interface LocksUnderTest {
  layer: Layer.Layer<SessionLocksTag>;
  /** A temp dir for lock paths, removed by cleanup(). */
  dir: string;
  /** Puts a foreign holder on lockPath: live, or dead (its process is gone). */
  foreignHolder(
    lockPath: string,
    state: "live" | "dead",
    kind: "file" | "record"
  ): Promise<ForeignHolder>;
  /** Moves time by ms: TestClock.adjust for memory, a real sleep for Node. */
  advance(ms: number): Promise<void>;
  cleanup(): Promise<void>;
}

const SHORT_MS = 200;

export function describeSessionLocksContract(
  name: string,
  make: () => Promise<LocksUnderTest>
): void {
  const withLayer = async (fn: (locks: SessionLocks, t: LocksUnderTest) => Promise<void>) => {
    const t = await make();
    try {
      await fn(buildSessionLocks(t.layer), t);
    } finally {
      await t.cleanup();
    }
  };

  describe(`SessionLocks contract: ${name}`, () => {
    test("a file lock held by a live foreign holder times out after advance(timeoutMs)", () =>
      withLayer(async (locks, t) => {
        const lockPath = path.join(t.dir, "held.lock");
        const holder = await t.foreignHolder(lockPath, "live", "file");
        const acquire = locks.acquireProcessFileLock({
          lockPath,
          timeoutMs: SHORT_MS,
          label: "contract lock",
        });
        const refused = acquire.then(
          () => null,
          (error: unknown) => error
        );
        await t.advance(SHORT_MS);
        const error = await refused;
        expect(error).toBeInstanceOf(Error);
        expect(String((error as Error).message)).toStartWith(
          `Timed out acquiring contract lock ${lockPath} after ${SHORT_MS}ms.`
        );
        expect((error as Error).message).toContain(`pid ${holder.pid}`);
        await holder.release();
      }));

    test("release frees a file lock, and assertStillOwned passes while held", () =>
      withLayer(async (locks, t) => {
        const lockPath = path.join(t.dir, "own.lock");
        const options = { lockPath, timeoutMs: SHORT_MS, label: "contract lock" };
        const lock = await locks.acquireProcessFileLock(options);
        await lock.assertStillOwned();
        await lock[Symbol.asyncDispose]();
        const again = await locks.acquireProcessFileLock(options);
        await again[Symbol.asyncDispose]();
      }));

    test("acquireTimeoutMs 0 on a record of a live holder throws at once", () =>
      withLayer(async (locks, t) => {
        const lockPath = path.join(t.dir, "record.lock");
        const holder = await t.foreignHolder(lockPath, "live", "record");
        const error = await locks
          .acquireCrossProcessLock({
            lockPath,
            acquireTimeoutMs: 0,
            staleMs: 60_000,
            timeoutMessage: "contract record is held.",
          })
          .then(
            () => null,
            (caught: unknown) => caught
          );
        expect(error).toBeInstanceOf(CrossProcessLockTimeoutError);
        expect((error as Error).message).toStartWith(
          `contract record is held. Lock ${lockPath} is held by pid ${holder.pid}`
        );
        await holder.release();
      }));

    test("inspect gives absent, then held, then dead", () =>
      withLayer(async (locks, t) => {
        const live = path.join(t.dir, "live.lock");
        expect(await locks.inspectCrossProcessLock(live)).toEqual({ state: "absent" });
        const holder = await t.foreignHolder(live, "live", "record");
        expect(await locks.inspectCrossProcessLock(live)).toMatchObject({ state: "held" });
        await holder.release();
        const dead = path.join(t.dir, "dead.lock");
        await t.foreignHolder(dead, "dead", "record");
        expect(await locks.inspectCrossProcessLock(dead)).toEqual({ state: "dead" });
      }));

    test("a dead foreign holder is reclaimed", () =>
      withLayer(async (locks, t) => {
        const file = path.join(t.dir, "dead-file.lock");
        await t.foreignHolder(file, "dead", "file");
        const lock = await locks.acquireProcessFileLock({
          lockPath: file,
          timeoutMs: SHORT_MS,
          label: "contract lock",
        });
        await lock[Symbol.asyncDispose]();
        const record = path.join(t.dir, "dead-record.lock");
        await t.foreignHolder(record, "dead", "record");
        const release = await locks.acquireCrossProcessLock({
          lockPath: record,
          acquireTimeoutMs: 0,
          staleMs: 60_000,
          timeoutMessage: "contract record is held.",
        });
        await release();
      }));

    test("an aborted signal wins over a live holder of a record", () =>
      withLayer(async (locks, t) => {
        const lockPath = path.join(t.dir, "aborted.lock");
        const holder = await t.foreignHolder(lockPath, "live", "record");
        const error = await locks
          .acquireCrossProcessLock({
            lockPath,
            acquireTimeoutMs: SHORT_MS,
            staleMs: 60_000,
            timeoutMessage: "contract record is held.",
            signal: AbortSignal.abort(),
          })
          .then(
            () => null,
            (caught: unknown) => caught
          );
        expect(error).not.toBeInstanceOf(CrossProcessLockTimeoutError);
        expect((error as Error).message).toBe("Lock acquisition was aborted");
        await holder.release();
      }));

    test("createParentDirectory false on a missing parent rejects with ENOENT", () =>
      withLayer(async (locks, t) => {
        const error = await locks
          .acquireCrossProcessLock({
            lockPath: path.join(t.dir, "removed-run", "run.lock"),
            createParentDirectory: false,
            acquireTimeoutMs: 0,
            staleMs: 60_000,
            timeoutMessage: "contract record is held.",
          })
          .then(
            () => null,
            (caught: unknown) => caught
          );
        expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
      }));

    test("a file lock creates its missing parent", () =>
      withLayer(async (locks, t) => {
        const lockPath = path.join(t.dir, "new-file-dir", "file.lock");
        const lock = await locks.acquireProcessFileLock({
          lockPath,
          timeoutMs: SHORT_MS,
          label: "contract lock",
        });
        expect((await fs.stat(path.dirname(lockPath))).isDirectory()).toBe(true);
        await lock[Symbol.asyncDispose]();
      }));

    test("a record lock creates its missing parent by default", () =>
      withLayer(async (locks, t) => {
        const lockPath = path.join(t.dir, "new-dir", "record.lock");
        const release = await locks.acquireCrossProcessLock({
          lockPath,
          acquireTimeoutMs: 0,
          staleMs: 60_000,
          timeoutMessage: "contract record is held.",
        });
        expect((await fs.stat(path.dirname(lockPath))).isDirectory()).toBe(true);
        await release();
      }));

    test("an aborted signal wins over a missing parent", () =>
      withLayer(async (locks, t) => {
        const error = await locks
          .acquireCrossProcessLock({
            lockPath: path.join(t.dir, "removed-run", "run.lock"),
            createParentDirectory: false,
            acquireTimeoutMs: 0,
            staleMs: 60_000,
            timeoutMessage: "contract record is held.",
            signal: AbortSignal.abort(),
          })
          .then(
            () => null,
            (caught: unknown) => caught
          );
        expect((error as Error).message).toBe("Lock acquisition was aborted");
      }));

    test("useLeasesFor gives one object per config: hold, isHeld, release", () =>
      withLayer(async (locks, t) => {
        const config = { rootDir: t.dir };
        const leases = locks.useLeasesFor(config);
        expect(locks.useLeasesFor(config)).toBe(leases);
        const lease = await leases.hold("ws-contract", "turn");
        expect(await leases.isHeld("ws-contract", "turn")).toBe(true);
        await lease.release();
        expect(await leases.isHeld("ws-contract", "turn")).toBe(false);
      }));

    test("a live foreign mutator makes hold refuse with today's text, and its release admits", () =>
      withLayer(async (locks, t) => {
        const leases = locks.useLeasesFor({ rootDir: t.dir });
        const gate = workspaceMutationLockPath(t.dir, "ws-gate");
        const mutator = await t.foreignHolder(gate, "live", "record");
        const error = await leases.hold("ws-gate", "turn").then(
          () => null,
          (caught: unknown) => caught
        );
        expect(error).toBeInstanceOf(WorkspaceMutationInProgressError);
        const identity = mutator.identity ?? undefined;
        expect((error as Error).message).toBe(
          workspaceMutationInProgressMessage("ws-gate", {
            holder: describeHolder(foreignRecord(mutator.pid, identity)),
            why: liveBlocker(mutator.pid, identity).why,
          })
        );
        // The refused hold withdrew its lease.
        expect(await leases.isHeld("ws-gate", "turn")).toBe(false);
        await mutator.release();
        const lease = await leases.hold("ws-gate", "turn");
        await lease.release();
      }));

    test("isHeld sees another backend's live lease of that kind, and not a dead one", () =>
      withLayer(async (locks, t) => {
        const leases = locks.useLeasesFor({ rootDir: t.dir });
        const dir = workspaceUseLockDir(t.dir, "ws-leases");
        const live = await t.foreignHolder(
          path.join(dir, "other-backend.turn.lock"),
          "live",
          "record"
        );
        await t.foreignHolder(path.join(dir, "other-backend.exec.lock"), "dead", "record");
        expect(await leases.isHeld("ws-leases", "turn")).toBe(true);
        expect(await leases.isHeld("ws-leases", "exec")).toBe(false);
        expect(await leases.isHeld("ws-leases", "terminal")).toBe(false);
        await live.release();
        expect(await leases.isHeld("ws-leases", "turn")).toBe(false);
      }));

    test("workspaceFiles runs two operations on one key in FIFO order", () =>
      withLayer(async (locks) => {
        const order: string[] = [];
        const first = Promise.withResolvers<void>();
        const a = locks.workspaceFiles.withLock("ws-contract", async () => {
          order.push("a start");
          await first.promise;
          order.push("a end");
        });
        const b = locks.workspaceFiles.withLock("ws-contract", () => {
          order.push("b");
          return Promise.resolve();
        });
        first.resolve();
        await Promise.all([a, b]);
        expect(order).toEqual(["a start", "a end", "b"]);
      }));
  });
}
