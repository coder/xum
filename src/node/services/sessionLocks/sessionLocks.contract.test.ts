import { afterEach, expect, test } from "bun:test";
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Layer } from "effect";
import { SessionLocksTag } from "@/node/services/di/tags";
import { HostClockTag } from "@/node/services/di/hostClockLive";
import { makeTestEffectRunner } from "@/node/services/di/testEffectRunner";
import type { HostFiles } from "@/node/services/hostFiles/hostFiles";
import { createMemoryHost } from "@/node/services/hostFiles/memoryHostFiles.testHarness";
import { HostFilesNode, nodeHostFiles } from "@/node/services/hostFiles/nodeHostFiles";
import {
  WorkspaceMutationInProgressError,
  workspaceMutationLockPath,
} from "@/node/services/workspaceUseLeases";
import { fileLockTimeoutMessage } from "@/node/utils/concurrency/fileLock";
import { CrossProcessLockTimeoutError } from "@/node/utils/concurrency/lockErrors";
import type { ProcessIdentity } from "@/node/utils/concurrency/processLiveness";
import {
  foreignIdentity,
  foreignPid,
  liveBlocker,
  makeForeignHolders,
  withForeignHolders,
  wrapWithForeignHolders,
} from "./foreignHolders.testHarness";
import {
  MemoryLockTable,
  memorySessionLocks,
  SessionLocksMemory,
} from "./memorySessionLocks.testHarness";
import { nodeSessionLocks, SessionLocksNode } from "./nodeSessionLocks";
import { buildSessionLocks } from "./buildSessionLocks.testHarness";
import {
  describeSessionLocksContract,
  type ForeignHolder,
  type LocksUnderTest,
} from "./sessionLocks.contract.testHarness";
import type { SessionLocks } from "./sessionLocks";

const CHILD = path.join(import.meta.dir, "sessionLocks.testChild.ts");
const children: Array<ReturnType<typeof Bun.spawn>> = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

/**
 * A real foreign holder: another process takes the lock (sessionLocks.testChild.ts).
 * Dead: the test kills it with SIGKILL, so the lock stays behind with a dead pid.
 */
