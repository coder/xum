import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";

/**
 * Test helper: simulate losing a held fileLock by making its recorded owner a
 * provably dead pid, so a successor may legitimately reclaim it while the
 * original holder still believes it owns the lock. Tests formerly truncated
 * the token to its birth-less form and aged it past the lease; since #4415 a
 * live holder is never lease-broken, so a dead owner (e.g. a lock lost to an
 * older build or a crash-recovered process) is the in-process model.
 */
export async function markLockOwnerDead(lockPath: string): Promise<void> {
  const deadPid = spawnSync(process.execPath, ["--version"]).pid;
  await fs.writeFile(lockPath, `${deadPid}:reclaimed`);
}
