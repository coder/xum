import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SESSION_HISTORY_MAX_LINE_BYTES } from "@/common/constants/contextBudget";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { isDurableContextResetBoundaryMarker } from "@/common/utils/messages/compactionBoundary";
import { isModelHiddenMessage } from "@/common/utils/messages/modelHiddenMessages";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
import { readProviderHistorySuffix } from "./historyScanner";
import { createTestHistoryService } from "./testHistoryService";

// The sidebar status (#4720) keeps `filter(pred).slice(-N)` of this suffix, so its window equals
// the full provider read's exactly when the suffix is a suffix of that read holding at least N
// matching rows (or all of it). Every case below checks that contract against the real
// getHistoryFromLatestBoundary.
const statusRow = (m: MuxMessage) =>
  !isDurableContextResetBoundaryMarker(m) && !isModelHiddenMessage(m);
const OVERSIZED = SESSION_HISTORY_MAX_LINE_BYTES + 4096;

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const json = (m: MuxMessage) => JSON.stringify(m);
const rollover = {
  type: "context-window-rollover",
  rolloverId: "r",
  reason: "on-send",
  previousWindowId: "w:0",
  flushOpportunity: false,
  contextTokens: 100,
  maxTokens: 200,
};
function toolRow(id: string, output: unknown): string {
  const message = createMuxMessage(id, "assistant", "running a tool");
  message.parts.push({
    type: "dynamic-tool",
    toolCallId: `${id}-call`,
    toolName: "bash",
    state: "output-available",
    input: { script: "ls" },
    output,
  });
  return json(message);
}
function hiddenRow(id: string): string {
  const record = { v: 1 as const, kind: "resolve" as const, recordId: id, threadId: "t" };
  return json(
    createMuxMessage(id, "user", formatPlanReviewEnvelope(record), {
      synthetic: true,
      muxMetadata: buildPlanReviewMetadata(record),
    })
  );
}

/** Rows in file order (oldest first), without newlines. */
function generateRows(random: () => number, withOversized: boolean): string[] {
  const rows: string[] = [];
  const count = Math.floor(random() * 160);
  for (let i = 0; i < count; i++) {
    const id = `m${i}`;
    const r = random();
    if (r < 0.4) {
      const text = random() < 0.2 ? `héllo — 日本語 🎉 ${i}` : `message ${i}`;
      const pad = random() < 0.03 ? "x".repeat(20_000 + Math.floor(random() * 50_000)) : "";
      const row = json(createMuxMessage(id, random() < 0.5 ? "user" : "assistant", text + pad));
      rows.push(random() < 0.05 ? `${row}\r` : row);
    } else if (r < 0.5) rows.push(toolRow(id, { success: true, output: "file ".repeat(20) }));
    else if (r < 0.62) rows.push(hiddenRow(id));
    else if (r < 0.66) {
      const durable = random() < 0.6;
      rows.push(
        json(
          createMuxMessage(id, "assistant", "summary", {
            compactionBoundary: true,
            compacted: true,
            ...(durable ? { compactionEpoch: i + 1 } : {}),
          })
        )
      );
    } else if (r < 0.68)
      rows.push(json(createMuxMessage(id, "assistant", "", { contextBoundaryKind: "reset" })));
    else if (r < 0.7)
      rows.push(
        json(
          createMuxMessage(id, "assistant", "", {
            contextBoundaryKind: "reset",
            muxMetadata: rollover,
          } as MuxMessage["metadata"])
        )
      );
    else if (r < 0.72) rows.push('{"metadata":{"contextBoundaryKind" : "reset"},broken');
    else if (r < 0.75) {
      const fragments = [
        ['"contextBoundaryKind"', ":", '"reset"'],
        ['{"metadata":{"contextBoundaryKind"', ': "reset"},broken'],
        ['junk "contextBoundaryKind" junk', 'more : junk "reset" }'],
      ];
      rows.push(...fragments[Math.floor(random() * fragments.length)]);
    } else if (r < 0.8)
      rows.push(["not json", "{", "[]", "null", "", "   "][Math.floor(random() * 6)]);
    else if (r < 0.82) rows.push('junk "contextBoundaryKind" junk');
    else rows.push(json(createMuxMessage(id, "user", `plain ${i}`)));
    if (withOversized && random() < 0.02) {
      const big = "y".repeat(OVERSIZED);
      const shapes = [
        json(createMuxMessage(`${id}-big`, "user", big)),
        // Raw reset tokens inside a readable oversized row: the locator floors at it.
        toolRow(`${id}-big`, { note: big, nested: { contextBoundaryKind: "reset" } }),
        // A value token only: chains with an older key-bearing junk row into a floor.
        json(
          createMuxMessage(`${id}-big`, "user", big, { note: "reset" } as MuxMessage["metadata"])
        ),
      ];
      rows.push(shapes[Math.floor(random() * shapes.length)]);
    }
  }
  return rows;
}

