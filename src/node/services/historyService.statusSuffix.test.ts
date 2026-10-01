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
  PAYLOAD_ROW_SHAPES,
  payloadPartial,
  payloadRow,
  referenceStatusElision,
  rowsToBytes,
  type GeneratedRow,
} from "./historyScanner.generator.testHarness";
import { SESSION_HISTORY_MAX_LINE_BYTES } from "@/common/constants/contextBudget";
import { readProviderHistoryFromLatestBoundary } from "./historyScanner";
import { createTestHistoryService } from "./testHistoryService";

// The sidebar status (#4720) keeps `filter(pred).slice(-N)` of this suffix, so its window equals
// the full provider read's exactly when the suffix is a suffix of that read holding at least N
// matching rows (or all of it). Every case below checks that contract against the two-pass
// provider reader (readProviderHistoryFromLatestBoundary), the independent oracle. Rows over
// SESSION_HISTORY_MAX_LINE_BYTES come back status-grade (#4790): the oracle applies the reference
// elision (referenceStatusElision) to exactly those rows, identified by their written size.
const statusRow = (m: MuxMessage) =>
  !isDurableContextResetBoundaryMarker(m) && !isModelHiddenMessage(m);

describe("HistoryService.getStatusHistorySuffix", () => {
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
  /** Ids of the rows written over the line limit; each id must name exactly one written row. */
  function oversizedIds(rows: readonly GeneratedRow[]): Set<string> {
    const oversized = new Set<string>();
    const small = new Set<string>();
    for (const row of rows) {
      let id: unknown;
      try {
        id = (JSON.parse(row.toString()) as { id?: unknown } | null)?.id;
      } catch {
        continue;
      }
      if (typeof id !== "string") continue;
      const ids = Buffer.byteLength(row) > SESSION_HISTORY_MAX_LINE_BYTES ? oversized : small;
      if (oversized.has(id) || (ids === oversized && small.has(id)))
        throw new Error(`ambiguous oracle id ${id}`);
      ids.add(id);
    }
    return oversized;
  }
  async function full(workspaceId: string, oversized = new Set<string>()): Promise<MuxMessage[]> {
    // The service read may rotate a legacy layout, but for skip 0 it shares the suffix scan
    // (#4655), so the oracle is the independent two-pass reader over the same (rotated) files.
    const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!result.success) throw new Error(result.error);
    const messages = await readProviderHistoryFromLatestBoundary(pathsFor(workspaceId), 0);
    return messages.map((m) =>
      oversized.has(m.id) ? (referenceStatusElision(m) as MuxMessage) : m
    );
  }
  async function suffix(workspaceId: string, window: number): Promise<MuxMessage[]> {
    const result = await h.historyService.getStatusHistorySuffix(workspaceId, window, statusRow);
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
    let payloadRowsCompared = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const random = mulberry32(seed);
      const rows = generateRows(random, { oversized: seed % 20 === 0, adversarial });
      if (seed % 20 === 0) {
        // Giant payload rows (#4790), from a separate stream so generateRows' inputs never drift.
        const extra = mulberry32(seed + 1_000_000);
        for (let k = 0; k < 1 + Math.floor(extra() * 3); k++) {
          const payload = 'y"\\é🎉'.repeat(Math.ceil(OVERSIZED / 8));
          const shape = Math.floor(extra() * PAYLOAD_ROW_SHAPES);
          const at = Math.floor(extra() * (rows.length + 1));
          rows.splice(at, 0, json(payloadRow(`p${k}`, shape, payload)));
        }
      }
      const oversized = oversizedIds(rows);
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
      if (seed % 20 === 0)
        payloadRowsCompared += tails
          .get(Math.max(...windows))!
          .filter((m) => /^p\d$/.test(m.id) && oversized.has(m.id)).length;
      if ((await stamps(workspaceId)) !== before)
        problems.push(`seed ${seed}: suffix read modified history files`);
      // The full read runs second: it may rotate a legacy layout.
      const fullRead = await full(workspaceId, oversized);
      for (const window of windows)
        problems.push(...check(`seed ${seed} N=${window}`, fullRead, tails.get(window)!, window));
      const rotated = await full(workspaceId, oversized);
      for (const window of windows) {
        const tail = await suffix(workspaceId, window);
        problems.push(...check(`seed ${seed} N=${window} rotated`, rotated, tail, window));
      }
    }
    // Most payload rows land before a floor; the elision is compared only if one survives
    // (seed 220 today), so a generator change must not silently drop that coverage.
    if (payloadRowsCompared === 0) problems.push("no giant payload row reached a compared window");
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

  test("fails closed if chat.jsonl changes during every read attempt", async () => {
    // One mid-scan change is absorbed by the locked fallback read (historyService.statusLock
    // tests); a change during that read too must still fail closed, never return stale rows.
    const workspaceId = "suffix-replaced";
    await writeLayout(workspaceId, null, [json(createMuxMessage("u", "user", "hello"))]);
    const paths = pathsFor(workspaceId);
    const stat = fs.stat;
    let changes = 0;
    const spy = spyOn(fs, "stat").mockImplementation((async (
      ...args: Parameters<typeof fs.stat>
    ) => {
      if (args[0] === paths.chat) {
        changes++;
        await fs.appendFile(
          paths.chat,
          `${json(createMuxMessage(`late${changes}`, "user", "late"))}\n`
        );
      }
      return stat(...args);
    }) as typeof fs.stat);
    try {
      const result = await h.historyService.getStatusHistorySuffix(workspaceId, 1, statusRow);
      expect(result.success).toBe(false);
      expect(result.success ? "" : result.error).toContain("History changed during provider read");
    } finally {
      spy.mockRestore();
    }
  });
});

