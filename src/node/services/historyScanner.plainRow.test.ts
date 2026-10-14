import { describe, expect, spyOn, test } from "bun:test";
import { SESSION_HISTORY_RESET_NEEDLE } from "@/common/constants/contextBudget";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { isDurableContextBoundaryMarker } from "@/common/utils/messages/compactionBoundary";
import { isManualHistoryReset } from "@/common/utils/messages/contextWindows";
import * as normalizeModule from "@/node/utils/messages/normalizePersistedMessage";
import { classifyHistoryScanRow, hasRawResetMarker, readPlainHistoryRow } from "./historyScanner";
import {
  deepEqualAnyDepth,
  deepToolRow,
  generateRows,
  json,
  mixedResetEncoding,
  mulberry32,
  RESET_ENCODINGS,
  type GeneratedRow,
} from "./historyScanner.generator.testHarness";

// Unit property test of the provider locator's plain-row gate (#4655). The differential test
// compares whole locator runs with the frozen copy, but a gate that wrongly accepts a reset
// spelling changes the locator's result only for rows that are also unreadable or ambiguous, so
// it can hide behind the dense floors of those layouts. These properties pin the gate directly.
//
// Not covered: the startup check that disables the gate when a 1024-deep JSON.stringify throws.
// It is a module-load constant, so reaching the disabled branch needs a production-only switch or
// a patched global JSON.stringify leaking into the other test files of the process. A disabled
// gate returns null, which sends every row down the full path the declined rows below already take.

const freshProbe = () => ({ resetProbe: "", resetStage: 0 as const, possibleReset: false });

/** The row's bytes cut at up to two random points, in arrival (reverse file) order. */
function segmentsOf(bytes: Buffer, random: () => number): Buffer[] {
  const cuts = [random(), random()]
    .map((r) => Math.floor(r * (bytes.length + 1)))
    .sort((a, b) => a - b);
  return [bytes.subarray(cuts[1]), bytes.subarray(cuts[0], cuts[1]), bytes.subarray(0, cuts[0])];
}

function gate(row: GeneratedRow, random: () => number): MuxMessage | null {
  const bytes = Buffer.from(row);
  return readPlainHistoryRow(bytes.toString("utf8"), segmentsOf(bytes, random), bytes.length);
}

describe("readPlainHistoryRow", () => {
  test("returns only the full classifier's message, never a boundary or a reset", () => {
    const problems: string[] = [];
    let accepted = 0;
    let declined = 0;
    for (let seed = 1; seed <= 300 && problems.length < 20; seed++) {
      const random = mulberry32(seed);
      for (const row of generateRows(random, { oversized: false, adversarial: true })) {
        const text = Buffer.from(row).toString("utf8");
        // A duplicate top-level key makes the full path floor on any reset evidence it sees.
        const variants = text.endsWith("}") ? [row, `${text.slice(0, -1)},"id":"dup"}`] : [row];
        for (const variant of variants) {
          const plain = gate(variant, random);
          if (plain === null) {
            declined++;
            continue;
          }
          accepted++;
          const full = classifyHistoryScanRow(Buffer.from(variant).toString("utf8"), freshProbe());
          if (
            !deepEqualAnyDepth(plain, full) ||
            isDurableContextBoundaryMarker(plain) ||
            isManualHistoryReset(plain, false)
          )
            problems.push(`seed ${seed}: ${text.slice(0, 200)}`);
        }
      }
    }
    expect(problems).toEqual([]);
    // Both outcomes must be common, or the property holds vacuously.
    expect(accepted).toBeGreaterThan(1000);
    expect(declined).toBeGreaterThan(1000);
  });

  test("declines every reset spelling of the probe corpora, in any row shape", () => {
    const random = mulberry32(4655);
    // Raw separators from both halves of the shared class, inside the value's letters.
    const separated = ["\u007f", "\u0085", "\u2003", "\u00a0", "\ufeff"].map((character) =>
      SESSION_HISTORY_RESET_NEEDLE.replace("reset", `re${character}set`)
    );
    // Guards these additions: each is reset evidence to the full path's raw marker check.
    for (const encoding of separated) expect(hasRawResetMarker(encoding)).toBe(true);
    const mixed = Array.from({ length: 200 }, () => mixedResetEncoding(random));
    const problems: string[] = [];
    for (const encoding of [...RESET_ENCODINGS, ...separated, ...mixed]) {
      const shapes = [
        encoding,
        `junk ${encoding} junk`,
        `{"metadata":{${encoding}},broken`,
        `{"id":"c","role":"assistant","parts":[],"metadata":{${encoding}}}`,
        json(createMuxMessage("c", "user", `about ${encoding}`)),
        json(createMuxMessage("c", "user", "note", { note: encoding } as MuxMessage["metadata"])),
      ];
      for (const shape of shapes)
        if (gate(shape, random) !== null) problems.push(JSON.stringify(shape));
    }
    expect(problems).toEqual([]);
  });

  // V8 on the Node main thread throws in JSON.stringify around depth 3-5k, which the full path
  // treats as reset evidence; Bun throws far deeper, so the property above cannot witness it.
  test("declines rows nested beyond the stringify-safe depth, however the row is split", () => {
    const random = mulberry32(1);
    const objects = json(createMuxMessage("o", "user", "x")).replace(
      '"parts":[',
      `"deep":${'{"a":'.repeat(1100)}0${"}".repeat(1100)},"parts":[`
    );
    for (const row of [deepToolRow("arrays", 1100, false, false), objects]) {
      expect(classifyHistoryScanRow(row, freshProbe())).not.toBeNull();
      for (let i = 0; i < 20; i++) expect(gate(row, random)).toBeNull();
    }
  });

  test("treats a normalize failure as unreadable, like the full path", () => {
    const row = json(createMuxMessage("n", "user", "plain"));
    expect(gate(row, Math.random)).not.toBeNull();
    const normalize = spyOn(normalizeModule, "normalizePersistedMessage").mockImplementation(() => {
      throw new Error("normalize failed");
    });
    try {
      expect(classifyHistoryScanRow(row, freshProbe())).toBeNull();
      expect(gate(row, Math.random)).toBeNull();
    } finally {
      normalize.mockRestore();
    }
  });
});
