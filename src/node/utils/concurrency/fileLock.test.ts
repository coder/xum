import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { DisposableTempDir } from "@/node/services/tempDir";
import { getSelfIdentity, probeProcessBirth } from "./processLiveness";
import { acquireProcessFileLock, getProcessBirth, type ReclaimSeamPhase } from "./fileLock";

const FILE_LOCK_MODULE = path.join(import.meta.dir, "fileLock.ts");

/** A token in the format acquire writes, with identity fields overridden. */
function v2Token(pid: number, nonce: string, fields: Record<string, unknown>): string {
  const identity = { ...getSelfIdentity(), ...fields };
  return `${pid}:${nonce}::${Buffer.from(JSON.stringify(identity)).toString("hex")}`;
}

async function expectTimeout(lockPath: string): Promise<void> {
  try {
    await (
      await acquireProcessFileLock({ lockPath, timeoutMs: 150, label: "test" })
    )[Symbol.asyncDispose]();
  } catch (error) {
    expect(String(error)).toContain("Timed out");
    return;
  }
  throw new Error(`expected ${lockPath} to stay held`);
}

/** A verified-live token for this process (the format acquire writes). */
function liveToken(nonce: string): string {
  const birth = getProcessBirth(process.pid);
  return birth === null
    ? `${process.pid}:${nonce}`
    : `${process.pid}:${nonce}:${Buffer.from(birth).toString("hex")}`;
}

/** A provably dead pid (a short-lived child that has already exited). */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["--version"]);
  expect(child.pid).toBeGreaterThan(0);
  return child.pid;
}

async function lockExists(lockPath: string): Promise<boolean> {
  return fs.access(lockPath).then(
    () => true,
    () => false
  );
}

