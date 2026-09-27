import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { isDurableContextResetBoundaryMarker } from "@/common/utils/messages/compactionBoundary";
import { isModelHiddenMessage } from "@/common/utils/messages/modelHiddenMessages";
import {
  deepEqualAnyDepth,
  generateRows,
  json,
  mulberry32,
  OVERSIZED,
  rowsToBytes,
  type GeneratedRow,
} from "./historyScanner.generator.testHarness";
import { readProviderHistoryFromLatestBoundary } from "./historyScanner";
import { createTestHistoryService } from "./testHistoryService";

// The sidebar status (#4720) keeps `filter(pred).slice(-N)` of this suffix, so its window equals
// the full provider read's exactly when the suffix is a suffix of that read holding at least N
// matching rows (or all of it). Every case below checks that contract against the two-pass
// provider reader (readProviderHistoryFromLatestBoundary), the independent oracle.
const statusRow = (m: MuxMessage) =>
  !isDurableContextResetBoundaryMarker(m) && !isModelHiddenMessage(m);

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
  async function stamps(workspaceId: string): Promise<string> {
    const paths = pathsFor(workspaceId);
    const stamp = async (file: string) => {
      const stat = await fs.stat(file).catch(() => null);
      return stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}` : "missing";
    };
    return `${await stamp(paths.chat)}|${await stamp(paths.archive)}`;
  }
  async function full(workspaceId: string): Promise<MuxMessage[]> {
    // The service read may rotate a legacy layout, but for skip 0 it shares the suffix scan
    // (#4655), so the oracle is the independent two-pass reader over the same (rotated) files.
    const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!result.success) throw new Error(result.error);
    return readProviderHistoryFromLatestBoundary(pathsFor(workspaceId), 0);
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
    else if (!deepEqualAnyDepth(tail, fullRead.slice(fullRead.length - tail.length)))
      problems.push(`${label}: not a suffix of the full read`);
    if (tail.filter(statusRow).length < window && tail.length !== fullRead.length)
      problems.push(`${label}: short window without reading everything`);
    return problems;
  }

  async function checkGeneratedLayouts(
    seeds: number,
    windows: number[],
    adversarial: boolean
  ): Promise<string[]> {
    const problems: string[] = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const random = mulberry32(seed);
      const rows = generateRows(random, { oversized: seed % 20 === 0, adversarial });
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
    return problems;
  }

  test("matches the full provider read on generated layouts, before and after rotation", async () => {
    expect(await checkGeneratedLayouts(240, [1, 2, 3, 5, 80], false)).toEqual([]);
  }, 60_000);

  // Reset encodings split across unreadable rows, readable rows that merely mention resets,
  // escaped boundary keys, deep nesting, line-size and chunk edges, and invalid UTF-8 (#4655).
  // The nesting stays below Bun's JSON.stringify limit, so the classifier's stringify-throw path
  // is covered only by historyScanner.differential.test.ts. A window no epoch can fill never
  // stops early, so check() requires that read to equal the full read exactly.
  test("matches the full provider read on adversarial layouts", async () => {
    const windows = [1, 2, 3, 5, 80, Number.MAX_SAFE_INTEGER];
    expect(await checkGeneratedLayouts(240, windows, true)).toEqual([]);
  }, 120_000);

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
      const result = await h.historyService.getHistorySuffixFromLatestBoundary(
        workspaceId,
        1,
        statusRow
      );
      expect(result.success).toBe(false);
      expect(result.success ? "" : result.error).toContain("History changed during provider read");
    } finally {
      spy.mockRestore();
    }
  });
});
