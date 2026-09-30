import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
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
import {
  readProviderHistoryFromLatestBoundary,
  readProviderHistoryPage,
  readProviderHistoryWindow,
  type HistoryWindowCaps,
} from "./historyScanner";

// In-epoch pages for a windowed client (#4961). Contract: a page is at most maxRows rows and
// maxBytes bytes, ends right before the cursor row, starts at a clean turn start (or the epoch
// start), and holds only rows full replay returns; otherwise "not-pageable". The oracle is the
// independent two-pass provider reader: the window plus every page before it, concatenated, must
// equal the full read.

const BIG = 1_000_000_000;
const row = (id: string, role: "user" | "assistant", seq: unknown, metadata?: MuxMetadata) =>
  json(
    createMuxMessage(id, role, `text ${id}`, { ...metadata, historySequence: seq } as MuxMetadata)
  );
const snapshot = (id: string, seq: number) =>
  row(id, "user", seq, { synthetic: true, fileAtMentionSnapshot: ["@a"] });
const ids = (messages: MuxMessage[]) => messages.map((m) => m.id);

/** Generated rows with sequences in file order and snapshot rows before some prompts. */
function sequencedRows(seed: number): GeneratedRow[] {
  const random = mulberry32(seed);
  const rows = generateRows(random, { oversized: seed % 20 === 0, adversarial: seed % 3 === 0 });
  const out: GeneratedRow[] = [];
  let seq = 0;
  for (const raw of rows) {
    let value: unknown;
    try {
      value = JSON.parse(raw.toString());
    } catch {
      out.push(raw);
      continue;
    }
    const message = value as MuxMessage | null;
    if (!message || typeof message !== "object" || typeof message.id !== "string") {
      out.push(raw);
      continue;
    }
    if (message.role === "user" && random() < 0.3) out.push(snapshot(`${message.id}-s`, seq++));
    out.push(
      JSON.stringify({ ...message, metadata: { ...message.metadata, historySequence: seq++ } })
    );
  }
  return out;
}

