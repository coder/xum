/**
 * Deterministic repros of counterexamples found by the TLA+ model in
 * formal/filelock/ (FileLock.tla; run formal/filelock/check.sh). Each test
 * asserts the protocol's documented invariant; both were `test.failing`
 * against the pre-fix code and now pass.
 *
 * Run: bun test ./src/node/utils/concurrency/fileLock.formalRepro.test.ts
 *
 * Every choreography gate below is bounded (it gives up and continues after
 * GATE_MS): the fix changed the syscall sequence the gates were written
 * for, so the fixed protocol runs through them instead of hanging.
 */
import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { DisposableTempDir } from "@/node/services/tempDir";
import { acquireProcessFileLock, type ProcessFileLock, type ReclaimSeamPhase } from "./fileLock";

const FILE_LOCK_MODULE = path.join(import.meta.dir, "fileLock.ts");
const GATE_MS = 2_000;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Wait for `signal`, but never longer than GATE_MS (see module doc). */
async function gate(signal: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    signal,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, GATE_MS);
    }),
  ]);
  clearTimeout(timer);
}

/** A provably dead pid (a short-lived child that has already exited). */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["--version"]);
  expect(child.pid).toBeGreaterThan(0);
  return child.pid;
}

// Model: MC_stale_guard, invariant MutualExclusion (and CommitExclusion,
// NoReclaimFromLiveHolder). Pre-fix root cause: withReclaimGuard's
// unconditional unlink of a judged-stale guard could remove a guard that a
// live reclaimer linked after the judgment, so two reclaimers ran the guarded
// section at once; one displaced a fresh owner and a third acquirer claimed
// the emptied path before the restore. Fixed: a dead guard is reclaimed
// under its own guard by re-read + rename, never plain-unlinked.
test("a dead reclaim guard never lets two holders own the lock at once (stale-guard double-remove)", async () => {
  using tmp = new DisposableTempDir("file-lock-formal");
  const lockPath = path.join(tmp.path, "x.lock");
  const guardPath = `${lockPath}.reclaim`;
  const dead = deadPid();
  // Crash remnants: a dead owner's lock and a dead reclaimer's guard.
  await fs.writeFile(lockPath, `${dead}:deadlock`, { encoding: "utf-8", flag: "wx" });
  await fs.writeFile(guardPath, `${dead}:deadguard`, { encoding: "utf-8", flag: "wx" });

  const secondStaleUnlink = deferred(); // Q reached the (pre-fix) stale-guard unlink too
  const pInGuard = deferred(); // P re-linked the guard (post-guard seam)
  const qRenameReady = deferred(); // Q passed its re-read, is at the rename
  const pAcquired = deferred(); // P returned from acquireProcessFileLock

  const realUnlink = fs.unlink;
  const realRename = fs.rename;
  let guardUnlinks = 0;
  let renames = 0;
  const unlinkSpy = spyOn(fs, "unlink").mockImplementation(async (target) => {
    if (String(target) === guardPath) {
      guardUnlinks++;
      if (guardUnlinks === 1) {
        // P (first stale-guard unlinker) waits until Q has judged the same
        // dead guard and is about to unlink it as well.
        await gate(secondStaleUnlink.promise);
      } else if (guardUnlinks === 2) {
        // Q's unlink runs only after P linked a FRESH guard: it removes P's.
        secondStaleUnlink.resolve();
        await gate(pInGuard.promise);
      }
    }
    return realUnlink(target);
  });
  const renameSpy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    renames++;
    if (renames === 1) {
      // Q, inside its own guard, re-read the dead token and is about to
      // rename. Let P (also inside "the" guard) finish first.
      qRenameReady.resolve();
      await gate(pAcquired.promise);
    }
    return realRename(from, to);
  });

  let postGuardSeams = 0;
  let pAssertOk = false;
  let cHandle: ProcessFileLock | undefined;
  let cAssertOk = false;
  const seam = async (phase: ReclaimSeamPhase): Promise<void> => {
    if (phase === "post-guard") {
      postGuardSeams++;
      if (postGuardSeams === 1) {
        pInGuard.resolve();
        await gate(qRenameReady.promise);
      }
    }
    if (phase === "pre-restore") {
      // Q displaced P's live lock; a third acquirer C claims the empty path.
      cHandle = await acquireProcessFileLock({ lockPath, timeoutMs: 500, label: "C" });
      cAssertOk = await cHandle.assertStillOwned().then(
        () => true,
        () => false
      );
    }
  };

  const options = { lockPath, timeoutMs: 1_500, label: "test", testOnlyReclaimSeam: seam };
  let pHandle: ProcessFileLock | undefined;
  const settle = (attempt: Promise<ProcessFileLock>) =>
    attempt.then(
      async (handle) => {
        if (pHandle === undefined) {
          pHandle = handle;
          // P's commit-point check passes before it is displaced.
          pAssertOk = await handle.assertStillOwned().then(
            () => true,
            () => false
          );
          pAcquired.resolve();
        }
        return handle;
      },
      () => undefined
    );
  try {
    const results = await Promise.all([
      settle(acquireProcessFileLock(options)),
      settle(acquireProcessFileLock(options)),
    ]);
    const holders = [...results, cHandle].filter((h) => h !== undefined);
    const bothPassedCommitPoint = pAssertOk && cAssertOk;
    try {
      // Invariant (fileLock.ts module doc): at most one process believes it owns
      // the lock, and at most one passes assertStillOwned for its section.
      expect(holders.length).toBeLessThanOrEqual(1);
      expect(bothPassedCommitPoint).toBe(false);
    } finally {
      for (const holder of new Set(holders)) await holder[Symbol.asyncDispose]();
    }
  } finally {
    unlinkSpy.mockRestore();
    renameSpy.mockRestore();
  }
  // Whatever the interleaving did, no remnant is left that wedges the lock.
  await using _after = await acquireProcessFileLock({ lockPath, timeoutMs: 2_000, label: "D" });
}, 15_000);

