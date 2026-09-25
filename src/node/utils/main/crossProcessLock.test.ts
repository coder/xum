import { describe, expect, spyOn, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import {
  probeProcessBirth,
  setSelfIdentityForTesting,
} from "@/node/utils/concurrency/processLiveness";
import {
  acquireCrossProcessLock,
  CrossProcessLockTimeoutError,
  guardPath,
} from "./crossProcessLock";

async function tempLockPath(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cross-process-lock-"));
  return path.join(dir, "test.lock");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsPromises.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readToken(lockPath: string): Promise<string> {
  return (JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as { token: string }).token;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const baseOptions = {
  acquireTimeoutMs: 400,
  staleMs: 60_000,
  timeoutMessage: "lock busy",
};

async function expectRefused(lockPath: string, acquireTimeoutMs = 400): Promise<Error> {
  try {
    const release = await acquireCrossProcessLock({ lockPath, ...baseOptions, acquireTimeoutMs });
    await release();
  } catch (error) {
    expect(error).toBeInstanceOf(CrossProcessLockTimeoutError);
    expect((error as Error).message.startsWith("lock busy")).toBe(true);
    return error as Error;
  }
  throw new Error(`expected ${lockPath} to be refused, but it was acquired`);
}

async function expectAcquired(lockPath: string): Promise<void> {
  const release = await acquireCrossProcessLock({
    lockPath,
    ...baseOptions,
    acquireTimeoutMs: 3_000,
  });
  await release();
  expect(await pathExists(lockPath)).toBe(false);
}

/** A pid that exited (ESRCH), so it is provably dead in this PID domain. */
function deadPid(): number {
  for (;;) {
    const pid = spawnSync(process.execPath, ["-e", ""]).pid;
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
}

/** A live, unrelated process; stop it with the returned function. */
function liveProcess(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error("failed to spawn a live process");
  return { pid: child.pid, stop: () => child.kill("SIGKILL") };
}

/** This process's v2 identity fields, as written by a real acquisition. */
async function ownIdentity(): Promise<Record<string, unknown>> {
  const lockPath = await tempLockPath();
  const release = await acquireCrossProcessLock({ lockPath, ...baseOptions });
  const record = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as Record<
    string,
    unknown
  >;
  await release();
  const { pid: _pid, token: _token, acquiredAt: _acquiredAt, ...identity } = record;
  return identity;
}

async function writeRecord(file: string, record: Record<string, unknown>): Promise<void> {
  await fsPromises.writeFile(file, JSON.stringify({ acquiredAt: Date.now(), ...record }));
}

// ---- child-process harness -------------------------------------------------

const CHILD = path.join(import.meta.dir, "crossProcessLock.testChild.ts");

interface Child {
  proc: ChildProcess;
  next: (event?: string) => Promise<Record<string, unknown>>;
  send: (command: string) => void;
  exited: Promise<unknown>;
}

function startChild(role: string, lockPath: string, staleMs: number, arg = ""): Child {
  const proc = spawn(process.execPath, [CHILD, role, lockPath, String(staleMs), arg], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const events: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    events.push(JSON.parse(line) as Record<string, unknown>);
    waiters.splice(0).forEach((wake) => wake());
  });
  const exited = new Promise((resolve) => proc.on("exit", resolve));
  let exitedFlag = false;
  void exited.then(() => {
    exitedFlag = true;
    waiters.splice(0).forEach((wake) => wake());
  });
  return {
    proc,
    exited,
    send: (command) => proc.stdin.write(`${command}\n`),
    next: async (event) => {
      for (;;) {
        const found = events.findIndex((e) => event === undefined || e.event === event);
        if (found >= 0) return events.splice(found, 1)[0];
        if (exitedFlag)
          throw new Error(`child ${role} exited without emitting ${event ?? "an event"}`);
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

const unixOnly = process.platform === "win32";
const linuxOnly = process.platform !== "linux";

describe("acquireCrossProcessLock", () => {
  test("acquires, blocks a competing acquirer on a live holder, and releases", async () => {
    const lockPath = await tempLockPath();
    const release = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    const error = await expectRefused(lockPath);
    // Names the holder and path so a user can find and stop it.
    expect(error.message).toContain(lockPath);
    expect(error.message).toContain(`pid ${process.pid}`);
    expect(error.message).toContain("held by this process");
    await release();
    expect(await pathExists(lockPath)).toBe(false);
    await expectAcquired(lockPath);
  });

  test("createParentDirectory: false rejects a missing parent with ENOENT and creates nothing", async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cross-process-lock-parent-"));
    const parent = path.join(root, "run");
    const lockPath = path.join(parent, "test.lock");

    const error: unknown = await acquireCrossProcessLock({
      lockPath,
      ...baseOptions,
      createParentDirectory: false,
    }).then(
      () => null,
      (rejection: unknown) => rejection
    );

    expect(error).toMatchObject({ code: "ENOENT" });
    expect(await pathExists(parent)).toBe(false);
    expect(await fsPromises.readdir(root)).toEqual([]);
    // The failed attempt retired its token: the lock is takeable once the parent exists.
    await fsPromises.mkdir(parent);
    await expectAcquired(lockPath);
    // The default still creates a missing parent.
    await fsPromises.rm(parent, { recursive: true });
    await expectAcquired(lockPath);
    expect(await pathExists(parent)).toBe(true);
    await fsPromises.rm(root, { recursive: true, force: true });
  });

  test("a parent deleted while held is not recreated by renewal or release", async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cross-process-lock-parent-"));
    const parent = path.join(root, "run");
    await fsPromises.mkdir(parent);
    const lockPath = path.join(parent, "test.lock");
    // staleMs 1s => a renewal tick every 250 ms while held.
    const release = await acquireCrossProcessLock({
      lockPath,
      ...baseOptions,
      staleMs: 1_000,
      createParentDirectory: false,
    });

    await fsPromises.rm(parent, { recursive: true, force: true });
    await sleep(600); // At least two renewal ticks against the missing parent.
    await release();

    expect(await fsPromises.readdir(root)).toEqual([]);
    await fsPromises.rm(root, { recursive: true, force: true });
  });

  test("release is idempotent and concurrent calls share one sequence", async () => {
    const lockPath = await tempLockPath();
    const release = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    await Promise.all([release(), release()]);
    await release();
    expect(await pathExists(lockPath)).toBe(false);
  });

  test("never reclaims a live holder on age (pre-#4415 builds did after staleMs)", async () => {
    // Formerly "reclaims a holder past the stale ceiling even when its pid is
    // alive": age is no longer evidence of death (#4415).
    const lockPath = await tempLockPath();
    const holder = liveProcess();
    try {
      await writeRecord(lockPath, {
        ...(await ownIdentity()),
        pid: holder.pid,
        birth: probeProcessBirth(holder.pid),
        token: "old-but-live",
        acquiredAt: Date.now() - 24 * 60 * 60 * 1000,
      });
      await expectRefused(lockPath);
    } finally {
      holder.stop();
    }
  });

  test("a future acquiredAt is not corruption: a live holder stays refused", async () => {
    // Formerly reclaimed as corrupt; a clock stepped back would then have made
    // a live holder reclaimable.
    const lockPath = await tempLockPath();
    await writeRecord(lockPath, {
      pid: process.pid,
      token: "future-clock",
      acquiredAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    const old = new Date(Date.now() - 10_000);
    await fsPromises.utimes(lockPath, old, old);
    await expectRefused(lockPath); // legacy record, live pid
  });

  test("reclaims a corrupt lock file once its publication grace has passed", async () => {
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(lockPath, "not json");
    const old = new Date(Date.now() - 10_000);
    await fsPromises.utimes(lockPath, old, old);
    await expectAcquired(lockPath);
    expect(await fsPromises.readdir(path.dirname(lockPath))).toEqual([]);
  });

  test("retries fresh corrupt content instead of reclaiming it", async () => {
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(lockPath, "not json");
    await fsPromises.utimes(lockPath, new Date(), new Date(Date.now() + 60_000));
    await expectRefused(lockPath, 0);
    expect(await fsPromises.readFile(lockPath, "utf-8")).toBe("not json");
  });

  test("an unreadable lock file is refused, not treated as corrupt", async () => {
    if (process.getuid?.() === 0 || process.platform === "win32") return; // root/Windows ignore modes
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(lockPath, "not json");
    const old = new Date(Date.now() - 10_000);
    await fsPromises.utimes(lockPath, old, old);
    await fsPromises.chmod(lockPath, 0o000);
    const error = await expectRefused(lockPath, 0);
    expect(error.message).toContain("cannot be read");
    await fsPromises.chmod(lockPath, 0o600);
  });

  test("release never deletes a successor's lock", async () => {
    const lockPath = await tempLockPath();
    const release = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    await writeRecord(lockPath, { pid: process.pid, token: "successor" });
    await release();
    expect(await readToken(lockPath)).toBe("successor");
  });

  test("a live holder keeps renewing acquiredAt (for older builds) and stays unreclaimable", async () => {
    const lockPath = await tempLockPath();
    const release = await acquireCrossProcessLock({ ...baseOptions, lockPath, staleMs: 1_000 });
    const first = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as {
      acquiredAt: number;
    };
    await sleep(1_500);
    const later = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as {
      acquiredAt: number;
    };
    expect(later.acquiredAt).toBeGreaterThan(first.acquiredAt);
    await expectRefused(lockPath, 1_200);
    await release();
    await expectAcquired(lockPath);
  }, 10_000);

  test("release retries a transiently failing unlink instead of leaving a live-looking holder", async () => {
    const lockPath = await tempLockPath();
    const release = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    const realRm = fsPromises.rm;
    let failures = 0;
    const rmSpy = spyOn(fsPromises, "rm").mockImplementation((target, options) => {
      if (String(target) === lockPath && failures < 2) {
        failures += 1;
        return Promise.reject(new Error("EBUSY: resource busy"));
      }
      return realRm(target, options);
    });
    try {
      await release();
    } finally {
      rmSpy.mockRestore();
    }
    expect(failures).toBe(2);
    expect(await pathExists(lockPath)).toBe(false);
    await expectAcquired(lockPath);
  });

  test("release during active renewals leaves the lock immediately reacquirable", async () => {
    // stopRenewal joins the in-flight renewal tick: releasing mid-tick must
    // never let a resumed renewal rename a record back onto a released lock.
    const lockPath = await tempLockPath();
    for (const holdMs of [260, 310, 380, 430]) {
      const release = await acquireCrossProcessLock({ ...baseOptions, lockPath, staleMs: 1_000 });
      await sleep(holdMs);
      await release();
      expect(await pathExists(lockPath)).toBe(false);
      const release2 = await acquireCrossProcessLock({ ...baseOptions, lockPath, staleMs: 1_000 });
      await release2();
      expect(await pathExists(lockPath)).toBe(false);
    }
  }, 10_000);

  test("a lock leaked by this process (token no longer held) is reclaimable in-process", async () => {
    const lockPath = await tempLockPath();
    await writeRecord(lockPath, { ...(await ownIdentity()), pid: process.pid, token: "leaked" });
    await expectAcquired(lockPath);
  });

  test("contending in-process acquirers over a dead lock are mutually exclusive", async () => {
    const lockPath = await tempLockPath();
    await writeRecord(lockPath, { pid: deadPid(), token: "dead" });
    let inside = 0;
    let overlaps = 0;
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        const release = await acquireCrossProcessLock({
          lockPath,
          ...baseOptions,
          acquireTimeoutMs: 15_000,
        });
        inside += 1;
        if (inside > 1) overlaps += 1;
        await sleep(10);
        inside -= 1;
        await release();
      })
    );
    expect(overlaps).toBe(0);
  });

  test("concurrent in-process try-locks of one dead lock yield exactly one owner (repeated)", async () => {
    const identity = await ownIdentity();
    for (let iteration = 0; iteration < 50; iteration++) {
      const lockPath = await tempLockPath();
      await writeRecord(lockPath, { ...identity, pid: deadPid(), token: `dead-${iteration}` });
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          acquireCrossProcessLock({ lockPath, ...baseOptions, acquireTimeoutMs: 0 })
        )
      );
      const winners = results.filter((r) => r.status === "fulfilled");
      expect(winners.length).toBe(1);
      await (winners[0] as PromiseFulfilledResult<() => Promise<void>>).value();
      // No guard or temp debris survives a completed takeover.
      expect(await fsPromises.readdir(path.dirname(lockPath))).toEqual([]);
    }
  }, 60_000);

  test("legacy (v1) records: dead pid reclaimed, live pid refused", async () => {
    const lockPath = await tempLockPath();
    await writeRecord(lockPath, { pid: deadPid(), token: "legacy-dead" });
    await expectAcquired(lockPath);
    const holder = liveProcess();
    try {
      await writeRecord(lockPath, { pid: holder.pid, token: "legacy-live" });
      const error = await expectRefused(lockPath);
      expect(error.message).toContain("older Xum build");
    } finally {
      holder.stop();
    }
  });
});

describe("Linux identity judgment", () => {
  test.skipIf(linuxOnly)(
    "live pid with a mismatched birth is reclaimed; a matching birth is refused",
    async () => {
      const lockPath = await tempLockPath();
      const identity = await ownIdentity();
      const holder = liveProcess();
      try {
        await writeRecord(lockPath, {
          ...identity,
          pid: holder.pid,
          birth: "linux-ticks:1",
          token: "reused",
        });
        await expectAcquired(lockPath);
        await writeRecord(lockPath, {
          ...identity,
          pid: holder.pid,
          birth: probeProcessBirth(holder.pid),
          token: "same",
        });
        const error = await expectRefused(lockPath);
        expect(error.message).toContain(`pid ${holder.pid}`);
        expect(error.message).toContain("that process is running");
      } finally {
        holder.stop();
      }
    }
  );

  test.skipIf(linuxOnly)(
    "same pid with a different birth is a previous process: reclaimed",
    async () => {
      const lockPath = await tempLockPath();
      await writeRecord(lockPath, {
        ...(await ownIdentity()),
        pid: process.pid,
        birth: "linux-ticks:1",
        token: "prev",
      });
      await expectAcquired(lockPath);
    }
  );

  // Formerly refused: under the single-PID-domain deployment contract a
  // POSITIVELY different domain is retired, so its record is dead even when a
  // process with that pid number is running here (the pid means nothing).
  test.skipIf(linuxOnly)(
    "positively foreign PID domain (namespace, boot, machine-id) is retired: reclaimed",
    async () => {
      const lockPath = await tempLockPath();
      const identity = await ownIdentity();
      const unrelated = liveProcess();
      try {
        const foreign: Array<[string, Record<string, unknown>]> = [
          ["other-namespace-same-boot", { pidNs: "pid:[1]" }],
          ["other-boot-no-machine-id", { bootId: "earlier-boot", machineId: null }],
          ["other-boot-same-machine", { bootId: "earlier-boot" }],
          ["other-machine", { machineId: "0".repeat(32) }],
        ];
        for (const [token, fields] of foreign) {
          await writeRecord(lockPath, { ...identity, pid: unrelated.pid, token, ...fields });
          await expectAcquired(lockPath);
        }
        // Hostname is diagnostic only: a renamed host alone changes nothing.
        await writeRecord(lockPath, {
          ...identity,
          pid: deadPid(),
          hostname: "some-other-host",
          token: "renamed-host",
        });
        await expectAcquired(lockPath);
      } finally {
        unrelated.stop();
      }
    }
  );

  test.skipIf(linuxOnly)(
    "missing machine-id with the same boot and namespace and a dead pid is reclaimed",
    async () => {
      const lockPath = await tempLockPath();
      await writeRecord(lockPath, {
        ...(await ownIdentity()),
        pid: deadPid(),
        machineId: null,
        token: "no-machine-id",
      });
      await expectAcquired(lockPath);
    }
  );

  test.skipIf(linuxOnly)(
    "a v2 record missing boot id or namespace is unknown evidence: refused",
    async () => {
      const lockPath = await tempLockPath();
      const identity = await ownIdentity();
      for (const missing of [{ pidNs: null }, { bootId: null }]) {
        await writeRecord(lockPath, { ...identity, pid: deadPid(), token: "unknown", ...missing });
        expect((await expectRefused(lockPath)).message).toContain("unknown");
      }
    }
  );
});

describe("macOS/Windows rule (simulated identity; not natively qualified)", () => {
  const darwin = {
    birth: null,
    bootId: null,
    pidNs: null,
    machineId: null,
    platform: "darwin",
    hostname: "mac-a",
  };

  test("dead pid reclaimed (even after a hostname change); live pid refused; a Linux record is retired", async () => {
    setSelfIdentityForTesting(darwin);
    const holder = liveProcess();
    try {
      const lockPath = await tempLockPath();
      await writeRecord(lockPath, { v: 2, ...darwin, pid: deadPid(), token: "dead" });
      await expectAcquired(lockPath);
      await writeRecord(lockPath, { v: 2, ...darwin, pid: holder.pid, token: "live" });
      expect((await expectRefused(lockPath)).message).toContain("that pid is running");
      await writeRecord(lockPath, {
        v: 2,
        ...darwin,
        hostname: "mac-b", // macOS renames hosts with networks: diagnostic only
        pid: deadPid(),
        token: "renamed-host",
      });
      await expectAcquired(lockPath);
      await writeRecord(lockPath, {
        v: 2,
        ...darwin,
        platform: "linux",
        bootId: "b",
        pidNs: "n",
        pid: holder.pid, // a live local pid is irrelevant: a positively foreign domain
        token: "linux",
      });
      await expectAcquired(lockPath);
      // A macOS record naming a PID domain we cannot read is unknown evidence.
      await writeRecord(lockPath, { v: 2, ...darwin, bootId: "b", pid: deadPid(), token: "odd" });
      expect((await expectRefused(lockPath)).message).toContain("cannot verify");
    } finally {
      holder.stop();
      setSelfIdentityForTesting(undefined);
    }
  });
});

describe("supersede guards", () => {
  test("a guard held by a live reclaimer blocks takeover; a dead reclaimer's guard is superseded", async () => {
    const lockPath = await tempLockPath();
    const identity = await ownIdentity();
    await writeRecord(lockPath, { ...identity, pid: deadPid(), token: "dead-holder" });
    const guard = guardPath(lockPath, lockPath, "dead-holder");
    const reclaimer = liveProcess();
    try {
      // Live (stalled) reclaimer mid-protocol: never superseded.
      await writeRecord(guard, {
        ...identity,
        pid: reclaimer.pid,
        birth: probeProcessBirth(reclaimer.pid),
        token: "stalled",
      });
      if (process.platform === "linux" || process.platform === "darwin") {
        expect((await expectRefused(lockPath)).message).toContain("taking it over");
      }
    } finally {
      reclaimer.stop();
    }
    // Reclaimer killed mid-protocol (guard left behind, lock not yet replaced).
    await writeRecord(guard, { ...identity, pid: deadPid(), token: "killed-reclaimer" });
    await expectAcquired(lockPath);
    expect(await fsPromises.readdir(path.dirname(lockPath))).toEqual([]);
  });

  test("a reclaimer killed after its rename leaves a lock that is reclaimed as a new generation", async () => {
    const lockPath = await tempLockPath();
    const identity = await ownIdentity();
    const deadReclaimer = deadPid();
    await writeRecord(guardPath(lockPath, lockPath, "older-dead"), {
      ...identity,
      pid: deadReclaimer,
      token: "r",
    });
    await writeRecord(lockPath, { ...identity, pid: deadReclaimer, token: "r" });
    await expectAcquired(lockPath);
  });
});

describe.skipIf(unixOnly)(
  "child-process holders (Unix: SIGSTOP/FIFO have no Windows equivalent)",
  () => {
    const STALE_MS = 200;

    test("SIGSTOPped holder past 2x staleMs is refused; resumed it still owns and releases", async () => {
      const lockPath = await tempLockPath();
      const holder = startChild("hold", lockPath, STALE_MS);
      try {
        await holder.next("acquired");
        holder.proc.kill("SIGSTOP");
        await sleep(STALE_MS * 3);
        const contender = startChild("contend", lockPath, STALE_MS, "800");
        const result = await contender.next();
        expect(result.event).toBe("refused");
        expect(String(result.message)).toContain(`pid ${String(holder.proc.pid)}`);
        holder.proc.kill("SIGCONT");
        holder.send("release");
        expect((await holder.next("resumed")).stillOwner).toBe(true);
        expect((await holder.next("released")).lockExists).toBe(false);
      } finally {
        holder.proc.kill("SIGKILL");
      }
    }, 20_000);

    test("threadpool-starved holder stops renewing yet stays refused; unblocked it still owns", async () => {
      const lockPath = await tempLockPath();
      const fifoDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cross-process-lock-fifo-"));
      // One FIFO per possible fs worker (Bun sizes its pool by CPU count;
      // libuv uses 4) plus spares, so every worker parks in open().
      const fifoCount = Math.max(os.cpus().length, os.availableParallelism()) + 8;
      for (let i = 0; i < fifoCount; i++) {
        expect(spawnSync("mkfifo", [path.join(fifoDir, `f${i}`)]).status).toBe(0);
      }
      const holder = startChild("hold-starved", lockPath, STALE_MS, fifoDir);
      try {
        await holder.next("acquired");
        await sleep(STALE_MS); // let the opens park and any in-flight renewal settle
        const before = await fsPromises.readFile(lockPath, "utf-8");
        await sleep(STALE_MS * 3);
        // Renewal really stalled: the record did not change for > 2x staleMs.
        expect(await fsPromises.readFile(lockPath, "utf-8")).toBe(before);
        const contender = startChild("contend", lockPath, STALE_MS, "800");
        expect((await contender.next()).event).toBe("refused");
        // Unblock: a non-blocking write open completes a parked reader open.
        // It fails ENXIO while that FIFO's reader is still queued behind the
        // parked ones (a blocking open would deadlock on it), so sweep.
        const pendingFifos = new Set(Array.from({ length: fifoCount }, (_, i) => `f${i}`));
        while (pendingFifos.size > 0) {
          for (const name of [...pendingFifos]) {
            try {
              const flags = fsConstants.O_WRONLY | fsConstants.O_NONBLOCK;
              await (await fsPromises.open(path.join(fifoDir, name), flags)).close();
              pendingFifos.delete(name);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
            }
          }
          await sleep(20);
        }
        holder.send("release");
        expect((await holder.next("resumed")).stillOwner).toBe(true);
        expect((await holder.next("released")).lockExists).toBe(false);
      } finally {
        holder.proc.kill("SIGKILL");
      }
    }, 30_000);

    test("SIGKILLed holder is reclaimed promptly", async () => {
      const lockPath = await tempLockPath();
      const holder = startChild("hold", lockPath, STALE_MS);
      await holder.next("acquired");
      holder.proc.kill("SIGKILL");
      await holder.exited;
      const started = Date.now();
      const contender = startChild("contend", lockPath, STALE_MS, "5000");
      expect((await contender.next()).event).toBe("acquired");
      expect(Date.now() - started).toBeLessThan(4_000);
    }, 20_000);

    test("concurrent child reclaimers of one dead lock: exactly one owner (repeated)", async () => {
      for (let iteration = 0; iteration < 8; iteration++) {
        const lockPath = await tempLockPath();
        await writeRecord(lockPath, {
          ...(await ownIdentity()),
          pid: deadPid(),
          token: `dead-${iteration}`,
        });
        const children = Array.from({ length: 4 }, () => startChild("try", lockPath, STALE_MS));
        await sleep(400); // let every child start and wait on the barrier
        children.forEach((child) => child.send("go"));
        const results = await Promise.all(children.map((child) => child.next()));
        expect(results.filter((r) => r.event === "acquired").length).toBe(1);
        children.forEach((child) => child.send("release"));
        await Promise.all(children.map((child) => child.exited));
        expect(await pathExists(lockPath)).toBe(false);
      }
    }, 60_000);
  }
);
