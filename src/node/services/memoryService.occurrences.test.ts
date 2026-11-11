import { describe, expect, it } from "bun:test";

import { computeStrReplaceUpdate, findOccurrenceOffsets, lineNumbersOf } from "./memoryService";

// The two helpers that str_replace used before the linear matcher, copied as they were on main
// (3cd7f5ce8). They are the oracle: slow on purpose, and plainly right.
function referenceCount(content: string, needle: string): number {
  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(needle, index + 1);
  }
  return count;
}

function referenceLines(content: string, needle: string): number[] {
  const lines = new Set<number>();
  let index = content.indexOf(needle);
  while (index !== -1) {
    lines.add(content.slice(0, index).split("\n").length);
    index = content.indexOf(needle, index + 1);
  }
  return [...lines];
}

/** The offsets and lines that the linear matcher gives, for comparing with the oracle. */
function matchLines(content: string, needle: string): { count: number; lines: number[] } {
  const offsets = findOccurrenceOffsets(content, needle);
  return { count: offsets.length, lines: lineNumbersOf(content, offsets) };
}

describe("findOccurrenceOffsets", () => {
  it.each([
    ["a single occurrence", "alpha beta gamma", "beta", [6]],
    ["no occurrence", "alpha", "missing", []],
    ["an occurrence that is the whole content", "abc", "abc", [0]],
    ["a needle longer than the content", "abc", "abcd", []],
    ["an empty content", "", "a", []],
    ["occurrences that overlap by one unit", "aaaa", "aa", [0, 1, 2]],
    ["a periodic needle that overlaps itself", "abababab", "abab", [0, 2, 4]],
    ["a border shorter than the period", "aabaabaaab", "aabaaab", [3]],
    ["a long run of one letter", "a".repeat(8), "a".repeat(5), [0, 1, 2, 3]],
    ["a needle that holds a newline", "x\ny\nx\ny", "\ny", [1, 5]],
    ["code units of a surrogate pair", "\u{1F642}\u{1F642}", "\uD83D", [0, 2]],
  ])("finds %s", (_label, content, needle, expected) => {
    expect(findOccurrenceOffsets(content, needle)).toEqual(expected);
  });

  // An empty needle would match at every offset, and the callers refuse it first.
  it("refuses an empty needle", () => {
    expect(() => findOccurrenceOffsets("abc", "")).toThrow("needle must not be empty");
    expect(() => findOccurrenceOffsets("", "")).toThrow("needle must not be empty");
  });
});

describe("lineNumbersOf", () => {
  it.each<[string, string, number[], number[]]>([
    ["no offsets", "a\nb", [], []],
    ["offsets on one line", "ab ab\nzz", [0, 3], [1]],
    ["offsets on several lines", "a\nb\na\nb", [0, 4], [1, 3]],
    ["blank lines before an offset", "\n\nfoo\n\nfoo\n", [2, 7], [3, 5]],
    ["an offset at a newline", "x\ny\nx\ny", [1, 5], [1, 3]],
    ["an offset after the last newline", "a\nb", [2], [2]],
    ["CRLF line endings", "a\r\nb\r\na", [0, 6], [1, 3]],
    ["offsets that all sit on a later line", "x\nab ab ab\nzz", [2, 5, 8], [2]],
    ["a first line, then two offsets on the next", "ab\nab ab", [0, 3, 6], [1, 2]],
    ["offsets on a run of newlines", "x\n\n\n", [1, 2, 3], [1, 2, 3]],
  ])("numbers the lines of %s", (_label, content, offsets, expected) => {
    expect(lineNumbersOf(content, offsets)).toEqual(expected);
  });
});

// A small seeded generator (mulberry32): the same cases on every run, so a failure can be replayed.
// Not a linear congruential one, whose low bits cycle with a tiny period under `% 2` and `% 4`.
function seededBelow(seed: number): (bound: number) => number {
  let state = seed;
  return (bound) => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) % bound;
  };
}

