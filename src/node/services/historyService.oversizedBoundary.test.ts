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
const line = (message: object) => JSON.stringify({ ...message, workspaceId }) + "\n";

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

  async function seed(chat: object[], archive: object[] = []) {
    await fs.writeFile(chatPath, chat.map(line).join(""));
    if (archive.length > 0) await fs.writeFile(archivePath, archive.map(line).join(""));
  }

  async function providerIds(): Promise<string[]> {
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    return history.data.map((message) => message.id);
  }

  test.each(["normal", "oversized"] as const)(
    "a %s boundary starts the provider epoch",
    async (size) => {
      const boundary = newBoundary(size);
      if (size === "oversized") {
        expect(Buffer.byteLength(line(boundary))).toBeGreaterThan(SESSION_HISTORY_MAX_LINE_BYTES);
      }
      await seed([olderBoundary, beforeCompaction, request, boundary, after]);

      expect(await providerIds()).toEqual(["b2", "t1"]);
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      expect(history.data[0]?.metadata?.muxMetadata).toEqual(boundary.metadata?.muxMetadata);
    }
  );

  test("after rotation, an oversized boundary does not bring back the archive", async () => {
    await seed([newBoundary("oversized"), after], [olderBoundary, beforeCompaction, request]);

    expect(await providerIds()).toEqual(["b2", "t1"]);
  });

  test("pending-state observation reports the oversized boundary's publication", async () => {
    await seed([olderBoundary, beforeCompaction, request, newBoundary("oversized"), after]);

    const observation = await readCompactionPendingHistoryObservation({
      chat: chatPath,
      archive: archivePath,
    });
    expect(observation.boundaryPublicationId).toBe("publication-2");
  });

  test("recognizes a boundary whose marker straddles a scan-chunk edge", async () => {
    const boundaryLine = line(newBoundary("oversized"));
    const prefix = line(olderBoundary) + line(beforeCompaction) + line(request);
    const needleAt =
      Buffer.byteLength(prefix) +
      Buffer.byteLength(boundaryLine.slice(0, boundaryLine.indexOf(NEEDLE)));
    // Reverse scan chunks end at fileSize - k * CHUNK; pad the tail so one edge splits the marker.
    const unpadded = Buffer.byteLength(prefix + boundaryLine + line(after));
    const splitAt = needleAt + 5;
    const pad =
      (((splitAt - unpadded) % SESSION_HISTORY_SCAN_CHUNK_BYTES) +
        SESSION_HISTORY_SCAN_CHUNK_BYTES) %
      SESSION_HISTORY_SCAN_CHUNK_BYTES;
    const paddedAfter = createMuxMessage("t1", "user", "after compaction" + "x".repeat(pad));
    const contents = prefix + boundaryLine + line(paddedAfter);
    expect((Buffer.byteLength(contents) - splitAt) % SESSION_HISTORY_SCAN_CHUNK_BYTES).toBe(0);
    await fs.writeFile(chatPath, contents);

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
    const boundary = { ...newBoundary("oversized"), evidence: { contextBoundaryKind: "reset" } };
    await seed([olderBoundary, beforeCompaction, boundary, after]);

    expect(await providerIds()).toEqual(["t1"]);
  });
});