describe("HistoryService.getHistorySuffixFromLatestBoundary", () => {
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
  async function writeLayout(workspaceId: string, archive: string[] | null, chat: string[] | null) {
    const paths = pathsFor(workspaceId);
    await fs.mkdir(path.dirname(paths.chat), { recursive: true });
    if (archive) await fs.writeFile(paths.archive, archive.map((row) => `${row}\n`).join(""));
    if (chat) await fs.writeFile(paths.chat, chat.map((row) => `${row}\n`).join(""));
  }
  async function stamps(workspaceId: string): Promise<string> {
    const paths = pathsFor(workspaceId);
    const stamp = async (file: string) => {
      const stat = await fs.stat(file).catch(() => null);
      return stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}` : "missing";
    };
    return `${await stamp(paths.chat)}|${await stamp(paths.archive)}`;
  }
  async function full(workspaceId: string): Promise<MuxMessage[]> {
    const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!result.success) throw new Error(result.error);
    return result.data;
  }
  async function suffix(workspaceId: string, window: number): Promise<MuxMessage[]> {
    const result = await h.historyService.getHistorySuffixFromLatestBoundary(
      workspaceId,
      window,
      statusRow
    );
    if (!result.success) throw new Error(result.error);
    return result.data;
  }
  /** Returns a description of each broken invariant (empty when the suffix is valid). */
  function check(label: string, fullRead: MuxMessage[], tail: MuxMessage[], window: number) {
    const problems: string[] = [];
    if (tail.length > fullRead.length) problems.push(`${label}: longer than the full read`);
    else if (!Bun.deepEquals(tail, fullRead.slice(fullRead.length - tail.length)))
      problems.push(`${label}: not a suffix of the full read`);
    if (tail.filter(statusRow).length < window && tail.length !== fullRead.length)
      problems.push(`${label}: short window without reading everything`);
    return problems;
  }

  test("matches the full provider read on generated layouts, before and after rotation", async () => {
    const windows = [1, 2, 3, 5, 80];
    const problems: string[] = [];
    for (let seed = 1; seed <= 240; seed++) {
      const random = mulberry32(seed);
      const rows = generateRows(random, seed % 20 === 0);
      const layout = random();
      const split = Math.floor(random() * (rows.length + 1));
      const workspaceId = `suffix-${seed}`;
      if (layout < 0.4) await writeLayout(workspaceId, null, rows);
      else if (layout < 0.85)
        await writeLayout(workspaceId, rows.slice(0, split), rows.slice(split));
      else await writeLayout(workspaceId, rows, null);

      const before = await stamps(workspaceId);
      const tails = new Map<number, MuxMessage[]>();
      for (const window of windows) tails.set(window, await suffix(workspaceId, window));
      if ((await stamps(workspaceId)) !== before)
        problems.push(`seed ${seed}: suffix read modified history files`);
      // The full read runs second: it may rotate a legacy layout.
      const fullRead = await full(workspaceId);
      for (const window of windows)
        problems.push(...check(`seed ${seed} N=${window}`, fullRead, tails.get(window)!, window));
      const rotated = await full(workspaceId);
      for (const window of windows) {
        const tail = await suffix(workspaceId, window);
        problems.push(...check(`seed ${seed} N=${window} rotated`, rotated, tail, window));
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);

  test("does not stop at an unreadable row a fragmented reset floors", async () => {
    // Oldest to newest: the junk row's key and the oversized row's `:"reset"` complete a raw
    // reset whose floor is the end of that unreadable run, so the full read keeps only V1.
    // Stopping as soon as two rows parse (V1 and the oversized row) would leak the oversized row.
    const workspaceId = "suffix-clean-stop";
    await writeLayout(workspaceId, null, [
      json(createMuxMessage("r0", "user", "before the floor")),
      'junk "contextBoundaryKind" junk',
      json(
        createMuxMessage("o", "user", "y".repeat(OVERSIZED), {
          note: "reset",
        } as MuxMessage["metadata"])
      ),
      json(createMuxMessage("v1", "user", "after the floor")),
    ]);
    const tail = await suffix(workspaceId, 2);
    expect(tail.map((m) => m.id)).toEqual(["v1"]);
    expect(tail).toEqual(await full(workspaceId));
  });

  test("reads only the trailing window of a long epoch", async () => {
    const workspaceId = "suffix-long";
    const rows = Array.from({ length: 2000 }, (_, i) =>
      json(createMuxMessage(`m${i}`, i % 2 ? "assistant" : "user", `message ${i}`))
    );
    await writeLayout(workspaceId, null, rows);
    const tail = await suffix(workspaceId, 80);
    expect(tail.length).toBeLessThan(200);
    expect(check("long", await full(workspaceId), tail, 80)).toEqual([]);
  });

  test("fails closed if chat.jsonl changes during the read", async () => {
    const workspaceId = "suffix-replaced";
    await writeLayout(workspaceId, null, [json(createMuxMessage("u", "user", "hello"))]);
    const paths = pathsFor(workspaceId);
    const stat = fs.stat;
    let changed = false;
    const spy = spyOn(fs, "stat").mockImplementation((async (
      ...args: Parameters<typeof fs.stat>
    ) => {
      if (args[0] === paths.chat && !changed) {
        changed = true;
        await fs.appendFile(paths.chat, `${json(createMuxMessage("late", "user", "late"))}\n`);
      }
      return stat(...args);
    }) as typeof fs.stat);
    try {
      expect(
        await readProviderHistorySuffix(paths, 1, statusRow).catch((error: unknown) => error)
      ).toMatchObject({ message: "History changed during provider read" });
    } finally {
      spy.mockRestore();
    }
  });
});
