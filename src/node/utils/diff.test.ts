import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { computeDiff } from "./diff";

const LINES = 25_000;
/** Two edited lines 10k lines apart in the LINES-line file. */
const FAR_EDITS = [7_500, 17_500] as const;
// The module as plain JavaScript, so the child needs no type stripping (its Wasm reserves
// more address space than the cap below allows).
const DIFF_MODULE_JS = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(path.join(import.meta.dir, "diff.ts"), "utf8")
);

/**
 * Run computeDiff on two LINES-line files in a Node child with a 256 MB heap and (on Linux)
 * 2.5 GB of address space. A diff whose memory grows with lines x lines (the old full LCS
 * table: ~4 GB for 22.5k lines, which hit the live server's 8 GB heap limit) then fails fast
 * in the child instead of allocating gigabytes next to everything else on the machine.
 */
function diffLargeFiles(kind: "rewrite" | "one-line-edit" | "two-far-edits"): {
  status: number | null;
  out: string;
} {
  const script = `${DIFF_MODULE_JS}
    const old = Array.from({ length: ${LINES} }, (_, i) => "old line " + i);
    const next = ${
      kind === "rewrite"
        ? `Array.from({ length: ${LINES} }, (_, i) => "new line " + i)`
        : kind === "one-line-edit"
          ? `old.map((line, i) => (i === ${LINES / 2} ? "edited line" : line))`
          : `old.map((line, i) => (i === ${FAR_EDITS[0]} || i === ${FAR_EDITS[1]} ? "edited line" : line))`
    };
    const started = performance.now();
    const diff = computeDiff(old.join("\\n"), next.join("\\n"));
    const ms = performance.now() - started;
    process.stdout.write(JSON.stringify({ diff, ms, rssMb: process.memoryUsage().rss / 2 ** 20 }));
  `;
  const options = { encoding: "utf8", timeout: 60_000 } as const;
  // Windows has no POSIX shell or ulimit: there only the heap cap applies.
  const child =
    process.platform === "win32"
      ? spawnSync(
          "node",
          ["--max-old-space-size=256", "--input-type=module", "-e", script],
          options
        )
      : spawnSync(
          "sh",
          [
            "-c",
            'ulimit -v 2621440 2>/dev/null; exec node --max-old-space-size=256 --input-type=module -e "$DIFF_SCRIPT"',
          ],
          { ...options, env: { ...process.env, DIFF_SCRIPT: script } }
        );
  return { status: child.status, out: child.stdout };
}

describe("computeDiff on large files", () => {
  test("a fully rewritten 25k-line file returns a short notice with bounded memory", () => {
    const { status, out } = diffLargeFiles("rewrite");
    expect(status).toBe(0);
    const { diff, ms, rssMb } = JSON.parse(out) as {
      diff: string | null;
      ms: number;
      rssMb: number;
    };
    expect(diff).not.toBeNull();
    // A notice, not 50k diff lines.
    expect(diff!.length).toBeLessThan(500);
    expect(diff).not.toContain("@@");
    expect(rssMb).toBeLessThan(400);
    // It runs on the send path: the search gives up early, it does not run to the end.
    expect(ms).toBeLessThan(2_000);
  });

  test("one edited line in a 25k-line file still gets its hunk with 3 lines of context", () => {
    const { status, out } = diffLargeFiles("one-line-edit");
    expect(status).toBe(0);
    const { diff } = JSON.parse(out) as { diff: string | null };
    const mid = LINES / 2;
    expect(diff).toBe(
      [
        `@@ -${mid - 2},7 +${mid - 2},7 @@`,
        ` old line ${mid - 3}`,
        ` old line ${mid - 2}`,
        ` old line ${mid - 1}`,
        `-old line ${mid}`,
        `+edited line`,
        ` old line ${mid + 1}`,
        ` old line ${mid + 2}`,
        ` old line ${mid + 3}`,
      ].join("\n")
    );
  });
});

describe("computeDiff", () => {
  test("two edits 10k lines apart in a 25k-line file get two hunks", () => {
    const { status, out } = diffLargeFiles("two-far-edits");
    expect(status).toBe(0);
    const { diff } = JSON.parse(out) as { diff: string | null };
    const hunk = (at: number) => [
      `@@ -${at - 2},7 +${at - 2},7 @@`,
      ` old line ${at - 3}`,
      ` old line ${at - 2}`,
      ` old line ${at - 1}`,
      `-old line ${at}`,
      `+edited line`,
      ` old line ${at + 1}`,
      ` old line ${at + 2}`,
      ` old line ${at + 3}`,
    ];
    expect(diff).toBe([...hunk(FAR_EDITS[0]), ...hunk(FAR_EDITS[1])].join("\n"));
  });

  // Two edits far apart in a 3000-line file: the table spans the whole middle between them
  // (about 9M cells, which main diffed too), so it must fit the budget.
  const isNotice = (diff: string | null) => diff?.startsWith("(diff omitted") === true;

  test("a change past the edit-distance limit returns the notice", () => {
    // 2100 substituted lines: 4200 lines removed plus added, past MAX_EDIT_DISTANCE.
    const old = Array.from({ length: LINES }, (_, i) => `l${i}`);
    const next = old.map((line, i) => (i % 11 === 5 && i < 2100 * 11 ? `e${i}` : line));
    expect(isNotice(computeDiff(old.join("\n"), next.join("\n")))).toBe(true);
  });

  test("a search past the step limit returns the notice", () => {
    // Few distinct lines make long equal runs on every diagonal, so the search costs far more
    // steps than the edit distance alone suggests.
    const old = Array.from({ length: LINES }, (_, i) => `r${i % 3}`);
    const next = [...old];
    let seed = 5;
    for (let edit = 0; edit < 1900; edit++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      next[Math.floor((seed / 2 ** 31) * LINES)] = `e${edit % 2}`;
    }
    expect(isNotice(computeDiff(old.join("\n"), next.join("\n")))).toBe(true);
  });

  test("edits near both ends of a 3000-line file still get two hunks", () => {
    const old = Array.from({ length: 3000 }, (_, i) => `l${i}`);
    const next = [...old];
    next[1] = "a";
    next[2998] = "b";
    expect(computeDiff(old.join("\n"), next.join("\n"))).toBe(
      [
        "@@ -1,5 +1,5 @@",
        " l0",
        "-l1",
        "+a",
        " l2",
        " l3",
        " l4",
        "@@ -2996,5 +2996,5 @@",
        " l2995",
        " l2996",
        " l2997",
        "-l2998",
        "+b",
        " l2999",
      ].join("\n")
    );
  });

  test("separate changes keep separate hunks, and nearby ones merge", () => {
    const old = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const next = [...old];
    next[2] = "a";
    next[20] = "b";
    next[24] = "c";
    expect(computeDiff(old.join("\n"), next.join("\n"))).toBe(
      [
        "@@ -1,6 +1,6 @@",
        " l0",
        " l1",
        "-l2",
        "+a",
        " l3",
        " l4",
        " l5",
        "@@ -18,11 +18,11 @@",
        " l17",
        " l18",
        " l19",
        "-l20",
        "+b",
        " l21",
        " l22",
        " l23",
        "-l24",
        "+c",
        " l25",
        " l26",
        " l27",
      ].join("\n")
    );
  });
});
