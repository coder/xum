import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SESSION_HISTORY_SCAN_CHUNK_BYTES } from "@/common/constants/contextBudget";
import { findProviderHistoryStart } from "./historyScanner";
import { createMuxMessage } from "@/common/types/message";
import {
  deepEqualAnyDepth,
  deepToolRow,
  generateRows,
  json,
  mulberry32,
  rowsToBytes,
  type GeneratedRow,
} from "./historyScanner.generator.testHarness";
import { referenceFindProviderHistoryStart } from "./historyScanner.referenceLocator.testHarness";

// Differential oracle for the provider history locator (#4655). A planned fast path lets rows
// that provably carry no reset or boundary evidence skip the reset probes; the locator guards
// provider privacy (#4555 raw reset floors, #4421 compaction boundaries, escaped markers), so
// any divergence from the frozen copy on these adversarial layouts is a bug in that change.
// Until the fast path lands, production equals the copy and this passes trivially; its value is
// shown by mutating the production locator and watching this test fail.

type Locate = typeof findProviderHistoryStart;
// Derived from the signature so historyScanner.ts exports only the locator itself.
type ProviderHistoryStart = Awaited<ReturnType<Locate>>;
type ScannedHistoryRow = Parameters<NonNullable<Parameters<Locate>[4]>>[0];
interface Observation {
  result: ProviderHistoryStart | { error: string };
  rows: ScannedHistoryRow[];
}

const SEEDS = 500;
const TRUNCATIONS = 2;

async function observe(
  locate: Locate,
  handle: fs.FileHandle,
  size: number,
  skip: number,
  includeReadableResetFloor: boolean,
  stopAfterReadable: number | null
): Promise<Observation> {
  const rows: ScannedHistoryRow[] = [];
  let readable = 0;
  try {
    const result = await locate(handle, size, skip, includeReadableResetFloor, (row) => {
      rows.push(row);
      if (row.message !== null) readable++;
      // The suffix reader's rule (readProviderHistorySuffix): once requested, the stop stays
      // requested; the locator honors it only after a safe readable row.
      return stopAfterReadable !== null && readable >= stopAfterReadable;
    });
    return { result, rows };
  } catch (error) {
    return { result: { error: String(error) }, rows };
  }
}

/** The first difference between two observations, or null when they match. */
function difference(production: Observation, reference: Observation): string | null {
  if (!Bun.deepEquals(production.result, reference.result, true))
    return `result ${JSON.stringify(production.result)} != ${JSON.stringify(reference.result)}`;
  const count = Math.max(production.rows.length, reference.rows.length);
  for (let i = 0; i < count; i++) {
    const p = production.rows.at(i);
    const r = reference.rows.at(i);
    if (
      p?.start !== r?.start ||
      p?.size !== r?.size ||
      !deepEqualAnyDepth(p?.message ?? null, r?.message ?? null)
    )
      return `visited row ${i}: ${p ? `${p.start}+${p.size}` : "none"} vs ${r ? `${r.start}+${r.size}` : "none"}`;
  }
  return null;
}

