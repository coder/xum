import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage, type MuxMetadata } from "@/common/types/message";
import {
  deepEqualAnyDepth,
  generateRows,
  json,
  mulberry32,
  OVERSIZED,
  rowsToBytes,
  type GeneratedRow,
} from "./historyScanner.generator.testHarness";
import { readProviderHistoryFromLatestBoundary, type HistoryWindowCaps } from "./historyScanner";
import { createTestHistoryService } from "./testHistoryService";

// Bounded active-epoch reads for windowed onChat replay and in-epoch paging (#4961). Every case
// compares against the independent two-pass provider reader over the same files: a window must be
// a suffix of that full read, a since-floor read a suffix starting at the right row, and pages must
// tile the full read's sequenced rows without gaps or duplicates.

const BIG = 1_000_000_000;
const UNBOUNDED_EXTENSION = { extensionMaxRows: BIG, extensionMaxBytes: BIG };

function row(id: string, role: "user" | "assistant", seq: unknown, metadata?: MuxMetadata) {
  return json(
    createMuxMessage(id, role, `text ${id}`, {
      ...metadata,
      historySequence: seq,
    } as MuxMetadata)
  );
}
function boundary(id: string, seq: number, epoch: number) {
  return json(
    createMuxMessage(id, "assistant", `summary ${id}`, {
      historySequence: seq,
      compactionBoundary: true,
      compacted: true,
      compactionEpoch: epoch,
    })
  );
}
const fileSnapshot = (id: string, seq: number) =>
  row(id, "user", seq, { synthetic: true, fileAtMentionSnapshot: ["@a.ts"] });
const skillSnapshot = (id: string, seq: number) =>
  row(id, "user", seq, {
    synthetic: true,
    agentSkillSnapshot: { skillName: "s", scope: "project", sha256: "0" },
  });
const mcpSnapshot = (id: string, seq: number) =>
  row(id, "user", seq, {
    synthetic: true,
    mcpPromptSnapshot: { serverName: "srv", promptName: "p", commandKey: "k" },
  });
/** Assistant rows whose sequences have equally many digits have equal byte sizes. */
const assistants = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    row(`a${from + i + 1000}`, "assistant", from + i)
  );
const ids = (messages: MuxMessage[]) => messages.map((m) => m.id);