describe("the linear matcher against main's helpers", () => {
  // Alphabets that make overlaps, periods and borders likely: two letters, newlines, CRLF, and
  // surrogate halves, since the oracle and the matcher both read UTF-16 code units.
  const ALPHABETS = [
    ["a", "b"],
    ["a", "b", "\n"],
    ["a", "\r\n", "\n"],
    ["ab", "a", "\n"],
    ["\u{1F642}", "a"],
    // mostly one letter, so long runs and long overlapping matches are common
    ["a", "a", "a", "a", "b"],
    ["a", "a", "a", "\n"],
  ];

  it("gives the same count and lines for 6,000 random contents and needles", () => {
    const below = seededBelow(20260511);
    const disagreements: unknown[] = [];
    for (let round = 0; round < 6_000; round++) {
      const alphabet = ALPHABETS[below(ALPHABETS.length)];
      const piece = () => alphabet[below(alphabet.length)];
      const content = Array.from({ length: below(80) }, piece).join("");
      let needle: string;
      switch (below(4)) {
        case 0: // a short random needle
          needle = Array.from({ length: 1 + below(8) }, piece).join("");
          break;
        case 1: {
          // a slice of the content, so matches exist (it can cut a surrogate pair in half)
          const start = below(content.length + 1);
          needle = content.slice(start, start + 1 + below(30));
          break;
        }
        case 2: // a repeated unit with an optional tail: long, periodic and overlapping
          needle = piece().repeat(1 + below(12)) + (below(2) === 0 ? "" : piece());
          break;
        default: // as long as the content, or longer
          needle = content + (below(2) === 0 ? "" : piece());
      }
      if (needle === "") continue;
      const got = matchLines(content, needle);
      const want = {
        count: referenceCount(content, needle),
        lines: referenceLines(content, needle),
      };
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        disagreements.push({ content, needle, got, want });
      }
      // The offsets are exactly the occurrences: ascending, each a real match, and as many as counted.
      const offsets = findOccurrenceOffsets(content, needle);
      const real = offsets.every(
        (offset, i) => content.startsWith(needle, offset) && (i === 0 || offset > offsets[i - 1])
      );
      if (!real) disagreements.push({ content, needle, offsets });
    }
    expect(disagreements.slice(0, 3)).toEqual([]);
  });
});

// Memory content and old_str are untrusted model input, and a failed str_replace must cost CPU time
// linear in the file however many matches it has and however long and overlapping old_str is.
// Each shape below took seconds on main (0.8 to 1.7 s per pass for the long overlapping ones, which
// Codex measured at 3.4 s for the first on #8124, and 3 to 14 s for the one-letter ones). The same
// call takes a few milliseconds now. A per-match newline search on the one-line shape takes about
// 140 ms. The budget is CPU time of the pure function (the same call the write path makes, with no
// lock, stat or file read around it), so a loaded host does not stretch it, and it sits between those.
describe("computeStrReplaceUpdate on a file at the size cap", () => {
  const KIB = 1024;
  const CPU_BUDGET_MS = 50;

  function cpuMilliseconds(run: () => void): number {
    const before = process.cpuUsage();
    run();
    const used = process.cpuUsage(before);
    return (used.user + used.system) / 1000;
  }

  it.each([
    [
      "a run of 100 KiB with a 50 KiB run",
      "a".repeat(100 * KIB),
      "a".repeat(50 * KIB),
      50 * KIB + 1,
    ],
    [
      "a run of 100 KiB with a 25 KiB run",
      "a".repeat(100 * KIB),
      "a".repeat(25 * KIB),
      75 * KIB + 1,
    ],
    ["a run of 100 KiB with one letter, all on one line", "a".repeat(100 * KIB), "a", 100 * KIB],
    ["50 KiB of lines with one letter, one match per line", "a\n".repeat(50 * KIB), "a", 50 * KIB],
    [
      "100 KiB of pairs with a 50 KiB run of pairs",
      "ab".repeat(50 * KIB),
      "ab".repeat(25 * KIB),
      25 * KIB + 1,
    ],
    [
      "100 KiB of lines with a 50 KiB run of lines",
      "a\n".repeat(50 * KIB),
      "a\n".repeat(25 * KIB),
      25 * KIB + 1,
    ],
  ])("refuses %s in linear CPU time", (_label, content, oldStr, count) => {
    const refusal = { message: "" };
    const refuse = () => {
      try {
        computeStrReplaceUpdate(content, oldStr, "x", "/memories/global/s.md");
      } catch (error) {
        refusal.message = error instanceof Error ? error.message : String(error);
      }
    };
    refuse(); // the first run warms the JIT, so the timed ones measure the steady state
    // The best of up to three runs: a GC thread can add a few milliseconds to one run, and a
    // quadratic scan is slow in every run.
    let cpuMs = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3 && cpuMs >= CPU_BUDGET_MS; attempt++) {
      cpuMs = Math.min(cpuMs, cpuMilliseconds(refuse));
    }

    expect(refusal.message).toContain(`old_str matches ${count} locations (lines 1`);
    expect(cpuMs).toBeLessThan(CPU_BUDGET_MS);
  });
});