async function childHolder(
  lockPath: string,
  state: "live" | "dead",
  kind: "file" | "record"
): Promise<ForeignHolder> {
  const child = Bun.spawn(["bun", CHILD, kind, lockPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  children.push(child);
  const reader = child.stdout.getReader();
  let output = "";
  while (!output.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`the holder exited before it was ready: ${output}`);
    output += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  const ready = /^ready (.*)$/m.exec(output);
  if (ready === null) throw new Error(`unexpected holder output: ${output}`);
  const { pid, identity } = JSON.parse(ready[1]) as { pid: number; identity: ProcessIdentity };
  if (state === "dead") {
    child.kill("SIGKILL");
    await child.exited;
  }
  return {
    pid,
    identity,
    release: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.write("release\n");
      await child.stdin.end();
      await child.exited;
    },
  };
}

async function nodeLocks(): Promise<LocksUnderTest> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-session-locks-"));
  return {
    layer: SessionLocksNode,
    dir,
    foreignHolder: childHolder,
    advance: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

/** The memory layer over a table the test can reach, on a fresh TestClock. */
async function memoryLocks(): Promise<LocksUnderTest> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-session-locks-"));
  const clock = makeTestEffectRunner();
  const table = new MemoryLockTable();
  return {
    // The lock folders on the disk, as the Node locks make them: the contract stats them there.
    layer: Layer.succeed(SessionLocksTag)(
      memorySessionLocks(clock.hostClock, table, nodeHostFiles)
    ),
    dir,
    foreignHolder: (lockPath, state) => {
      table.hold(lockPath, state, { pid: foreignPid(1) });
      return Promise.resolve({
        pid: foreignPid(1),
        identity: foreignIdentity(),
        release: () => Promise.resolve(table.release(lockPath)),
      });
    },
    advance: (ms) => clock.adjust(ms),
    cleanup: async () => {
      await clock.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/** Wraps a layer under test: its foreign holders come from makeForeignHolders. */
function withForeign(make: () => Promise<LocksUnderTest>): () => Promise<LocksUnderTest> {
  return async () => {
    const t = await make();
    const holders = makeForeignHolders();
    return {
      ...t,
      layer: withForeignHolders(t.layer, holders),
      foreignHolder: (lockPath, state) => {
        holders.hold(lockPath, state, { pid: foreignPid(2) });
        return Promise.resolve({
          pid: foreignPid(2),
          identity: foreignIdentity(),
          release: () => Promise.resolve(holders.release(lockPath)),
        });
      },
    };
  };
}

describeSessionLocksContract("node", nodeLocks);
describeSessionLocksContract("memory", memoryLocks);
describeSessionLocksContract("node + foreign", withForeign(nodeLocks));
describeSessionLocksContract("memory + foreign", withForeign(memoryLocks));

test("node: the timeout text for a live child holder is fileLockTimeoutMessage", async () => {
  const t = await nodeLocks();
  try {
    const locks = buildSessionLocks(t.layer);
    const lockPath = path.join(t.dir, "text.lock");
    const holder = await t.foreignHolder(lockPath, "live", "file");
    const error = await locks
      .acquireProcessFileLock({ lockPath, timeoutMs: 200, label: "contract lock" })
      .then(
        () => null,
        (caught: unknown) => caught
      );
    // The fake layers refuse with liveBlocker, so the fake text equals the Node text.
    expect((error as Error).message).toBe(
      fileLockTimeoutMessage(
        "contract lock",
        lockPath,
        200,
        liveBlocker(holder.pid, holder.identity ?? undefined)
      )
    );
    await holder.release();
  } finally {
    await t.cleanup();
  }
});

/** Runs fn on the memory layer of a fresh memoryLocks(), then cleans up. */
async function onMemory(
  fn: (locks: SessionLocks, t: LocksUnderTest) => Promise<void>
): Promise<void> {
  const t = await memoryLocks();
  try {
    await fn(buildSessionLocks(t.layer), t);
  } finally {
    await t.cleanup();
  }
}

test("memory: a 60 s timeout passes on TestClock.adjust, with no real wait", () =>
  onMemory(async (locks, t) => {
    const lockPath = path.join(t.dir, "long.lock");
    await t.foreignHolder(lockPath, "live", "file");
    const refused = locks
      .acquireProcessFileLock({ lockPath, timeoutMs: 60_000, label: "contract lock" })
      .then(
        () => null,
        (error: unknown) => error
      );
    await t.advance(59_999);
    let settled = false;
    void refused.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await t.advance(1);
    expect(((await refused) as Error).message).toBe(
      fileLockTimeoutMessage("contract lock", lockPath, 60_000, liveBlocker(foreignPid(1)))
    );
  }));

/**
 * HostFiles on a memory volume whose mkdir calls wait until the test lets each one finish, so a
 * test picks the order in which the lock folders are ready.
 */
function heldFolders(): { files: HostFiles; finish(index: number, error?: Error): void } {
  const host = createMemoryHost().files;
  const pending: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  const mkdir = async (...args: Parameters<HostFiles["promises"]["mkdir"]>) => {
    const gate = Promise.withResolvers<void>();
    pending.push(gate);
    await gate.promise;
    return await host.promises.mkdir(...args);
  };
  return {
    files: {
      ...host,
      promises: { ...host.promises, mkdir: mkdir as HostFiles["promises"]["mkdir"] },
    },
    // An error fails that mkdir with it.
    finish: (index, error) => {
      const gate = pending[index];
      assert(gate !== undefined, `mkdir ${index} was not called`);
      if (error === undefined) gate.resolve();
      else gate.reject(error);
    },
  };
}

test("memory: a release hands the file lock to the waiters in FIFO order", async () => {
  const clock = makeTestEffectRunner();
  try {
    const folders = heldFolders();
    const locks = memorySessionLocks(clock.hostClock, new MemoryLockTable(), folders.files);
    const options = { lockPath: "/tmp/session/fifo.lock", timeoutMs: 1_000, label: "l" };
    const firstLock = locks.acquireProcessFileLock(options);
    folders.finish(0);
    const first = await firstLock;
    const order: string[] = [];
    const waiter = (name: string) =>
      locks.acquireProcessFileLock(options).then(async (lock) => {
        order.push(name);
        await lock[Symbol.asyncDispose]();
      });
    const both = Promise.all([waiter("b"), waiter("c")]);
    // c's folder is ready first. The queue still follows the call order.
    folders.finish(2);
    folders.finish(1);
    await first[Symbol.asyncDispose]();
    await both;
    expect(order).toEqual(["b", "c"]);
    const stale = await first.assertStillOwned().then(
      () => null,
      (error: unknown) => error
    );
    expect((stale as Error).message).toContain("is no longer owned by this holder");
  } finally {
    await clock.dispose();
  }
});

test("memory: a failed lock folder rejects with its error and gives up the lock or the place", async () => {
  const clock = makeTestEffectRunner();
  try {
    const folders = heldFolders();
    const table = new MemoryLockTable();
    const locks = memorySessionLocks(clock.hostClock, table, folders.files);
    const lockPath = "/tmp/session/fail.lock";
    const options = { lockPath, timeoutMs: 1_000, label: "l" };
    const folderError = new Error("EACCES: the lock folder");
    const rejection = (acquire: Promise<unknown>) =>
      acquire.then(
        () => null,
        (error: unknown) => error
      );
    // The lock was free: the caller had taken it before its folder failed.
    const taken = rejection(locks.acquireProcessFileLock(options));
    folders.finish(0, folderError);
    expect(await taken).toBe(folderError);
    expect(table.owner(lockPath)).toBeUndefined();
    // The lock was held: the caller had a place in the queue before its folder failed.
    const holderLock = locks.acquireProcessFileLock(options);
    folders.finish(1);
    const holder = await holderLock;
    const queued = rejection(locks.acquireProcessFileLock(options));
    folders.finish(2, folderError);
    expect(await queued).toBe(folderError);
    await holder[Symbol.asyncDispose]();
    expect(table.owner(lockPath)).toBeUndefined();
  } finally {
    await clock.dispose();
  }
});

test("memory: an abort during the folder's mkdir rejects and frees the lock it took", async () => {
  const clock = makeTestEffectRunner();
  try {
    const folders = heldFolders();
    const table = new MemoryLockTable();
    const locks = memorySessionLocks(clock.hostClock, table, folders.files);
    const lockPath = "/tmp/run/abort.lock";
    const controller = new AbortController();
    const acquire = locks
      .acquireCrossProcessLock({
        lockPath,
        acquireTimeoutMs: 0,
        staleMs: 60_000,
        timeoutMessage: "record is held.",
        signal: controller.signal,
      })
      .then(
        () => null,
        (error: unknown) => error
      );
    // The lock was free, so the acquire holds it while its folder is made.
    expect(table.owner(lockPath)).toBeDefined();
    controller.abort();
    folders.finish(0);
    expect(((await acquire) as Error).message).toBe("Lock acquisition was aborted");
    expect(table.owner(lockPath)).toBeUndefined();
  } finally {
    await clock.dispose();
  }
});

test("memory: a held file lock leaves no file at its path", () =>
  onMemory(async (locks, t) => {
    const lockPath = path.join(t.dir, "session", "held.lock");
    const lock = await locks.acquireProcessFileLock({ lockPath, timeoutMs: 200, label: "l" });
    const found = await fs.stat(lockPath).then(
      () => true,
      () => false
    );
    expect(found).toBe(false);
    await lock[Symbol.asyncDispose]();
  }));

test("memory: an init-record lock makes a real file, and inspect sees it", () =>
  onMemory(async (locks, t) => {
    const lockPath = path.join(t.dir, "locks", "init-record", "ws", "backend.lock");
    const release = await locks.acquireCrossProcessLock({
      lockPath,
      acquireTimeoutMs: 0,
      staleMs: 60_000,
      timeoutMessage: "init record is held.",
    });
    expect((await fs.stat(lockPath)).isFile()).toBe(true);
    expect(await locks.inspectCrossProcessLock(lockPath)).toMatchObject({ state: "held" });
    await release();
    expect(await locks.inspectCrossProcessLock(lockPath)).toEqual({ state: "absent" });
  }));

test("memory: each build of SessionLocksMemory has its own lock table", () =>
  onMemory(async (_locks, t) => {
    const clock = makeTestEffectRunner();
    try {
      const layer = SessionLocksMemory.pipe(
        Layer.provide(Layer.succeed(HostClockTag)(clock.hostClock)),
        Layer.provide(HostFilesNode)
      );
      const options = { lockPath: path.join(t.dir, "one.lock"), timeoutMs: 200, label: "l" };
      const a = await buildSessionLocks(layer).acquireProcessFileLock(options);
      const b = await buildSessionLocks(layer).acquireProcessFileLock(options);
      await a[Symbol.asyncDispose]();
      await b[Symbol.asyncDispose]();
    } finally {
      await clock.dispose();
    }
  }));

test("foreign: dead holders are reclaimed in order, and a probe reclaims none", async () => {
  const t = await nodeLocks();
  try {
    const holders = makeForeignHolders();
    const locks = buildSessionLocks(withForeignHolders(t.layer, holders));
    const file = path.join(t.dir, "a.lock");
    const record = path.join(t.dir, "b.lock");
    holders.hold(record, "dead");
    holders.hold(file, "dead");
    expect(await locks.inspectCrossProcessLock(record)).toEqual({ state: "dead" });
    const lock = await locks.acquireProcessFileLock({ lockPath: file, timeoutMs: 200, label: "l" });
    const release = await locks.acquireCrossProcessLock({
      lockPath: record,
      acquireTimeoutMs: 0,
      staleMs: 60_000,
      timeoutMessage: "held.",
    });
    expect(holders.reclaimed).toEqual([file, record]);
    await lock[Symbol.asyncDispose]();
    await release();
  } finally {
    await t.cleanup();
  }
});

test("foreign: a missing parent wins over a live holder when createParentDirectory is false", async () => {
  const t = await nodeLocks();
  try {
    const holders = makeForeignHolders();
    const locks = buildSessionLocks(withForeignHolders(t.layer, holders));
    const lockPath = path.join(t.dir, "removed-run", "run.lock");
    holders.hold(lockPath, "live");
    const acquire = () =>
      locks
        .acquireCrossProcessLock({
          lockPath,
          createParentDirectory: false,
          acquireTimeoutMs: 0,
          staleMs: 60_000,
          timeoutMessage: "held.",
        })
        .then(
          () => null,
          (error: unknown) => error
        );
    expect(await acquire()).toMatchObject({ code: "ENOENT" });
    // With the parent back, the live holder refuses again.
    await fs.mkdir(path.dirname(lockPath));
    expect(await acquire()).toBeInstanceOf(CrossProcessLockTimeoutError);
  } finally {
    await t.cleanup();
  }
});

test("foreign: a missing parent wins over a live holder for a file lock without createParentDir", async () => {
  const t = await nodeLocks();
  try {
    const holders = makeForeignHolders();
    const locks = buildSessionLocks(withForeignHolders(t.layer, holders));
    const lockPath = path.join(t.dir, "removed-session", "blobs.lock");
    holders.hold(lockPath, "live");
    const acquire = () =>
      locks
        .acquireProcessFileLock({
          lockPath,
          createParentDir: false,
          timeoutMs: 200,
          label: "contract lock",
        })
        .then(
          () => null,
          (error: unknown) => error
        );
    expect(await acquire()).toMatchObject({ code: "ENOENT" });
    // With the parent back, the live holder refuses again.
    await fs.mkdir(path.dirname(lockPath));
    expect(((await acquire()) as Error).message).toBe(
      fileLockTimeoutMessage("contract lock", lockPath, 200, liveBlocker(foreignPid()))
    );
  } finally {
    await t.cleanup();
  }
});

test("foreign: hold() publishes its lease before it probes the gate", async () => {
  const t = await nodeLocks();
  try {
    const holders = makeForeignHolders();
    const gate = workspaceMutationLockPath(t.dir, "ws-order");
    // A mutator takes the gate while the inner hold publishes the lease.
    const inner = {
      ...nodeSessionLocks,
      useLeasesFor: (config: { readonly rootDir: string }) => {
        const leases = nodeSessionLocks.useLeasesFor(config);
        return {
          hold: async (...args: Parameters<typeof leases.hold>) => {
            const lease = await leases.hold(...args);
            holders.hold(gate, "live", { pid: foreignPid(4) });
            return lease;
          },
          isHeld: (...args: Parameters<typeof leases.isHeld>) => leases.isHeld(...args),
        };
      },
    };
    const leases = wrapWithForeignHolders(inner, holders).useLeasesFor({ rootDir: t.dir });
    const refused = await leases.hold("ws-order", "turn").then(
      () => null,
      (error: unknown) => error
    );
    expect(refused).toBeInstanceOf(WorkspaceMutationInProgressError);
    expect(await leases.isHeld("ws-order", "turn")).toBe(false);
  } finally {
    await t.cleanup();
  }
});
