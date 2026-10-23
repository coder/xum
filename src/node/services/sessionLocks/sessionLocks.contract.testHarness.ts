/**
 * One contract for every SessionLocks layer (Node, memory, and each of them
 * with foreign holders), so the fakes cannot drift from the real locks. Each
 * case builds a fresh layer: no holders, clock or lock state is shared.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Effect, type Layer } from "effect";
import { SessionLocksTag } from "@/node/services/di/tags";
import type { ProcessIdentity } from "@/node/utils/concurrency/processLiveness";
import { CrossProcessLockTimeoutError } from "@/node/utils/concurrency/lockErrors";
import type { SessionLocks } from "./sessionLocks";

/** Builds a SessionLocks layer into its service. The layers keep no scope. */
export async function buildSessionLocks(
  layer: Layer.Layer<SessionLocksTag>
): Promise<SessionLocks> {
  return await Effect.runPromise(
    Effect.gen(function* () {
      return yield* SessionLocksTag;
    }).pipe(Effect.provide(layer))
  );
}

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
      await fn(await buildSessionLocks(t.layer), t);
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
