/**
 * Workspace-removal durability (r61).
 *
 * Process-local cancellation (abort controllers + bounded drains) cannot
 * reach two writers: follow-on consolidation runs registered after the
 * cancel loop, and dream/harvest runs executing in OTHER backend processes
 * (multi-instance mode). Two cooperating pieces close the remaining "late
 * memory write recreates a removed session directory" races:
 *
 * - A durable removal TOMBSTONE under `<xumHome>/locks/`, published while
 *   the memory target locks are held, immediately before the session
 *   directory is deleted. MemoryService re-checks it inside those same
 *   locks at every mutation commit point, so any backend observes removal
 *   at commit time even when the remover could not abort its in-flight run.
 * - Session-directory deletion SERIALIZED with the memory target mutation
 *   locks (the workspace store root plus the coarse global/project memory
 *   root, whose mutations journal into this session directory): a write
 *   already inside its critical section either commits before the deletion
 *   (and is deleted with the directory) or acquires the lock afterwards and
 *   refuses on the tombstone. Lock acquisition stays FAIL-CLOSED (the
 *   target-lock 2s timeout): refusing to delete under a wedged writer beats
 *   deleting the directory out from under a write that would recreate it —
 *   the caller keeps the session directory as a recoverable orphan instead.
 *
 * Tombstones are retained after successful removal: workspace IDs are
 * unique and never reused, the files are tiny, and retention is what lets a
 * foreign backend's still-running consolidation refuse arbitrarily late.
 */

import crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";

import assert from "@/common/utils/assert";
import {
  memoryMutationLockKey,
  withTargetMutationLocks,
} from "@/node/services/refinement/targetMutationLocks";

/** Durable tombstone path for one removed workspace (hashed: IDs are user-influenced). */
export function workspaceRemovalTombstonePath(rootDir: string, workspaceId: string): string {
  assert(workspaceId.length > 0, "workspaceRemovalTombstonePath requires a workspace id");
  const digest = crypto.createHash("sha256").update(workspaceId).digest("hex").slice(0, 32);
  return path.join(rootDir, "locks", `workspace-removed-${digest}.json`);
}

/** True when a durable removal tombstone exists for this workspace. */
export async function isWorkspaceRemovalTombstoned(
  rootDir: string,
  workspaceId: string
): Promise<boolean> {
  try {
    await fsPromises.access(workspaceRemovalTombstonePath(rootDir, workspaceId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a workspace's session directory serialized with the memory target
 * mutation locks, publishing the durable removal tombstone inside the same
 * critical section (see module doc). Throws when a lock cannot be acquired
 * (fail-closed) or the tombstone cannot be published; the session directory
 * is only ever deleted after the tombstone is durable.
 */
export async function removeSessionDirUnderMemoryLocks(args: {
  rootDir: string;
  sessionDir: string;
  workspaceId: string;
}): Promise<void> {
  assert(args.sessionDir.length > 0, "removeSessionDirUnderMemoryLocks requires a session dir");
  // Same key derivations as MemoryService.storeLockKey: the workspace store
  // root lives inside the session directory; global/project mutations hold
  // the coarse `<rootDir>/memory` key while journaling into this session dir.
  const workspaceMemoryKey = memoryMutationLockKey(
    args.rootDir,
    path.join(args.sessionDir, "memory")
  );
  const sharedMemoryKey = memoryMutationLockKey(args.rootDir, path.join(args.rootDir, "memory"));
  await withTargetMutationLocks(args.rootDir, [workspaceMemoryKey, sharedMemoryKey], async () => {
    const tombstonePath = workspaceRemovalTombstonePath(args.rootDir, args.workspaceId);
    await fsPromises.mkdir(path.dirname(tombstonePath), { recursive: true });
    // Tombstone BEFORE rm: once the locks release, any waiting writer
    // re-checks it pre-commit (inside its own lock) and refuses, so the
    // deleted directory cannot be recreated by a late mutation or journal
    // append.
    await writeFileAtomic(
      tombstonePath,
      JSON.stringify({ workspaceId: args.workspaceId, removedAt: Date.now() })
    );
    await fsPromises.rm(args.sessionDir, { recursive: true, force: true });
  });
}