describe("findProviderHistoryStart differential oracle", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-locator-differential-"));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("matches the frozen locator on adversarial layouts", async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= SEEDS && problems.length < 20; seed++) {
      const random = mulberry32(seed);
      const rows = generateRows(random, { oversized: seed % 50 === 0, adversarial: true });
      const layout = random();
      const split = Math.floor(random() * (rows.length + 1));
      const files: Array<[string, GeneratedRow[]]> =
        layout < 0.3
          ? [["chat", rows]]
          : layout < 0.5
            ? [["archive", rows]]
            : [
                ["archive", rows.slice(0, split)],
                ["chat", rows.slice(split)],
              ];
      for (const [name, fileRows] of files) {
        const file = path.join(dir, `${seed}-${name}.jsonl`);
        await fs.writeFile(file, rowsToBytes(fileRows));
        await using handle = await fs.open(file, "r");
        const { size } = await handle.stat();
        // Resets are dense in these layouts, so a scan from the end stops after a few rows.
        // Also locate from earlier row ends (the locator reads only [0, fileSize)) so older rows
        // get visited too.
        const rowEnds: number[] = [];
        for (let i = 0, end = 0; i < fileRows.length; i++)
          rowEnds.push((end += Buffer.byteLength(fileRows[i]) + 1));
        const ends = [size];
        for (let k = 0; k < TRUNCATIONS && rowEnds.length > 0; k++)
          ends.push(rowEnds[Math.floor(random() * rowEnds.length)]);
        // A streaming crash can leave an unterminated final row: end one scan on the last row's
        // bytes without its newline, and one partway through a random row, so the locator's EOF
        // delivery path sees complete and truncated JSON.
        if (size > 1) ends.push(size - 1);
        if (rowEnds.length > 0) {
          const row = Math.floor(random() * rowEnds.length);
          const rowStart = row === 0 ? 0 : rowEnds[row - 1];
          const rowLength = rowEnds[row] - 1 - rowStart;
          if (rowLength > 1) ends.push(rowStart + 1 + Math.floor(random() * (rowLength - 1)));
        }
        const cases: Array<[number, number, boolean, number | null]> = [];
        for (const end of ends) {
          for (const skip of [0, 1, 2])
            for (const floor of [false, true]) cases.push([end, skip, floor, null]);
          for (const floor of [false, true])
            for (const stop of [1, 3]) cases.push([end, 0, floor, stop]);
        }
        // Large rows are rare and slow: end one scan right after one of them so it is visited
        // first, with one recording scan per floor setting.
        const large = rowEnds.filter(
          (_, i) => Buffer.byteLength(fileRows[i]) > SESSION_HISTORY_SCAN_CHUNK_BYTES
        );
        if (large.length > 0) {
          const end = large[Math.floor(random() * large.length)];
          for (const floor of [false, true]) cases.push([end, 0, floor, null]);
        }
        for (const [end, skip, floor, stop] of cases) {
          const production = await observe(
            findProviderHistoryStart,
            handle,
            end,
            skip,
            floor,
            stop
          );
          const reference = await observe(
            referenceFindProviderHistoryStart,
            handle,
            end,
            skip,
            floor,
            stop
          );
          const problem = difference(production, reference);
          if (problem)
            problems.push(
              `seed ${seed} ${name} end=${end} skip=${skip} floor=${floor} stop=${stop ?? "none"}: ${problem}`
            );
        }
        await fs.rm(file);
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);

  // Bun's JSON.stringify throws only far deeper than V8's (~5k in production), and each throw
  // costs ~0.6 s, so the seeded layouts stay below it and this one layout covers the classifier's
  // stringify-throw path: newest first, a deep readable row stays readable, and the same row with a
  // duplicate top-level key is ambiguous reset evidence, so it floors the read.
  test("matches the frozen locator where JSON.stringify throws", async () => {
    const readable = (id: string) => json(createMuxMessage(id, "user", id));
    const file = path.join(dir, "deep.jsonl");
    await fs.writeFile(
      file,
      rowsToBytes([
        readable("a"),
        deepToolRow("dup", 100_000, false, true),
        readable("b"),
        deepToolRow("deep", 100_000, false, false),
        readable("c"),
      ])
    );
    await using handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const production = await observe(findProviderHistoryStart, handle, size, 0, false, null);
    const reference = await observe(
      referenceFindProviderHistoryStart,
      handle,
      size,
      0,
      false,
      null
    );
    expect(reference.result).toMatchObject({
      kind: "start",
      boundary: { kind: "unreadable-reset" },
    });
    expect(reference.rows.map((row) => row.message?.id ?? null)).toEqual(["c", "deep", "b", null]);
    expect(difference(production, reference)).toBeNull();
  }, 30_000);
});
