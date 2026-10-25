import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
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

// The trailing window for onChat replay (#4961). Its contract: at most maxRows rows and maxBytes
// bytes, only rows full replay returns, starting at a clean turn start (the first row after the
// previous turn's last assistant row), else "not-windowable". The oracle is the independent
// two-pass provider reader over the same files: a window must equal the tail of that full read
// from the same clean start.

const BIG = 1_000_000_000;
const row = (id: string, role: "user" | "assistant", metadata?: MuxMetadata) =>
  json(createMuxMessage(id, role, `text ${id}`, metadata));
const snapshot = (id: string) =>
  row(id, "user", { synthetic: true, fileAtMentionSnapshot: ["@a"] });
const boundary = (id: string) =>
  row(id, "assistant", { compactionBoundary: true, compacted: true, compactionEpoch: 1 });
const ids = (messages: MuxMessage[]) => messages.map((m) => m.id);

describe("HistoryService.getHistoryWindowFromLatestBoundary", () => {
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
  async function full(workspaceId: string): Promise<MuxMessage[]> {
    // The service read may rotate a legacy layout; the oracle then reads the same files.
    const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!result.success) throw new Error(result.error);
    return readProviderHistoryFromLatestBoundary(pathsFor(workspaceId), 0);
  }
  async function window(workspaceId: string, caps: HistoryWindowCaps) {
    const result = await h.historyService.getHistoryWindowFromLatestBoundary(workspaceId, caps);
    if (!result.success) throw new Error(result.error);
    return result.data;
  }
  /** Describes each broken contract point of a window against the full read (empty if valid). */
  function check(label: string, fullRead: MuxMessage[], messages: MuxMessage[], whole: boolean) {
    const start = fullRead.length - messages.length;
    if (start < 0 || !deepEqualAnyDepth(messages, fullRead.slice(start)))
      return [`${label}: not the tail of the full read`];
    if (whole) return start === 0 ? [] : [`${label}: epoch start reached but rows are missing`];
    const clean = start > 0 && fullRead[start].role === "user";
    return clean && fullRead[start - 1].role === "assistant" ? [] : [`${label}: unclean start`];
  }

  test("equals the full read's tail from a clean start on generated layouts", async () => {
    const problems: string[] = [];
    const seen = { whole: 0, trimmed: 0, fallback: 0 };
    for (let seed = 0; seed < 200; seed++) {
      const random = mulberry32(seed);
      const rows = generateRows(random, {
        oversized: seed % 20 === 0,
        adversarial: seed % 3 === 0,
      });
      const split = Math.floor(random() * (rows.length + 1));
      const workspaceId = `window-${seed}`;
      // Half the layouts span the archive, like an epoch that began before a rotation.
      if (seed % 2 === 0) await writeLayout(workspaceId, null, rows);
      else await writeLayout(workspaceId, rows.slice(0, split), rows.slice(split));
      const fullRead = await full(workspaceId);
      for (const maxRows of [1, 3, 10, 40, 1000]) {
        for (const maxBytes of [BIG, 4096, 2 * OVERSIZED]) {
          const result = await window(workspaceId, { maxRows, maxBytes });
          if (result.kind === "not-windowable") {
            seen.fallback++;
            continue;
          }
          if (result.messages.length > maxRows) problems.push(`seed ${seed}: over maxRows`);
          seen[result.reachedEpochStart ? "whole" : "trimmed"]++;
          const label = `seed ${seed} rows=${maxRows} bytes=${maxBytes}`;
          problems.push(...check(label, fullRead, result.messages, result.reachedEpochStart));
        }
      }
    }
    expect(problems).toEqual([]);
    // Every outcome is exercised, so the comparison is not vacuous.
    expect(Math.min(seen.whole, seen.trimmed, seen.fallback)).toBeGreaterThan(50);
  }, 120_000);

  test("keeps a snapshot cluster with its prompt and falls back when a turn is too long", async () => {
    const ws = "window-snapshots";
    await writeLayout(ws, null, [
      row("u0", "user"),
      row("a1", "assistant"),
      snapshot("s2"),
      snapshot("s3"),
      row("u4", "user"),
      row("a5", "assistant"),
      row("a6", "assistant"),
    ]);
    const fullRead = await full(ws);
    // Six rows reach a1, so the window starts at the snapshots of the u4 turn.
    const fits = await window(ws, { maxRows: 6, maxBytes: BIG });
    expect(fits.kind === "window" && ids(fits.messages)).toEqual(["s2", "s3", "u4", "a5", "a6"]);
    expect(fits.kind === "window" && check("fits", fullRead, fits.messages, false)).toEqual([]);
    // Five rows start inside that turn: trimming forward finds no clean start.
    expect(await window(ws, { maxRows: 5, maxBytes: BIG })).toEqual({ kind: "not-windowable" });
    const whole = await window(ws, { maxRows: 7, maxBytes: BIG });
    expect(whole).toEqual({ kind: "window", messages: fullRead, reachedEpochStart: true });
  });

  test("counts malformed and oversized rows toward the budget and projects them like full replay", async () => {
    const ws = "window-malformed";
    const big = json(createMuxMessage("a3", "assistant", "y".repeat(OVERSIZED)));
    const rows = [row("u0", "user"), row("a1", "assistant"), row("u2", "user"), big];
    await writeLayout(ws, null, [...rows, "{not json", row("a4", "assistant")]);
    const fullRead = await full(ws);
    // The malformed row takes one of the five rows; the oversized row is parsed and returned.
    const result = await window(ws, { maxRows: 5, maxBytes: BIG });
    expect(result.kind === "window" && ids(result.messages)).toEqual(["u2", "a3", "a4"]);
    expect(result.kind === "window" && check("rows", fullRead, result.messages, false)).toEqual([]);
    // The byte cap stops before the oversized row, leaving no clean start.
    const byBytes = await window(ws, { maxRows: BIG, maxBytes: OVERSIZED });
    expect(byBytes).toEqual({ kind: "not-windowable" });
    // A newest row larger than the cap leaves nothing to window.
    const giantWs = "window-giant-newest";
    await writeLayout(giantWs, null, rows);
    expect(await window(giantWs, { maxRows: BIG, maxBytes: OVERSIZED })).toEqual({
      kind: "not-windowable",
    });
  });

  test("spans the archive and returns a whole epoch from its boundary", async () => {
    const ws = "window-archive";
    const archive = [row("old", "user"), boundary("b0"), row("u1", "user"), row("a2", "assistant")];
    await writeLayout(
      ws,
      [...archive, row("u3", "user"), row("a4", "assistant")],
      [row("u5", "user"), row("a6", "assistant")]
    );
    const fullRead = await full(ws);
    const spanning = await window(ws, { maxRows: 5, maxBytes: BIG });
    expect(spanning.kind === "window" && ids(spanning.messages)).toEqual(["u3", "a4", "u5", "a6"]);
    const whole = await window(ws, { maxRows: 100, maxBytes: BIG });
    expect(whole).toEqual({ kind: "window", messages: fullRead, reachedEpochStart: true });
    expect(ids(fullRead)[0]).toBe("b0");
  });

  test("never retains a long malformed tail past the budget (#5220)", async () => {
    const ws = "window-malformed-tail";
    const run = 50_000;
    const broken = `{"broken": "${"z".repeat(90)}`;
    await writeLayout(ws, null, [
      row("u0", "user"),
      row("a1", "assistant"),
      ...Array.from({ length: run }, () => broken),
    ]);
    // Sample the live object count while the scan runs (it yields at every chunk read).
    Bun.gc(true);
    const before = heapStats().objectCount;
    let peak = before;
    let sampling = true;
    const sample = () => {
      Bun.gc(true);
      peak = Math.max(peak, heapStats().objectCount);
      if (sampling) setTimeout(sample, 10);
    };
    setTimeout(sample, 0);
    const result = await window(ws, { maxRows: 2000, maxBytes: BIG });
    sampling = false;
    // Every malformed row counts, so the budget holds no readable row at all.
    expect(result).toEqual({ kind: "not-windowable" });
    expect(peak - before).toBeLessThan(run / 5);
  }, 30_000);
});