// The sidebar status reads the in-flight partial status-grade (#5213): over
// SESSION_HISTORY_MAX_LINE_BYTES it must equal the oversized-row oracle applied to the provider
// read, at or under it the provider read itself.
describe("HistoryService.readStatusPartial", () => {
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  beforeEach(async () => {
    h = await createTestHistoryService();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  // Escapes and multi-byte characters make the projection's byte scan do real work.
  const payload = 'y"\\é🎉'.repeat(240_000);
  async function writePartial(workspaceId: string, message: MuxMessage): Promise<number> {
    expect((await h.historyService.writePartial(workspaceId, message)).success).toBe(true);
    return (await fs.stat(path.join(h.config.sessionsDir, workspaceId, "partial.json"))).size;
  }

  test("a giant partial comes back status-grade and stays provider-grade on disk", async () => {
    const message = payloadPartial("giant", payload);
    message.metadata = {};
    (message.metadata as Record<string, unknown>).cmuxMetadata = { type: "normal" };
    expect(await writePartial("ws", message)).toBeGreaterThan(SESSION_HISTORY_MAX_LINE_BYTES);

    const status = await h.historyService.readStatusPartial("ws");
    const full = await h.historyService.readPartial("ws");
    expect(full?.parts.slice(1)).toEqual(message.parts.slice(1));
    expect(full?.metadata?.muxMetadata?.type).toBe("normal");
    expect(status).toEqual(referenceStatusElision(full) as MuxMessage);
  });

  test("a giant partial with nothing to project takes the full parse", async () => {
    const message = createMuxMessage("text", "assistant", payload);
    expect(await writePartial("ws", message)).toBeGreaterThan(SESSION_HISTORY_MAX_LINE_BYTES);

    const status = await h.historyService.readStatusPartial("ws");
    expect(status?.parts).toEqual(message.parts);
    expect(status).toEqual(await h.historyService.readPartial("ws"));
  });

  test("a partial of exactly SESSION_HISTORY_MAX_LINE_BYTES keeps its payloads", async () => {
    const message = payloadPartial("edge", "small payload");
    let padding = 0;
    const padAndWrite = (bytes: number) => {
      padding += bytes;
      message.parts[0] = { type: "text", text: "x".repeat(padding) };
      return writePartial("ws", message);
    };
    const unpadded = await padAndWrite(0);
    expect(await padAndWrite(SESSION_HISTORY_MAX_LINE_BYTES - unpadded)).toBe(
      SESSION_HISTORY_MAX_LINE_BYTES
    );

    const full = await h.historyService.readPartial("ws");
    expect(full?.parts.slice(1)).toEqual(message.parts.slice(1));
    expect(await h.historyService.readStatusPartial("ws")).toEqual(full);

    expect(await padAndWrite(1)).toBe(SESSION_HISTORY_MAX_LINE_BYTES + 1);
    expect(await h.historyService.readStatusPartial("ws")).toEqual(
      referenceStatusElision(await h.historyService.readPartial("ws")) as MuxMessage
    );
  });
});
