import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  SESSION_HISTORY_MAX_LINE_BYTES,
  SESSION_HISTORY_SCAN_CHUNK_BYTES,
} from "@/common/constants/contextBudget";
import { CHAT_ARCHIVE_FILE_NAME, CHAT_FILE_NAME } from "@/common/constants/paths";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { readCompactionPendingHistoryObservation } from "./historyScanner";
import { createTestHistoryService } from "./testHistoryService";

// #4551: a compaction boundary row over SESSION_HISTORY_MAX_LINE_BYTES (a large pending follow-up
// such as an inline image, or a row written before summaries were bounded) must still start the
// provider epoch. Rotation already recognizes it; the provider scanner has to agree.

const workspaceId = "oversized-boundary";
const NEEDLE = '"compactionBoundary":true';
const line = (message: MuxMessage) => JSON.stringify({ ...message, workspaceId }) + "\n";

const olderBoundary = createMuxMessage("b1", "assistant", "Older summary", {
  compactionBoundary: true,
  compacted: "user",
  compactionEpoch: 1,
  compactionPublicationId: "publication-1",
});
const beforeCompaction = createMuxMessage("u1", "user", "earlier turn");
const request = createMuxMessage("r", "user", "Please summarize the conversation", {
  muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
});
const after = createMuxMessage("t1", "user", "after compaction");

function newBoundary(size: "normal" | "oversized"): MuxMessage {
  return createMuxMessage("b2", "assistant", "New summary", {
    compactionBoundary: true,
    compacted: "user",
    compactionEpoch: 2,
    compactionPublicationId: "publication-2",
    muxMetadata: {
      type: "compaction-summary",
      pendingFollowUp: {
        text: "Look at this screenshot",
        model: "openai:gpt-4o",
        agentId: "exec",
        ...(size === "oversized" && {
          fileParts: [
            {
              url: "data:image/png;base64," + "A".repeat(SESSION_HISTORY_MAX_LINE_BYTES * 1.5),
              mediaType: "image/png",
            },
          ],
        }),
      },
    },
  });
}

describe("HistoryService oversized compaction boundaries", () => {
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  let chatPath: string;
  let archivePath: string;

  beforeEach(async () => {
    h = await createTestHistoryService();
    const dir = path.join(h.config.sessionsDir, workspaceId);
    await fs.mkdir(dir, { recursive: true });
    chatPath = path.join(dir, CHAT_FILE_NAME);
    archivePath = path.join(dir, CHAT_ARCHIVE_FILE_NAME);
  });
  afterEach(async () => {
    await h.cleanup();
  });

  // Seed through the real service: serialization and sequence stamping match production rows.
  async function seed(messages: MuxMessage[], target = workspaceId) {
    for (const message of messages) {
      const appended = await h.historyService.appendToHistory(target, message);
      if (!appended.success) throw new Error(appended.error);
    }
  }

  async function providerIds(): Promise<string[]> {
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    return history.data.map((message) => message.id);
  }

  test.each(["normal", "oversized"] as const)(
    "a %s boundary starts the provider epoch after rotation",
    async (size) => {
      const boundary = newBoundary(size);
      if (size === "oversized") {
        expect(Buffer.byteLength(line(boundary))).toBeGreaterThan(SESSION_HISTORY_MAX_LINE_BYTES);
      }
      await seed([olderBoundary, beforeCompaction, request, boundary, after]);

      // The first read seals everything before the newest boundary into the archive; the
      // provider scan must then start at that boundary instead of reviving the archive.
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      expect(history.data.map((message) => message.id)).toEqual(["b2", "t1"]);
      expect(history.data[0]?.metadata?.muxMetadata).toEqual(boundary.metadata?.muxMetadata);
      expect(await fs.readFile(archivePath, "utf8")).toContain('"id":"b1"');
    }
  );

  test("pending-state observation reports the oversized boundary's publication", async () => {
    // Read the unrotated layout directly: every row is still in chat.jsonl.
    await seed([olderBoundary, beforeCompaction, request, newBoundary("oversized"), after]);

    const observation = await readCompactionPendingHistoryObservation({
      chat: chatPath,
      archive: archivePath,
    });
    expect(observation.boundaryPublicationId).toBe("publication-2");
  });

  test("recognizes a boundary whose marker straddles a scan-chunk edge", async () => {
    await seed([olderBoundary, beforeCompaction, request, newBoundary("oversized")]);
    const seeded = await fs.readFile(chatPath);
    const needleAt = seeded.lastIndexOf(NEEDLE);
    // Reverse scan chunks end at fileSize - k * CHUNK; size the tail row so one edge splits the
    // marker. A same-width scratch workspace gives the serialized length of the unpadded tail.
    const scratch = workspaceId.slice(0, -1) + "x";
    await seed([after], scratch);
    const unpaddedTail = (
      await fs.readFile(path.join(path.dirname(chatPath), "..", scratch, CHAT_FILE_NAME))
    ).length;
    const splitAt = needleAt + 5;
    const pad =
      (((splitAt - seeded.length - unpaddedTail) % SESSION_HISTORY_SCAN_CHUNK_BYTES) +
        SESSION_HISTORY_SCAN_CHUNK_BYTES) %
      SESSION_HISTORY_SCAN_CHUNK_BYTES;
    await seed([createMuxMessage("t1", "user", "after compaction" + "x".repeat(pad))]);
    const size = (await fs.stat(chatPath)).size;
    expect((size - splitAt) % SESSION_HISTORY_SCAN_CHUNK_BYTES).toBe(0);

    // Rotation keeps the tail bytes, so the edge still splits the marker after the lazy seal.
    expect(await providerIds()).toEqual(["b2", "t1"]);
  });

  // Controls: identical before and after #4551.
  test("an oversized ordinary row that merely contains the marker is not a boundary", async () => {
    const quoting: MuxMessage = {
      ...createMuxMessage("quoting", "assistant", ""),
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "history",
          toolName: "session_history",
          state: "output-available",
          input: {},
          output: {
            rows: [{ metadata: { compactionBoundary: true } }],
            padding: "x".repeat(SESSION_HISTORY_MAX_LINE_BYTES),
          },
        },
      ],
    };
    expect(line(quoting)).toContain(NEEDLE);
    await seed([olderBoundary, beforeCompaction, quoting, after]);

    expect(await providerIds()).toEqual(["b1", "u1", "quoting", "t1"]);
  });

  test("an oversized boundary carrying reset evidence stays a privacy floor", async () => {
    // Raw reset evidence in a nested object: the oversized row's classifier treats it as ambiguous.
    const boundary: MuxMessage = {
      ...newBoundary("oversized"),
      ...{ evidence: { contextBoundaryKind: "reset" } },
    };
    await seed([olderBoundary, beforeCompaction, boundary, after]);

    expect(await providerIds()).toEqual(["t1"]);
  });
});