// Model: MC_release_fault, invariant NoOrphanLock. Pre-fix, releaseFileLock
// made one unlink attempt and only logged a failure; the dispose path then
// retired the token. The record stayed on disk naming a live pid with a
// matching birth, so every other process refused it until this process
// exited. Fixed: release retries the unlink (bounded), like crossProcessLock.
test("a transiently failing release unlink leaves no lock that siblings refuse", async () => {
  using tmp = new DisposableTempDir("file-lock-formal");
  const lockPath = path.join(tmp.path, "x.lock");
  const handle = await acquireProcessFileLock({ lockPath, timeoutMs: 500, label: "test" });
  const realUnlink = fs.unlink;
  let failed = false;
  const unlinkSpy = spyOn(fs, "unlink").mockImplementation(async (target) => {
    if (String(target) === lockPath && !failed) {
      failed = true; // One transient failure, as antivirus/indexers cause on Windows.
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    }
    return realUnlink(target);
  });
  try {
    await handle[Symbol.asyncDispose](); // The failed unlink is retried.
  } finally {
    unlinkSpy.mockRestore();
  }
  // A sibling process (the other backend on this root) tries to acquire.
  const script =
    `const { acquireProcessFileLock } = await import(${JSON.stringify(FILE_LOCK_MODULE)});` +
    `try { await acquireProcessFileLock({ lockPath: ${JSON.stringify(lockPath)}, timeoutMs: 500, label: "sibling" });` +
    ` console.log("acquired"); } catch (error) { console.log(String(error)); }`;
  const sibling = spawnSync(process.execPath, ["-e", script], { encoding: "utf-8" });
  // Invariant: a released lock never blocks another process.
  expect(sibling.stdout.trim()).toBe("acquired");
}, 15_000);
