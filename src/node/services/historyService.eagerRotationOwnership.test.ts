/**
 * #5344: the eager rotation after a boundary write must re-check the history write lock before
 * its destructive steps, on every write path that can land a boundary. A backend whose lock was
 * reclaimed meanwhile (a dead-judged holder, or an older build that lease-breaks) must not
 * rewrite chat.jsonl from a read taken before the new owner wrote.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import * as fileLock from "@/node/utils/concurrency/fileLock";
import { markLockOwnerDead } from "@/node/utils/concurrency/fileLockTestHelpers";
import { createTestHistoryService } from "./testHistoryService";
import { historyWriteLockPath } from "./workspaceRemoval";

const workspaceId = "eager-rotation-ownership";

const boundary = (id: string, historySequence?: number): MuxMessage =>
  createMuxMessage(id, "assistant", "Compacted summary", {
    ...(historySequence != null ? { historySequence } : {}),
    compacted: "user",
    compactionBoundary: true,
    compactionEpoch: 1,
    muxMetadata: { type: "compaction-summary" },
  });

describe("eager rotation after a boundary write (#5344)", () => {
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  beforeEach(async () => {
    h = await createTestHistoryService();
  });
  afterEach(async () => {
    mock.restore();
    await h.cleanup();
  });

  it.each(["append", "appendMany", "appendIfTailMatches", "update", "persistBoundary"] as const)(
    "%s: a lock reclaimed before rotation keeps the new owner's row",
    async (path_) => {
      const service = h.historyService;
      const chatPath = path.join(h.config.sessionsDir, workspaceId, "chat.jsonl");
      expect(
        (await service.appendToHistory(workspaceId, createMuxMessage("A", "user", "a"))).success
      ).toBe(true);
      const placeholder = createMuxMessage("S", "assistant", "");
      expect((await service.appendToHistory(workspaceId, placeholder)).success).toBe(true);
      const placeholderSequence = placeholder.metadata?.historySequence;
      expect(typeof placeholderSequence).toBe("number");

      // Right after the rotation reads chat.jsonl (the boundary is in it), another backend takes
      // the lock and appends its own row. Rotating from the earlier read would drop that row.
      let successor: Awaited<ReturnType<typeof fileLock.acquireProcessFileLock>> | undefined;
      const foreignRow =
        JSON.stringify(createMuxMessage("F", "user", "foreign", { historySequence: 99 })) + "\n";
      const readFile = fsPromises.readFile;
      spyOn(fsPromises, "readFile").mockImplementation((async (
        ...args: Parameters<typeof readFile>
      ) => {
        const result = await readFile(...args);
        if (successor == null && args[1] == null && args[0] === chatPath) {
          const text = Buffer.isBuffer(result) ? result.toString("utf8") : String(result);
          if (text.includes('"compactionBoundary":true')) {
            const lockPath = historyWriteLockPath(h.config.rootDir, workspaceId);
            await markLockOwnerDead(lockPath);
            successor = await fileLock.acquireProcessFileLock({
              lockPath,
              timeoutMs: 1000,
              label: "foreign writer",
            });
            await fsPromises.appendFile(chatPath, foreignRow);
          }
        }
        return result;
      }) as typeof readFile);

      try {
        const result =
          path_ === "append"
            ? await service.appendToHistory(workspaceId, boundary("B"))
            : path_ === "appendMany"
              ? await service.appendManyToHistory(workspaceId, [boundary("B")])
              : path_ === "appendIfTailMatches"
                ? await service.appendToHistoryIfTailMatches(workspaceId, boundary("B"), "S")
                : path_ === "update"
                  ? await service.updateHistory(workspaceId, boundary("S", placeholderSequence))
                  : await service.persistBoundaryWithTailCopies(
                      workspaceId,
                      boundary("B"),
                      [],
                      false
                    );
        // The boundary row itself is durable; only the best-effort rotation stops.
        expect(result.success).toBe(true);
        if (path_ === "appendIfTailMatches")
          expect(result).toEqual({ success: true, data: "appended" });
        expect(successor).toBeDefined();
        const chat = await readFile(chatPath, "utf8");
        expect(chat).toContain('"id":"F"');
        expect(chat).toContain('"id":"A"');
      } finally {
        await successor?.[Symbol.asyncDispose]();
      }
    }
  );
});