describe("acquireProcessFileLock", () => {
  test("acquire/release round-trip installs and removes the lockfile", async () => {
    using tmp = new DisposableTempDir("file-lock-test");
    const lockPath = path.join(tmp.path, "x.lock");
    {
      await using _lock = await acquireProcessFileLock({ lockPath, timeoutMs: 500, label: "test" });
      expect(await lockExists(lockPath)).toBe(true);
    }
    expect(await lockExists(lockPath)).toBe(false);
  });

  test("reclaims a lock whose recorded owner pid is provably dead", async () => {
    using tmp = new DisposableTempDir("file-lock-test");
    const lockPath = path.join(tmp.path, "x.lock");
    const child = spawnSync(process.execPath, ["--version"]);
    expect(child.pid).toBeGreaterThan(0);
    await fs.writeFile(lockPath, `${child.pid}:deadbeef`, { encoding: "utf-8", flag: "wx" });

    await using _lock = await acquireProcessFileLock({ lockPath, timeoutMs: 2_000, label: "test" });
    expect(await lockExists(lockPath)).toBe(true);
  });

  test.skipIf(process.platform !== "linux")(
    "reclaims a live-pid legacy lock whose recorded process birth does not match (PID reuse)",
    async () => {
      using tmp = new DisposableTempDir("file-lock-test");
      const lockPath = path.join(tmp.path, "x.lock");
      // Our own pid is definitely alive, but the recorded birth identity is a
      // different (crashed) process's: the OS handed its PID to us. Without
      // birth verification this lock is judged live forever. Only Linux
      // starttimes are comparable evidence (#4415), so the bogus birth uses
      // that format (formerly an arbitrary string).
      const bogusBirth = Buffer.from("linux-ticks:1").toString("hex");
      await fs.writeFile(lockPath, `${process.pid}:cafe:${bogusBirth}`, {
        encoding: "utf-8",
        flag: "wx",
      });

      await using _lock = await acquireProcessFileLock({
        lockPath,
        timeoutMs: 2_000,
        label: "test",
      });
      expect(await lockExists(lockPath)).toBe(true);
    }
  );

  test("never lease-breaks an undetermined-birth live-pid lock, however old (#4415)", async () => {
    using tmp = new DisposableTempDir("file-lock-test");
    const lockPath = path.join(tmp.path, "x.lock");
    // Formerly reclaimed once the lease expired: a live pid whose birth
    // cannot be proven is indeterminate, and age is not evidence of death
    // (a stopped or starved holder resumes and keeps writing).
    await fs.writeFile(lockPath, `${process.pid}:cafe`, { encoding: "utf-8", flag: "wx" });
    const ancient = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(lockPath, ancient, ancient);
    await expectTimeout(lockPath);
  });

  test("a malformed token still ages out after the lease (no owner to judge)", async () => {
    using tmp = new DisposableTempDir("file-lock-test");
    const lockPath = path.join(tmp.path, "x.lock");
    await fs.writeFile(lockPath, "garbage", { encoding: "utf-8", flag: "wx" });
    await expectTimeout(lockPath);
    const ancient = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(lockPath, ancient, ancient);
    await using _lock = await acquireProcessFileLock({ lockPath, timeoutMs: 2_000, label: "test" });
  });

  test("writes an additive identity segment older readers ignore", async () => {
    using tmp = new DisposableTempDir("file-lock-test");
    const lockPath = path.join(tmp.path, "x.lock");
    await using _lock = await acquireProcessFileLock({ lockPath, timeoutMs: 500, label: "test" });
    const parts = (await fs.readFile(lockPath, "utf-8")).split(":");
    expect(Number(parts[0])).toBe(process.pid);
    const identity = JSON.parse(Buffer.from(parts[3], "hex").toString("utf-8")) as {
      platform: string;
    };
    expect(identity.platform).toBe(process.platform);
  });

  test("a lock leaked by this process (token no longer registered) is reclaimable", async () => {
    using tmp = new DisposableTempDir("file-lock-test");
    const lockPath = path.join(tmp.path, "x.lock");
    await fs.writeFile(lockPath, v2Token(process.pid, "leaked", {}), {
      encoding: "utf-8",
      flag: "wx",
    });
    await using _lock = await acquireProcessFileLock({ lockPath, timeoutMs: 2_000, label: "test" });
  });

  test("a live holder of this process (registered token) is refused", async () => {
    using tmp = new DisposableTempDir("file-lock-test");
    const lockPath = path.join(tmp.path, "x.lock");
    await using _held = await acquireProcessFileLock({ lockPath, timeoutMs: 500, label: "test" });
    await expectTimeout(lockPath);
  });

  test.skipIf(process.platform !== "linux")(
    "Linux identity: foreign domains are retired; unknown evidence and live same-domain pids are refused",
    async () => {
      using tmp = new DisposableTempDir("file-lock-test");
      const lockPath = path.join(tmp.path, "x.lock");
      const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
        stdio: "ignore",
      });
      const otherPid = other.pid!;
      try {
        // Positively different PID domain (single-PID-domain contract):
        // reclaimed even though a process with that pid number runs here.
        for (const fields of [
          { pidNs: "pid:[1]" },
          { bootId: "earlier-boot", machineId: null },
          { machineId: "0".repeat(32) },
          { platform: "darwin" },
        ]) {
          await fs.writeFile(lockPath, v2Token(otherPid, "foreign", fields), "utf-8");
          await (
            await acquireProcessFileLock({ lockPath, timeoutMs: 2_000, label: "test" })
          )[Symbol.asyncDispose]();
        }
        // Unknown domain evidence: refused even with a dead pid.
        await fs.writeFile(lockPath, v2Token(deadPid(), "unknown", { pidNs: null }), "utf-8");
        await expectTimeout(lockPath);
        // Same domain, live pid with its real birth: refused; a different
        // birth (pid reuse): reclaimed. Hostname alone is diagnostic.
        const birth = probeProcessBirth(otherPid);
        await fs.writeFile(lockPath, v2Token(otherPid, "live", { birth }), "utf-8");
        await expectTimeout(lockPath);
        await fs.writeFile(
          lockPath,
          v2Token(otherPid, "reused", { birth: "linux-ticks:1", hostname: "renamed" }),
          "utf-8"
        );
        await (
          await acquireProcessFileLock({ lockPath, timeoutMs: 2_000, label: "test" })
        )[Symbol.asyncDispose]();
      } finally {
        other.kill("SIGKILL");
      }
    }
  );

  test.skipIf(process.platform === "win32")(
    "a SIGSTOPped holder with an ancient lockfile is refused; a SIGKILLed one is reclaimed",
    async () => {
      using tmp = new DisposableTempDir("file-lock-test");
      const lockPath = path.join(tmp.path, "x.lock");
      const script =
        `const { acquireProcessFileLock } = await import(${JSON.stringify(FILE_LOCK_MODULE)});` +
        `await acquireProcessFileLock({ lockPath: ${JSON.stringify(lockPath)}, timeoutMs: 2000, label: "child", renewIntervalMs: 50 });` +
        `console.log("acquired"); setTimeout(() => {}, 120000);`;
      const holder = spawn(process.execPath, ["-e", script], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      try {
        await new Promise<void>((resolve, reject) => {
          holder.stdout.on("data", (chunk: Buffer) => {
            if (chunk.toString().includes("acquired")) resolve();
          });
          holder.on("exit", () => reject(new Error("holder exited before acquiring")));
        });
        holder.kill("SIGSTOP");
        // Older builds would lease-break this; this build must not.
        const ancient = new Date(Date.now() - 60 * 60 * 1000);
        await fs.utimes(lockPath, ancient, ancient);
        await expectTimeout(lockPath);
        holder.kill("SIGCONT");
        holder.kill("SIGKILL");
        await new Promise((resolve) => holder.once("exit", resolve));
        await using _lock = await acquireProcessFileLock({
          lockPath,
          timeoutMs: 2_000,
          label: "test",
        });
      } finally {
        holder.kill("SIGKILL");
      }
    },
    20_000
  );

  test("retains a fresh undetermined-birth live-pid lock (lease not expired)", async () => {
    using tmp = new DisposableTempDir("file-lock-test");
    const lockPath = path.join(tmp.path, "x.lock");
    await fs.writeFile(lockPath, `${process.pid}:cafe`, { encoding: "utf-8", flag: "wx" });
    try {
      await acquireProcessFileLock({ lockPath, timeoutMs: 150, label: "test" });
      expect.unreachable("a fresh live-pid lock must not be reclaimed");
    } catch (error) {
      expect(String(error)).toContain("Timed out");
    }
  });

  test("a reclaimer acting on a stale read can never displace a fresh owner (B+C double entry)", async () => {
    using tmp = new DisposableTempDir("file-lock-test");
    const lockPath = path.join(tmp.path, "x.lock");
    // Round-11 interleaving: reclaimer R1 judges token X stale; a concurrent
    // reclaimer R2 removes X and fresh owner B acquires; R1 (still acting on
    // its pre-removal read) displaces B's live lock, and third process C
    // claims the emptied path — B and C both inside the protected section.
    await fs.writeFile(lockPath, `${deadPid()}:deadbeef`, { encoding: "utf-8", flag: "wx" });
    const bToken = liveToken("bbbb");

    let seamFired = false;
    let cAcquired = false;
    const seam = async (phase: ReclaimSeamPhase): Promise<void> => {
      if (phase === "post-guard" && !seamFired) {
        seamFired = true;
        // R2's completed reclaim of X, then B's acquisition — all while R1
        // sits between its staleness judgment and its displacement.
        await fs.unlink(lockPath);
        await fs.writeFile(lockPath, bToken, { encoding: "utf-8", flag: "wx" });
      }
      if (phase === "pre-restore") {
        // C races the canonical path. Reaching this phase at all means B was
        // wrongfully displaced; C succeeds only if the path was left empty.
        try {
          await fs.writeFile(lockPath, liveToken("cccc"), { encoding: "utf-8", flag: "wx" });
          cAcquired = true;
        } catch {
          // canonical still occupied — C correctly excluded
        }
      }
    };

    try {
      await acquireProcessFileLock({
        lockPath,
        timeoutMs: 400,
        label: "test",
        testOnlyReclaimSeam: seam,
      });
      expect.unreachable("R1 must not acquire while fresh owner B holds the lock");
    } catch (error) {
      expect(String(error)).toContain("Timed out");
    }
    expect(seamFired).toBe(true);
    // Invariant: exactly one believed owner. B's canonical record survived
    // and C never entered the section.
    expect(await fs.readFile(lockPath, "utf-8")).toBe(bToken);
    expect(cAcquired).toBe(false);
  });

  test("a live reclaim guard defers other reclaimers (conservative skip)", async () => {
    using tmp = new DisposableTempDir("file-lock-test");
    const lockPath = path.join(tmp.path, "x.lock");
    // Reclaimable canonical lock, but another live process holds the guard:
    // reclamation must wait its turn rather than judge/displace concurrently.
    await fs.writeFile(lockPath, `${deadPid()}:deadbeef`, { encoding: "utf-8", flag: "wx" });
    await fs.writeFile(`${lockPath}.reclaim`, liveToken("9999"), { encoding: "utf-8", flag: "wx" });
    try {
      await acquireProcessFileLock({ lockPath, timeoutMs: 200, label: "test" });
      expect.unreachable("reclamation must not proceed while a live guard is held");
    } catch (error) {
      expect(String(error)).toContain("Timed out");
    }
    // Guard released → the stale lock is reclaimed normally.
    await fs.unlink(`${lockPath}.reclaim`);
    await using _lock = await acquireProcessFileLock({ lockPath, timeoutMs: 2_000, label: "test" });
  });

  test("a crash-remnant reclaim guard (dead pid) does not deadlock reclamation", async () => {
    using tmp = new DisposableTempDir("file-lock-test");
    const lockPath = path.join(tmp.path, "x.lock");
    const dead = deadPid();
    await fs.writeFile(lockPath, `${dead}:deadbeef`, { encoding: "utf-8", flag: "wx" });
    await fs.writeFile(`${lockPath}.reclaim`, `${dead}:feedface`, {
      encoding: "utf-8",
      flag: "wx",
    });
    await using _lock = await acquireProcessFileLock({ lockPath, timeoutMs: 2_000, label: "test" });
  });

  test("assertStillOwned passes for the live owner and throws after displacement", async () => {
    using tmp = new DisposableTempDir("file-lock-test");
    const lockPath = path.join(tmp.path, "x.lock");
    await using lock = await acquireProcessFileLock({ lockPath, timeoutMs: 500, label: "test" });
    await lock.assertStillOwned(); // owner in place → passes

    const original = await fs.readFile(lockPath, "utf-8");
    await fs.writeFile(lockPath, liveToken("hijacked"), "utf-8");
    try {
      await lock.assertStillOwned();
      expect.unreachable("a displaced holder must fail its ownership assertion");
    } catch (error) {
      expect(String(error)).toContain("no longer owned");
    }
    // Restore so the handle's release finds its own token (clean disposal).
    await fs.writeFile(lockPath, original, "utf-8");
  });

  test("a live holder renews its lease while held, and stops at release (r59)", async () => {
    // On birth-less platforms the lease is the ONLY reclaim guard: without
    // renewal, a live holder stalled past the lease (target mutation wedged
    // in filesystem I/O) was judged stale and displaced — double entry.
    using tmp = new DisposableTempDir("file-lock-test");
    const lockPath = path.join(tmp.path, "x.lock");
    const lock = await acquireProcessFileLock({
      lockPath,
      timeoutMs: 500,
      label: "test",
      renewIntervalMs: 20,
    });
    // Age the lockfile far past any lease; a renewal tick must refresh it.
    const past = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(lockPath, past, past);
    const refreshDeadline = Date.now() + 5_000;
    for (;;) {
      const { mtimeMs } = await fs.stat(lockPath);
      if (Date.now() - mtimeMs < 60_000) break; // renewed to "now"
      if (Date.now() > refreshDeadline) {
        throw new Error("lease was never renewed while the lock was held");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await lock[Symbol.asyncDispose]();
    expect(await lockExists(lockPath)).toBe(false);
  });

  test("a displaced holder never refreshes the successor's lease (r59)", async () => {
    using tmp = new DisposableTempDir("file-lock-test");
    const lockPath = path.join(tmp.path, "x.lock");
    const lock = await acquireProcessFileLock({
      lockPath,
      timeoutMs: 500,
      label: "test",
      renewIntervalMs: 20,
    });
    // Simulate a (wrongful) reclaim + new owner, then age the successor's
    // lockfile: the displaced holder's renewal re-verifies the token and
    // must leave the foreign mtime alone.
    await fs.writeFile(lockPath, liveToken("successor"), "utf-8");
    const past = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(lockPath, past, past);
    await new Promise((resolve) => setTimeout(resolve, 120)); // several ticks
    const { mtimeMs } = await fs.stat(lockPath);
    expect(Math.abs(mtimeMs - past.getTime())).toBeLessThan(1_000);
    // Disposal leaves the successor's lock in place (ownership-verified).
    await lock[Symbol.asyncDispose]();
    expect(await lockExists(lockPath)).toBe(true);
  });

  test("never lease-breaks a verified-live holder, no matter how old the lock is", async () => {
    using tmp = new DisposableTempDir("file-lock-test");
    const lockPath = path.join(tmp.path, "x.lock");
    const realBirth = getProcessBirth(process.pid);
    if (realBirth === null) {
      // Platform without a birth probe: the lease governs instead; the
      // "retains a fresh lock" test covers the conservative path.
      return;
    }
    // Same pid AND same birth = provably the original holder, still alive: a
    // wedged-but-live holder must never be displaced (double-entry risk),
    // even past the lease age.
    await fs.writeFile(lockPath, `${process.pid}:cafe:${Buffer.from(realBirth).toString("hex")}`, {
      encoding: "utf-8",
      flag: "wx",
    });
    const ancient = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(lockPath, ancient, ancient);
    try {
      await acquireProcessFileLock({ lockPath, timeoutMs: 150, label: "test" });
      expect.unreachable("a verified-live holder must never be reclaimed");
    } catch (error) {
      expect(String(error)).toContain("Timed out");
    }
  });
});
