import { describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";
import path from "path";
import * as historyScanner from "./historyScanner";
import { createWorkspaceServiceHarness } from "./workspaceService.testHarness";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { extractEditedFilePaths } from "@/common/utils/messages/extractEditedFiles";

// #5315: the Context tab's tracked files come from the unlocked snapshot reader (#5329).
describe("getPostCompactionState history read", () => {
  const ws = "post-compaction-read";

  function edit(id: string, filePath: string): MuxMessage {
    const message = createMuxMessage(id, "assistant", "");
    message.parts = [
      {
        type: "dynamic-tool",
        toolCallId: id,
        toolName: "file_edit_replace_string",
        state: "output-available",
        input: { path: filePath },
        output: { success: true, diff: "changed" },
      },
    ];
    return message;
  }
  const boundary = (id: string) =>
    createMuxMessage(id, "assistant", "Summary", {
      compactionBoundary: true,
      compacted: "user",
      compactionEpoch: 1,
    });

  async function setup() {
    const harness = await createWorkspaceServiceHarness();
    await harness.config.addWorkspace("/tmp/post-compaction-read-project", {
      id: ws,
      name: ws,
      projectName: "post-compaction-read-project",
      projectPath: "/tmp/post-compaction-read-project",
      runtimeConfig: { type: "local" },
    });
    const sessionDir = path.join(harness.config.sessionsDir, ws);
    const paths = async () => (await harness.service.getPostCompactionState(ws)).trackedFilePaths;
    /** Today's locked read, the reference the Context tab used to show. */
    const lockedPaths = async () => {
      const result = await harness.historyService.getHistoryFromLatestBoundary(ws);
      if (!result.success) throw new Error(result.error);
      return extractEditedFilePaths(result.data);
    };
    const append = async (message: MuxMessage) =>
      expect((await harness.historyService.appendToHistory(ws, message)).success).toBe(true);
    return { ...harness, sessionDir, paths, lockedPaths, append };
  }

  test.each(["normal", "legacy unrotated", "crash-replayed prefix"] as const)(
    "lists the same files as the locked read (%s)",
    async (layout) => {
      const { sessionDir, paths, lockedPaths, append, cleanup } = await setup();
      try {
        await append(edit("old", "/tmp/old.ts"));
        await append(boundary("boundary"));
        await append(edit("new-a", "/tmp/a.ts"));
        await append(edit("new-b", "/tmp/b.ts"));
        const chat = path.join(sessionDir, "chat.jsonl");
        const archive = path.join(sessionDir, "chat-archive.jsonl");
        const archived = await fsPromises.readFile(archive, "utf8");
        if (layout !== "normal") {
          // The sealed prefix is back at the head of chat.jsonl: an unrotated legacy file, or a
          // crash between the archive append and the chat.jsonl rewrite.
          await fsPromises.writeFile(chat, archived + (await fsPromises.readFile(chat, "utf8")));
          if (layout === "legacy unrotated") await fsPromises.rm(archive);
        }
        const unlocked = await paths(); // Before the reference: the locked read may rotate.
        expect([...unlocked].sort()).toEqual(["/tmp/a.ts", "/tmp/b.ts"]); // Never the sealed one.
        expect(unlocked).toEqual(await lockedPaths());
      } finally {
        await cleanup();
      }
    }
  );

  test("reuses the list while the history is unchanged and rereads after an append", async () => {
    const { historyService, paths, lockedPaths, append, cleanup } = await setup();
    const read = spyOn(historyService, "getHistoryForTokenStats");
    try {
      await append(edit("a", "/tmp/a.ts"));
      expect(await paths()).toEqual(["/tmp/a.ts"]);
      expect(await paths()).toEqual(["/tmp/a.ts"]);
      expect(read).toHaveBeenCalledTimes(1);
      await append(edit("b", "/tmp/b.ts"));
      expect(await paths()).toEqual(await lockedPaths());
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore();
      await cleanup();
    }
  });

  test("a since read and an append complete while the read is parked mid-scan", async () => {
    const { historyService, paths, lockedPaths, append, cleanup } = await setup();
    const realScan = historyScanner.readProviderHistoryFromSnapshot;
    const parked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const scan = spyOn(historyScanner, "readProviderHistoryFromSnapshot");
    scan.mockImplementationOnce(async (snapshot) => {
      parked.resolve();
      await release.promise;
      return realScan(snapshot);
    });
    try {
      await append(edit("a", "/tmp/a.ts"));
      const reading = paths();
      await parked.promise;
      // Both would deadlock (and time out) if the parked read held a history lock.
      const since = await historyService.getHistorySinceFromLatestBoundary(
        ws,
        { maxRows: 100, maxBytes: 1_000_000 },
        { floor: 0, anchor: 0 }
      );
      expect(since.success).toBe(true);
      await append(edit("b", "/tmp/b.ts"));
      release.resolve();
      // The stale first scan is retried once, so the result is the post-append state.
      expect(await reading).toEqual(await lockedPaths());
      expect(scan).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      scan.mockRestore();
      await cleanup();
    }
  });

  test("rejects instead of listing no files when the snapshot stays stale", async () => {
    const { paths, append, cleanup } = await setup();
    const realScan = historyScanner.readProviderHistoryFromSnapshot;
    const scan = spyOn(historyScanner, "readProviderHistoryFromSnapshot");
    let n = 0;
    scan.mockImplementation(async (snapshot) => {
      const rows = await realScan(snapshot);
      await append(edit(`race-${n++}`, "/tmp/race.ts"));
      return rows;
    });
    try {
      await append(edit("a", "/tmp/a.ts"));
      expect(
        await paths().then(
          () => null,
          (error: unknown) => error
        )
      ).toBeInstanceOf(Error);
      expect(scan).toHaveBeenCalledTimes(2);
    } finally {
      scan.mockRestore();
      await cleanup();
    }
  });
});