describe("HistoryService bounded active-epoch reads", () => {
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  beforeEach(async () => {
    h = await createTestHistoryService();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const pathsFor = (workspaceId: string) => ({
    chat: path.join(h.config.sessionsDir, workspaceId, "chat.jsonl"),
    archive: path.join(h.config.sessionsDir, workspaceId, "chat-archive.jsonl"),
  });
  async function writeLayout(
    workspaceId: string,
    archive: GeneratedRow[] | null,
    chat: GeneratedRow[] | null
  ) {
    const paths = pathsFor(workspaceId);
    await fs.mkdir(path.dirname(paths.chat), { recursive: true });
    if (archive) await fs.writeFile(paths.archive, rowsToBytes(archive));
    if (chat) await fs.writeFile(paths.chat, rowsToBytes(chat));
  }
  /** The oracle: the service read (which may rotate a legacy layout), then the two-pass reader. */
  async function full(workspaceId: string): Promise<MuxMessage[]> {
    const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!result.success) throw new Error(result.error);
    return readProviderHistoryFromLatestBoundary(pathsFor(workspaceId), 0);
  }
  async function window(
    workspaceId: string,
    caps: HistoryWindowCaps,
    observer?: Parameters<typeof h.historyService.getHistoryWindowFromLatestBoundary>[2]
  ) {
    const result = await h.historyService.getHistoryWindowFromLatestBoundary(
      workspaceId,
      caps,
      observer
    );
    if (!result.success) throw new Error(result.error);
    return result.data;
  }
  async function since(workspaceId: string, floor: number) {
    const result = await h.historyService.getHistorySinceSequence(workspaceId, floor);
    if (!result.success) throw new Error(result.error);
    return result.data;
  }
  async function page(
    workspaceId: string,
    options: Parameters<typeof h.historyService.getHistoryPageBefore>[1]
  ) {
    const result = await h.historyService.getHistoryPageBefore(workspaceId, options);
    if (!result.success) throw new Error(result.error);
    return result.data;
  }
  function expectSuffix(fullRead: MuxMessage[], tail: MuxMessage[]) {
    expect(tail.length).toBeLessThanOrEqual(fullRead.length);
    expect(deepEqualAnyDepth(tail, fullRead.slice(fullRead.length - tail.length))).toBe(true);
  }

  describe("window", () => {
    test("equals the full read when the epoch fits the caps", async () => {
      const ws = "window-fits";
      await writeLayout(ws, null, [
        row("old", "user", 0),
        boundary("b1", 1, 1),
        row("u2", "user", 2),
        row("a3", "assistant", 3),
      ]);
      const result = await window(ws, { maxRows: 10, maxBytes: BIG, ...UNBOUNDED_EXTENSION });
      expect(result.reachedEpochStart).toBe(true);
      expect(result.messages).toEqual(await full(ws));
      expect(ids(result.messages)).toEqual(["b1", "u2", "a3"]);
    });

    test("the row cap and the byte cap each bound the read", async () => {
      const ws = "window-caps";
      const rows = assistants(0, 49);
      await writeLayout(ws, null, rows);
      const fullRead = await full(ws);
      const noExtension = { extensionMaxRows: 0, extensionMaxBytes: 0 };

      const byRows = await window(ws, { maxRows: 7, maxBytes: BIG, ...noExtension });
      expect(byRows.messages).toHaveLength(7);
      expect(byRows.reachedEpochStart).toBe(false);
      expectSuffix(fullRead, byRows.messages);

      // Stops at the row that reaches the byte cap.
      const size = Buffer.byteLength(rows.at(-1)!);
      const byBytes = await window(ws, { maxRows: BIG, maxBytes: 3 * size + 1, ...noExtension });
      expect(byBytes.messages).toHaveLength(4);
      expect(byBytes.reachedEpochStart).toBe(false);
      expectSuffix(fullRead, byBytes.messages);

      // A row larger than the byte cap still yields one row.
      const tiny = await window(ws, { maxRows: BIG, maxBytes: 1, ...noExtension });
      expect(ids(tiny.messages)).toEqual([fullRead.at(-1)!.id]);

      // An unreadable newest row reaches the byte cap but projects nothing: the window still
      // holds one projected row instead of opening empty.
      const unreadableTail = "window-unreadable-tail";
      await writeLayout(unreadableTail, null, [...assistants(0, 4), "{broken json"]);
      const afterBroken = await window(unreadableTail, {
        maxRows: BIG,
        maxBytes: 1,
        ...noExtension,
      });
      expect(ids(afterBroken.messages)).toEqual(["a1004"]);
    });

    test("never crosses the latest compaction boundary, even while extending to a turn", async () => {
      const ws = "window-boundaries";
      await writeLayout(ws, null, [
        row("u0", "user", 0),
        boundary("b1", 1, 1),
        row("u2", "user", 2),
        boundary("b3", 3, 2),
        ...assistants(4, 9),
      ]);
      const fullRead = await full(ws);
      expect(fullRead[0].id).toBe("b3");
      // The fill ends mid-epoch with no user row in it: the extension stops at the boundary.
      const result = await window(ws, { maxRows: 2, maxBytes: BIG, ...UNBOUNDED_EXTENSION });
      expect(result.messages).toEqual(fullRead);
      expect(result.reachedEpochStart).toBe(true);
    });

    test("reads into the archive when chat.jsonl holds no boundary", async () => {
      const ws = "window-archive";
      await writeLayout(
        ws,
        [row("u0", "user", 0), boundary("b1", 1, 1), row("u2", "user", 2), ...assistants(3, 5)],
        [row("u6", "user", 6), ...assistants(7, 9)]
      );
      const fullRead = await full(ws);
      expect(fullRead[0].id).toBe("b1");

      // Six rows back from the end, then extended to the turn start u2 in the archive.
      const spill = await window(ws, { maxRows: 6, maxBytes: BIG, ...UNBOUNDED_EXTENSION });
      expect(spill.messages[0].id).toBe("u2");
      expectSuffix(fullRead, spill.messages);
      expect(spill.reachedEpochStart).toBe(false);

      const whole = await window(ws, { maxRows: 100, maxBytes: BIG, ...UNBOUNDED_EXTENSION });
      expect(whole.messages).toEqual(fullRead);
      expect(whole.reachedEpochStart).toBe(true);

      const chatOnly = await window(ws, { maxRows: 2, maxBytes: BIG, ...UNBOUNDED_EXTENSION });
      expect(ids(chatOnly.messages)).toEqual(ids(fullRead.slice(-4)));

      // chat.jsonl holds only malformed oversized rows: the scan counts the newest one toward the
      // cap and requests its stop on the older one, which cannot honor it (unreadable). The scan
      // must continue into the archive instead of returning nothing.
      const malformedChatWs = "window-archive-malformed-chat";
      const malformed = `{"broken": "${"y".repeat(OVERSIZED)}`;
      await writeLayout(
        malformedChatWs,
        [row("u0", "user", 0), boundary("b1", 1, 1), row("u2", "user", 2), ...assistants(3, 5)],
        [malformed, malformed]
      );
      const acrossSplit = await window(malformedChatWs, {
        maxRows: 1,
        maxBytes: BIG,
        extensionMaxRows: 0,
        extensionMaxBytes: 0,
      });
      expect(ids(acrossSplit.messages)).toEqual(["a1005"]);
      expect(acrossSplit.reachedEpochStart).toBe(false);
      expectSuffix(await full(malformedChatWs), acrossSplit.messages);
    });

    test("keeps oversized rows and skips malformed rows inside the window", async () => {
      const ws = "window-oversized";
      const big = json(
        createMuxMessage("big", "assistant", "y".repeat(OVERSIZED), { historySequence: 4 })
      );
      await writeLayout(ws, null, [
        row("u0", "user", 0),
        ...assistants(1, 3),
        big,
        "{broken json",
        row("u5", "user", 5),
        ...assistants(6, 8),
      ]);
      const fullRead = await full(ws);
      const result = await window(ws, {
        maxRows: 6,
        maxBytes: BIG,
        extensionMaxRows: 0,
        extensionMaxBytes: BIG,
      });
      expect(ids(result.messages)).toEqual(["a1003", "big", "u5", "a1006", "a1007", "a1008"]);
      expectSuffix(fullRead, result.messages);

      // An oversized row that turns out to be malformed projects nothing, so it must not use up
      // the row cap: the window still returns the newest readable row instead of nothing.
      const malformedWs = "window-oversized-malformed";
      await writeLayout(malformedWs, null, [
        row("u0", "user", 0),
        ...assistants(1, 2),
        `{"broken": "${"y".repeat(OVERSIZED)}`,
      ]);
      const afterMalformed = await window(malformedWs, {
        maxRows: 1,
        maxBytes: BIG,
        extensionMaxRows: 0,
        extensionMaxBytes: 0,
      });
      expect(ids(afterMalformed.messages)).toEqual(["a1002"]);
      expect(afterMalformed.reachedEpochStart).toBe(false);
      expectSuffix(await full(malformedWs), afterMalformed.messages);
    });

    test("starts on a real user turn and keeps its snapshot cluster", async () => {
      const ws = "window-turn";
      await writeLayout(ws, null, [
        row("u0", "user", 0),
        ...assistants(1, 1),
        // A snapshot row without a numeric sequence ends the cluster, as in keepRecentTail.
        row("x2", "user", "2", { synthetic: true, fileAtMentionSnapshot: ["@b.ts"] }),
        fileSnapshot("s3", 3),
        skillSnapshot("s4", 4),
        mcpSnapshot("s5", 5),
        row("u6", "user", 6),
        // A synthetic continuation is not a turn start.
        row("c7", "user", 7, { synthetic: true }),
        ...assistants(8, 10),
      ]);
      const fullRead = await full(ws);
      const result = await window(ws, { maxRows: 2, maxBytes: BIG, ...UNBOUNDED_EXTENSION });
      expect(ids(result.messages)).toEqual([
        "s3",
        "s4",
        "s5",
        "u6",
        "c7",
        "a1008",
        "a1009",
        "a1010",
      ]);
      expect(result.reachedEpochStart).toBe(false);
      expectSuffix(fullRead, result.messages);

      // A turn start on the fill row itself still pulls in its cluster.
      const atStart = await window(ws, { maxRows: 5, maxBytes: BIG, ...UNBOUNDED_EXTENSION });
      expect(atStart.messages[0].id).toBe("s3");
    });

    test("a cap that lands inside a prompt's snapshot cluster stops after that cluster", async () => {
      const ws = "window-cap-in-cluster";
      await writeLayout(ws, null, [
        row("u0", "user", 0),
        ...assistants(1, 3),
        fileSnapshot("s4", 4),
        fileSnapshot("s5", 5),
        row("u6", "user", 6),
        ...assistants(7, 7),
      ]);
      // Newest first: a1007, u6, then the cap lands on s5, which belongs to u6's cluster. The
      // window must take s4 and stop, not extend through the older turn to u0.
      const result = await window(ws, { maxRows: 3, maxBytes: BIG, ...UNBOUNDED_EXTENSION });
      expect(ids(result.messages)).toEqual(["s4", "s5", "u6", "a1007"]);
      expect(result.reachedEpochStart).toBe(false);
      expectSuffix(await full(ws), result.messages);
    });

    test("a prompt whose snapshot cluster exceeds the extension bound is rolled back", async () => {
      const ws = "window-cluster-over-bound";
      await writeLayout(ws, null, [
        row("u0", "user", 0),
        ...assistants(1, 3),
        fileSnapshot("s4", 4),
        fileSnapshot("s5", 5),
        fileSnapshot("s6", 6),
        row("u7", "user", 7),
        ...assistants(8, 12),
      ]);
      // Fill ends mid-turn at a1010; the extension reaches u7 but only one of its three snapshot
      // rows fits, so the cut goes back to just after the prompt instead of starting on a prompt
      // without its snapshots.
      const result = await window(ws, {
        maxRows: 3,
        maxBytes: BIG,
        extensionMaxRows: 4,
        extensionMaxBytes: BIG,
      });
      expect(ids(result.messages)).toEqual(["a1008", "a1009", "a1010", "a1011", "a1012"]);
      expect(result.reachedEpochStart).toBe(false);
      expectSuffix(await full(ws), result.messages);
      // The same rollback when the fill cap lands on the prompt itself.
      const capOnPrompt = await window(ws, {
        maxRows: 6,
        maxBytes: BIG,
        extensionMaxRows: 1,
        extensionMaxBytes: BIG,
      });
      expect(ids(capOnPrompt.messages)).toEqual(ids(result.messages));

      // A cluster that is already complete at the bound keeps its prompt: the older row that ends
      // the cluster is outside the window and must not count against the extension.
      const completeWs = "window-complete-at-bound";
      await writeLayout(completeWs, null, [
        row("u0", "user", 0),
        ...assistants(1, 3),
        row("u4", "user", 4),
        ...assistants(5, 8),
      ]);
      const promptAtBound = await window(completeWs, {
        maxRows: 3,
        maxBytes: BIG,
        extensionMaxRows: 2,
        extensionMaxBytes: BIG,
      });
      expect(ids(promptAtBound.messages)).toEqual(["u4", "a1005", "a1006", "a1007", "a1008"]);
      const snapshotLayoutWs = "window-complete-cluster-zero-extension";
      await writeLayout(snapshotLayoutWs, null, [
        row("u0", "user", 0),
        ...assistants(1, 1),
        fileSnapshot("s2", 2),
        row("u3", "user", 3),
        ...assistants(4, 4),
      ]);
      const capOnOldestSnapshot = await window(snapshotLayoutWs, {
        maxRows: 3,
        maxBytes: BIG,
        extensionMaxRows: 0,
        extensionMaxBytes: 0,
      });
      expect(ids(capOnOldestSnapshot.messages)).toEqual(["s2", "u3", "a1004"]);
      expectSuffix(await full(snapshotLayoutWs), capOnOldestSnapshot.messages);

      // A prompt that is the only projected row stays, even without its whole cluster.
      const onlyPromptWs = "window-only-prompt";
      await writeLayout(onlyPromptWs, null, [
        row("u0", "user", 0),
        fileSnapshot("s1", 1),
        fileSnapshot("s2", 2),
        fileSnapshot("s3", 3),
        row("u4", "user", 4),
      ]);
      const onlyPrompt = await window(onlyPromptWs, {
        maxRows: 1,
        maxBytes: BIG,
        extensionMaxRows: 2,
        extensionMaxBytes: BIG,
      });
      expect(ids(onlyPrompt.messages)).toEqual(["s2", "s3", "u4"]);
      expectSuffix(await full(onlyPromptWs), onlyPrompt.messages);
    });

    test("oversized prompt and snapshot rows keep the turn's snapshot cluster", async () => {
      const ws = "window-oversized-prompt";
      const bigPrompt = json(
        createMuxMessage("big-user", "user", "y".repeat(OVERSIZED), { historySequence: 5 })
      );
      await writeLayout(ws, null, [
        row("u0", "user", 0),
        ...assistants(1, 3),
        fileSnapshot("s4", 4),
        bigPrompt,
        ...assistants(6, 8),
      ]);
      const result = await window(ws, { maxRows: 2, maxBytes: BIG, ...UNBOUNDED_EXTENSION });
      expect(ids(result.messages)).toEqual(["s4", "big-user", "a1006", "a1007", "a1008"]);
      expect(result.reachedEpochStart).toBe(false);
      expectSuffix(await full(ws), result.messages);

      // An oversized snapshot inside a readable prompt's cluster does not end the cluster during
      // the scan (its type is unknown there), so older snapshots before it stay in the window.
      const bigSnapshotWs = "window-oversized-snapshot";
      const bigSnapshot = json(
        createMuxMessage("big-snap", "user", "y".repeat(OVERSIZED), {
          historySequence: 4,
          synthetic: true,
          fileAtMentionSnapshot: ["@big.ts"],
        })
      );
      await writeLayout(bigSnapshotWs, null, [
        row("u0", "user", 0),
        ...assistants(1, 1),
        fileSnapshot("s2", 2),
        fileSnapshot("s3", 3),
        bigSnapshot,
        row("u5", "user", 5),
        ...assistants(6, 8),
      ]);
      const withBigSnapshot = await window(bigSnapshotWs, {
        maxRows: 2,
        maxBytes: BIG,
        ...UNBOUNDED_EXTENSION,
      });
      expect(ids(withBigSnapshot.messages)).toEqual([
        "s2",
        "s3",
        "big-snap",
        "u5",
        "a1006",
        "a1007",
        "a1008",
      ]);
      expectSuffix(await full(bigSnapshotWs), withBigSnapshot.messages);
    });

    test("cuts mid-turn when the extension bound is hit first", async () => {
      const ws = "window-long-turn";
      const rows = [row("u0", "user", 0), ...assistants(1, 20)];
      await writeLayout(ws, null, rows);
      const fullRead = await full(ws);

      const byRows = await window(ws, {
        maxRows: 3,
        maxBytes: BIG,
        extensionMaxRows: 5,
        extensionMaxBytes: BIG,
      });
      expect(ids(byRows.messages)).toEqual(ids(fullRead.slice(-8)));
      expect(byRows.messages[0].role).toBe("assistant");
      expect(byRows.reachedEpochStart).toBe(false);

      const size = Buffer.byteLength(rows.at(-1)!);
      const byBytes = await window(ws, {
        maxRows: 3,
        maxBytes: BIG,
        extensionMaxRows: BIG,
        extensionMaxBytes: 2 * size + 1,
      });
      expect(ids(byBytes.messages)).toEqual(ids(fullRead.slice(-5)));
      expect(byBytes.reachedEpochStart).toBe(false);
    });

    // Reset floors, unreadable and oversized rows, chunk edges, archive splits: whatever the
    // locator does, a window is a suffix of the full read, respects its caps, and claims the epoch
    // start only when it returned all of it.
    test("is a bounded suffix of the full read on generated layouts", async () => {
      const problems: string[] = [];
      const capsList: HistoryWindowCaps[] = [
        { maxRows: 1, maxBytes: BIG, extensionMaxRows: 0, extensionMaxBytes: 0 },
        { maxRows: 3, maxBytes: BIG, extensionMaxRows: 2, extensionMaxBytes: BIG },
        { maxRows: 10, maxBytes: 4096, extensionMaxRows: 5, extensionMaxBytes: 2048 },
        { maxRows: 40, maxBytes: BIG, ...UNBOUNDED_EXTENSION },
      ];
      for (let seed = 1; seed <= 120; seed++) {
        const random = mulberry32(seed);
        const oversized = seed % 20 === 0;
        const rows = generateRows(random, { oversized, adversarial: seed % 2 === 0 });
        const split = Math.floor(random() * (rows.length + 1));
        const ws = `window-gen-${seed}`;
        if (random() < 0.5) await writeLayout(ws, null, rows);
        else await writeLayout(ws, rows.slice(0, split), rows.slice(split));
        const fullRead = await full(ws);
        let fullBytes = 0;
        await readProviderHistoryFromLatestBoundary(pathsFor(ws), 0, {
          onBytesRead: (n) => (fullBytes += n),
        });
        for (const caps of capsList) {
          const label = `seed ${seed} caps ${JSON.stringify(caps)}`;
          let bytes = 0;
          const result = await window(ws, caps, { onBytesRead: (n) => (bytes += n) });
          const tail = result.messages;
          // Replay timing (#4504): a window that covers the epoch reports the full read's bytes.
          if (result.reachedEpochStart && bytes !== fullBytes)
            problems.push(`${label}: replay bytes differ from the full read`);
          if (
            tail.length > fullRead.length ||
            !deepEqualAnyDepth(tail, fullRead.slice(fullRead.length - tail.length))
          )
            problems.push(`${label}: not a suffix of the full read`);
          if (result.reachedEpochStart && tail.length !== fullRead.length)
            problems.push(`${label}: claims the epoch start without the whole epoch`);
          if (tail.length > caps.maxRows + caps.extensionMaxRows)
            problems.push(`${label}: exceeds the row caps`);
          // Without oversized rows every counted row is projected, so a short window means the
          // byte cap or the whole epoch.
          if (
            !oversized &&
            caps.maxBytes === BIG &&
            tail.length < Math.min(caps.maxRows, fullRead.length)
          )
            problems.push(`${label}: shorter than the row cap`);
        }
      }
      expect(problems).toEqual([]);
    }, 60_000);
  });

  describe("since floor", () => {
    const epoch = () => [row("u0", "user", 0), boundary("b1", 1, 1), ...assistants(2, 9)];

    test("starts at the floor row", async () => {
      const ws = "since-present";
      await writeLayout(ws, null, epoch());
      const rows = await since(ws, 5);
      expect(rows.map((m) => m.metadata?.historySequence)).toEqual([5, 6, 7, 8, 9]);
      expectSuffix(await full(ws), rows);

      // The scan cannot parse an oversized floor row, but the result still starts at it.
      const oversized = "since-oversized";
      const big = json(
        createMuxMessage("big", "assistant", "y".repeat(OVERSIZED), { historySequence: 5 })
      );
      await writeLayout(
        oversized,
        null,
        epoch().map((r, i) => (i === 5 ? big : r))
      );
      const fromBig = await since(oversized, 5);
      expect(ids(fromBig)).toEqual(["big", "a1006", "a1007", "a1008", "a1009"]);
      expectSuffix(await full(oversized), fromBig);
    });

    test("a deleted or unreadable floor row starts at an older row", async () => {
      const deleted = epoch().filter((_, i) => i !== 5);
      await writeLayout("since-deleted", null, deleted);
      const fromDeleted = await since("since-deleted", 5);
      expect(fromDeleted[0].metadata?.historySequence).toBe(4);
      expectSuffix(await full("since-deleted"), fromDeleted);

      const broken = epoch().map((r, i) => (i === 5 ? '{"id":"a1005","role":' : r));
      await writeLayout("since-broken", null, broken);
      const fromBroken = await since("since-broken", 5);
      expect(fromBroken[0].metadata?.historySequence).toBe(4);
      expectSuffix(await full("since-broken"), fromBroken);
    });

    test("never stops at a row whose sequence is not a number", async () => {
      const ws = "since-string";
      const rows = epoch().map((r, i) =>
        i === 7 ? row("s7", "assistant", "7") : i === 8 ? row("s8", "assistant", "8") : r
      );
      await writeLayout(ws, null, rows);
      const result = await since(ws, 7);
      expect(result[0].metadata?.historySequence).toBe(6);
      expect(ids(result)).toEqual(["a1006", "s7", "s8", "a1009"]);
      expectSuffix(await full(ws), result);
    });

    test("a floor older than the latest boundary reads the whole active epoch", async () => {
      const ws = "since-old-floor";
      await writeLayout(ws, null, epoch());
      const result = await since(ws, 0);
      expect(result).toEqual(await full(ws));
      expect(result[0].id).toBe("b1");
    });
  });

  describe("pages", () => {
    function pagedLayout(): GeneratedRow[] {
      return [
        ...assistants(0, 2),
        boundary("b3", 3, 1),
        ...assistants(4, 8),
        "not json",
        row("str", "assistant", "9"),
        json(createMuxMessage("big", "assistant", "y".repeat(OVERSIZED), { historySequence: 10 })),
        row("u11", "user", 11),
        ...assistants(12, 20),
      ];
    }

    test("paging from the newest row tiles the epoch's sequenced rows exactly", async () => {
      const ws = "page-tile";
      await writeLayout(ws, null, pagedLayout());
      const expected = (await full(ws)).filter(
        (m) => typeof m.metadata?.historySequence === "number"
      );
      expect(expected[0].id).toBe("b3");
      for (const maxRows of [1, 3, 4, 17, 50]) {
        const pages: MuxMessage[][] = [];
        const reached: boolean[] = [];
        let before = 21;
        for (let guard = 0; guard < 100; guard++) {
          const result = await page(ws, { beforeHistorySequence: before, maxRows });
          expect(result.messages.length).toBeGreaterThan(0);
          expect(result.messages.length).toBeLessThanOrEqual(maxRows);
          pages.unshift(result.messages);
          reached.push(result.reachedEpochStart);
          if (result.reachedEpochStart) break;
          before = result.messages[0].metadata!.historySequence!;
        }
        expect(pages.flat()).toEqual(expected);
        expect(reached.at(-1)).toBe(true);
        expect(reached.slice(0, -1).every((r) => !r)).toBe(true);
      }
    });

    test("through returns every row from the through row up to before in one call", async () => {
      const ws = "page-through";
      await writeLayout(ws, null, pagedLayout());
      const result = await page(ws, {
        beforeHistorySequence: 18,
        throughHistorySequence: 6,
        maxRows: 2,
      });
      expect(result.messages.map((m) => m.metadata?.historySequence)).toEqual([
        6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17,
      ]);
      expect(result.reachedEpochStart).toBe(false);

      const toStart = await page(ws, { beforeHistorySequence: 6, throughHistorySequence: 3 });
      expect(ids(toStart.messages)).toEqual(["b3", "a1004", "a1005"]);
      expect(toStart.reachedEpochStart).toBe(true);
    });

    test("rows with an equal sequence survive a page boundary when the cursor names its row", async () => {
      const ws = "page-equal-sequence";
      // Duplicate sequences (an old multi-backend race or a repaired file) must stay browsable:
      // the cursor row's id tells rows at or before the cursor apart from rows after it. The
      // duplicate at sequence 0 guards the empty-page shortcut for a cursor at sequence 0.
      await writeLayout(ws, null, [
        row("d0", "assistant", 0),
        ...assistants(0, 3),
        row("d4a", "assistant", 4),
        row("d4b", "assistant", 4),
        row("d4c", "assistant", 4),
        ...assistants(5, 7),
      ]);
      const expected = await full(ws);
      for (const maxRows of [1, 2]) {
        const pages: MuxMessage[][] = [];
        let cursor: { beforeHistorySequence: number; beforeMessageId?: string } = {
          beforeHistorySequence: 8,
        };
        for (let guard = 0; guard < 50; guard++) {
          const result = await page(ws, { ...cursor, maxRows });
          expect(result.messages.length).toBeGreaterThan(0);
          pages.unshift(result.messages);
          if (result.reachedEpochStart) break;
          const oldest = result.messages[0];
          cursor = {
            beforeHistorySequence: oldest.metadata!.historySequence!,
            beforeMessageId: oldest.id,
          };
        }
        expect(ids(pages.flat())).toEqual(ids(expected));
      }
    });

    test("honors the byte cap", async () => {
      const ws = "page-bytes";
      const rows = assistants(0, 9);
      await writeLayout(ws, null, rows);
      const size = Buffer.byteLength(rows[0]);
      const capped = await page(ws, { beforeHistorySequence: 10, maxBytes: 3 * size + 1 });
      expect(capped.messages.map((m) => m.metadata?.historySequence)).toEqual([7, 8, 9]);
      expect(capped.reachedEpochStart).toBe(false);
      // A single row over the cap still returns, so paging always progresses.
      const tiny = await page(ws, { beforeHistorySequence: 5, maxBytes: 1 });
      expect(tiny.messages.map((m) => m.metadata?.historySequence)).toEqual([4]);
      const throughCapped = await page(ws, {
        beforeHistorySequence: 10,
        throughHistorySequence: 0,
        maxBytes: 2 * size + 1,
      });
      expect(throughCapped.messages.map((m) => m.metadata?.historySequence)).toEqual([8, 9]);
      expect(throughCapped.reachedEpochStart).toBe(false);
    });
  });
});
