/**
 * A torn append (a crash or I/O error part way through a row) leaves a partial row in chat.jsonl.
 * The next append keeps those bytes as evidence and starts on a new line (the torn-tail repair in
 * historyAppendProvenance.ts appendChat). It must never rewrite the file. The fault layer cuts the
 * write, so the test needs no child process.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { Layer } from "effect";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { SessionFilesTag } from "@/node/services/di/tags";
import { makeFaults, withFaults } from "./sessionFiles/faultSessionFiles.testHarness";
import { SessionFilesMemory } from "./sessionFiles/memorySessionFiles.testHarness";
import { SessionFilesNode } from "./sessionFiles/nodeSessionFiles";
import { createTestHistoryService } from "./testHistoryService";

const workspaceId = "torn-write";

describe.each([
  ["memory", SessionFilesMemory],
  ["node", SessionFilesNode],
] as Array<[string, Layer.Layer<SessionFilesTag>]>)(
  "torn append on the %s layer",
  (_name, layer) => {
    test("a torn append gets a newline first, never a rewrite", async () => {
      const faults = makeFaults();
      const { historyService, files, config, cleanup } = await createTestHistoryService({
        files: withFaults(layer, faults),
      });
      try {
        const chatPath = path.join(config.sessionsDir, workspaceId, "chat.jsonl");
        // appendToHistory writes historySequence into the message, so each line is known after.
        const jsonLine = (message: MuxMessage) =>
          JSON.stringify({ ...message, workspaceId }) + "\n";
        const first = createMuxMessage("first", "user", "one", { timestamp: 1 });
        const second = createMuxMessage("second", "user", "two", { timestamp: 2 });
        const third = createMuxMessage("third", "user", "three", { timestamp: 3 });

        expect((await historyService.appendToHistory(workspaceId, first)).success).toBe(true);
        const { ino } = await files.promises.stat(chatPath, { bigint: true });
        faults.cutNextWrite(chatPath, { afterBytes: 17 }); // the crash point
        expect((await historyService.appendToHistory(workspaceId, second)).success).toBe(false);
        expect((await historyService.appendToHistory(workspaceId, third)).success).toBe(true);

        expect(await files.promises.readFile(chatPath, "utf8")).toBe(
          jsonLine(first) + jsonLine(second).slice(0, 17) + "\n" + jsonLine(third)
        );
        // The same inode: the repair appended, it did not replace the file.
        expect((await files.promises.stat(chatPath, { bigint: true })).ino).toBe(ino);
      } finally {
        await cleanup();
      }
    });
  }
);
