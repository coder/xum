import { describe, expect, test } from "bun:test";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { DisposableTempDir } from "@/node/services/tempDir";
import {
  targetMutationLockFilePath,
  withTargetMutationLock,
} from "@/node/services/refinement/targetMutationLocks";
import { getProcessBirth } from "@/node/utils/concurrency/fileLock";
import {
  isWorkspaceRemovalTombstoned,
  removeSessionDirUnderMemoryLocks,
  workspaceRemovalTombstonePath,
} from "./workspaceRemoval";

describe("workspaceRemoval", () => {
  test("deletion waits for a live memory writer, then tombstones and deletes (r61)", async () => {
    using tmp = new DisposableTempDir("workspace-removal-test");
    const rootDir = path.join(tmp.path, "xum-home");
    const workspaceId = "ws-removal";
    const sessionDir = path.join(rootDir, "sessions", workspaceId);
    await fsPromises.mkdir(path.join(sessionDir, "memory"), { recursive: true });
    await fsPromises.writeFile(path.join(sessionDir, "memory", "note.md"), "contents\n");
    expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(false);

    // A memory writer holds the workspace store's target lock mid-commit.
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => (releaseWriter = resolve));
    // Entry signal (r62): removal must start only once the writer provably
    // holds the lock, so this test can never silently degrade into timing
    // out the lock instead of exercising writer-vs-removal ordering.
    let writerEntered!: () => void;
    const entered = new Promise<void>((resolve) => (writerEntered = resolve));
    let writerDone = false;
    const writer = withTargetMutationLock(rootDir, path.join(sessionDir, "memory"), async () => {
      writerEntered();
      await writerGate;
      writerDone = true;
    });
    await entered;

    // Removal must serialize behind the writer, not delete under it.
    const removal = removeSessionDirUnderMemoryLocks({ rootDir, sessionDir, workspaceId });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      await fsPromises.access(sessionDir).then(
        () => true,
        () => false
      )
    ).toBe(true);

    releaseWriter();
    await writer;
    await removal;
    expect(writerDone).toBe(true);
    expect(
      await fsPromises.access(sessionDir).then(
        () => true,
        () => false
      )
    ).toBe(false);
    // Tombstone published and durable — commit points refuse from now on.
    expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(true);
    const raw = await fsPromises.readFile(
      workspaceRemovalTombstonePath(rootDir, workspaceId),
      "utf-8"
    );
    expect((JSON.parse(raw) as { workspaceId: string }).workspaceId).toBe(workspaceId);
  });

  test("publishes the tombstone even when lock acquisition fails (r62)", async () => {
    // Fail-closed orphan path: the caller deregisters the workspace even
    // when a wedged writer blocks the deletion, so the terminal marker must
    // still become durable or a foreign backend would keep mutating the
    // retained orphan forever.
    using tmp = new DisposableTempDir("workspace-removal-test");
    const rootDir = path.join(tmp.path, "xum-home");
    const workspaceId = "ws-wedged";
    const sessionDir = path.join(rootDir, "sessions", workspaceId);
    await fsPromises.mkdir(path.join(sessionDir, "memory"), { recursive: true });

    // A foreign process "holds" the workspace target's cross-process file
    // lock: a verified-live token for this pid is never treated as stale, so
    // acquisition times out (~2s) instead of reclaiming.
    const key = path.join(sessionDir, "memory");
    const lockPath = targetMutationLockFilePath(rootDir, key);
    await fsPromises.mkdir(path.dirname(lockPath), { recursive: true });
    const birth = getProcessBirth(process.pid);
    const token =
      birth === null
        ? `${process.pid}:feed`
        : `${process.pid}:feed:${Buffer.from(birth).toString("hex")}`;
    await fsPromises.writeFile(lockPath, token, { flag: "wx" });

    try {
      await removeSessionDirUnderMemoryLocks({ rootDir, sessionDir, workspaceId });
      expect.unreachable("removal must fail closed while the target lock is held");
    } catch (error) {
      expect(String(error)).toContain("Another process is mutating");
    }
    // Directory retained (never deleted under a live writer), tombstone durable.
    expect(
      await fsPromises.access(sessionDir).then(
        () => true,
        () => false
      )
    ).toBe(true);
    expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(true);
  }, 15_000);
});