describe("readProviderHistoryPage", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-page-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  let layouts = 0;
  async function writeLayout(archive: GeneratedRow[] | null, chat: GeneratedRow[]) {
    const base = path.join(dir, `l${layouts++}`);
    await fs.mkdir(base);
    const paths = {
      chat: path.join(base, "chat.jsonl"),
      archive: path.join(base, "archive.jsonl"),
    };
    if (archive) await fs.writeFile(paths.archive, rowsToBytes(archive));
    await fs.writeFile(paths.chat, rowsToBytes(chat));
    return paths;
  }

  test("the window plus every page before it equals the full read", async () => {
    const problems: string[] = [];
    const seen = { complete: 0, pages: 0, notPageable: 0 };
    for (let seed = 0; seed < 200; seed++) {
      const rows = sequencedRows(seed);
      const split = Math.floor(mulberry32(seed + 7)() * (rows.length + 1));
      // Half the layouts span the archive, like an epoch that began before a rotation.
      const paths =
        seed % 2 === 0
          ? await writeLayout(null, rows)
          : await writeLayout(rows.slice(0, split), rows.slice(split));
      const fullRead = await readProviderHistoryFromLatestBoundary(paths, 0);
      for (const caps of [
        { maxRows: 3, maxBytes: BIG },
        { maxRows: 10, maxBytes: 4096 },
        { maxRows: 40, maxBytes: 2 * OVERSIZED },
      ] satisfies HistoryWindowCaps[]) {
        const label = `seed ${seed} rows=${caps.maxRows} bytes=${caps.maxBytes}`;
        const window = await readProviderHistoryWindow(paths, caps);
        if (window.kind !== "window" || window.reachedEpochStart) continue;
        let loaded = window.messages;
        for (;;) {
          const cursor = loaded[0].metadata?.historySequence;
          if (typeof cursor !== "number") break;
          const page = await readProviderHistoryPage(paths, caps, cursor);
          if (page.kind === "not-pageable") {
            seen.notPageable++;
            loaded = [];
            break;
          }
          if (page.kind === "before-epoch") break;
          seen.pages++;
          if (page.messages.length > caps.maxRows) problems.push(`${label}: page over maxRows`);
          const start = fullRead.length - loaded.length - page.messages.length;
          const clean =
            page.reachedEpochStart ||
            (start > 0 &&
              fullRead[start].role === "user" &&
              fullRead[start - 1].role === "assistant");
          if (!clean) problems.push(`${label}: page starts mid-turn`);
          loaded = [...page.messages, ...loaded];
          if (page.reachedEpochStart) break;
        }
        if (loaded.length === 0) continue;
        seen.complete++;
        if (!deepEqualAnyDepth(loaded, fullRead)) problems.push(`${label}: pages != full read`);
      }
    }
    expect(problems).toEqual([]);
    // Both outcomes occur, so the comparison is not vacuous.
    expect(Math.min(seen.complete, seen.pages, seen.notPageable)).toBeGreaterThan(20);
  }, 120_000);

  test("a page ends before the cursor, starts at a clean turn and keeps snapshots with prompts", async () => {
    const paths = await writeLayout(null, [
      row("u0", "user", 0),
      row("a1", "assistant", 1),
      snapshot("s2", 2),
      row("u3", "user", 3),
      row("a4", "assistant", 4),
      row("u5", "user", 5),
      row("a6", "assistant", 6),
    ]);
    const page = await readProviderHistoryPage(paths, { maxRows: 4, maxBytes: BIG }, 5);
    expect(page.kind === "page" && ids(page.messages)).toEqual(["s2", "u3", "a4"]);
    expect(page.kind === "page" && page.reachedEpochStart).toBe(false);
    const rest = await readProviderHistoryPage(paths, { maxRows: 4, maxBytes: BIG }, 2);
    expect(rest.kind === "page" && rest.reachedEpochStart).toBe(true);
    expect(rest.kind === "page" && ids(rest.messages)).toEqual(["u0", "a1"]);
    // No active-epoch row precedes the epoch's first row (or an older cursor).
    expect(await readProviderHistoryPage(paths, { maxRows: 4, maxBytes: BIG }, 0)).toEqual({
      kind: "before-epoch",
    });
  });

  test("each fallback returns not-pageable", async () => {
    const caps = { maxRows: 100, maxBytes: BIG };
    const base = [row("u0", "user", 0), row("a1", "assistant", 1), row("u2", "user", 2)];
    // The cursor row is missing (deleted while the client held it).
    const missing = await writeLayout(null, [...base, row("u4", "user", 4)]);
    expect(await readProviderHistoryPage(missing, caps, 3)).toEqual({ kind: "not-pageable" });
    // The cursor sequence is duplicated.
    const duplicated = await writeLayout(null, [
      ...base,
      row("x2", "user", 2),
      row("a3", "assistant", 3),
    ]);
    expect(await readProviderHistoryPage(duplicated, caps, 2)).toEqual({ kind: "not-pageable" });
    // A readable row in the scanned range has no numeric sequence.
    const unsequenced = await writeLayout(null, [
      ...base,
      row("n", "assistant", "7"),
      row("u3", "user", 3),
    ]);
    expect(await readProviderHistoryPage(unsequenced, caps, 3)).toEqual({ kind: "not-pageable" });
    // No clean turn start fits the budget: one turn is longer than the page.
    const longTurn = await writeLayout(null, [
      row("u0", "user", 0),
      ...Array.from({ length: 5 }, (_, i) => row(`a${i + 1}`, "assistant", i + 1)),
      row("u6", "user", 6),
    ]);
    expect(await readProviderHistoryPage(longTurn, { maxRows: 3, maxBytes: BIG }, 6)).toEqual({
      kind: "not-pageable",
    });
  });

  test("malformed and oversized rows count toward the page budget", async () => {
    const big = json(
      createMuxMessage("a3", "assistant", "y".repeat(OVERSIZED), { historySequence: 3 })
    );
    const paths = await writeLayout(null, [
      row("u0", "user", 0),
      row("a1", "assistant", 1),
      row("u2", "user", 2),
      big,
      "{not json",
      row("u4", "user", 4),
    ]);
    const fullRead = await readProviderHistoryFromLatestBoundary(paths, 0);
    // Four rows before u4 (the malformed one included) reach a1: the page starts at u2.
    const page = await readProviderHistoryPage(paths, { maxRows: 4, maxBytes: BIG }, 4);
    expect(page.kind === "page" && ids(page.messages)).toEqual(["u2", "a3"]);
    expect(page.kind === "page" && deepEqualAnyDepth(page.messages, fullRead.slice(2, 4))).toBe(
      true
    );
    // The byte cap stops before the oversized row: no clean start fits.
    expect(await readProviderHistoryPage(paths, { maxRows: BIG, maxBytes: OVERSIZED }, 4)).toEqual({
      kind: "not-pageable",
    });
  });
});
