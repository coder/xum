/**
 * Another backend holds this workspace's history write lock (phase 4). With the
 * foreign-holder layer the refusal comes at once, with the text that the Node
 * lock gives after HISTORY_WRITE_LOCK_TIMEOUT_MS today.
 */
import { expect, test } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import { fileLockTimeoutMessage } from "@/node/utils/concurrency/fileLock";
import {
  foreignPid,
  liveBlocker,
  makeForeignHolders,
  withForeignHolders,
} from "./sessionLocks/foreignHolders.testHarness";
import { SessionLocksNode } from "./sessionLocks/nodeSessionLocks";
import { createTestHistoryService } from "./testHistoryService";
import { historyWriteLockPath } from "./workspaceRemoval";

const WORKSPACE_ID = "ws-foreign-writer";
/** HISTORY_WRITE_LOCK_TIMEOUT_MS in historyService.ts: the timeout the refusal names. */
const HISTORY_WRITE_LOCK_TIMEOUT_MS = 10_000;

test("a live foreign writer refuses at once with today's text, a dead one is reclaimed", async () => {
  const holders = makeForeignHolders();
  const { historyService, config, cleanup } = await createTestHistoryService({
    locks: withForeignHolders(SessionLocksNode, holders),
  });
  try {
    const lockPath = historyWriteLockPath(config.rootDir, WORKSPACE_ID);
    holders.hold(lockPath, "live", { pid: foreignPid() });
    const refused = await historyService.appendToHistory(
      WORKSPACE_ID,
      createMuxMessage("u1", "user", "hello")
    );
    expect(refused.success ? "" : refused.error).toContain(
      fileLockTimeoutMessage(
        "history write lock",
        lockPath,
        HISTORY_WRITE_LOCK_TIMEOUT_MS,
        liveBlocker(foreignPid())
      )
    );
    expect(await historyService.getLastMessages(WORKSPACE_ID, 10)).toEqual({
      success: true,
      data: [],
    });

    // The holder's process died: the next write reclaims the lock and goes on.
    holders.release(lockPath);
    holders.hold(lockPath, "dead");
    const appended = await historyService.appendToHistory(
      WORKSPACE_ID,
      createMuxMessage("u2", "user", "again")
    );
    expect(appended.success).toBe(true);
    expect(holders.reclaimed).toEqual([lockPath]);
  } finally {
    await cleanup();
  }
});
