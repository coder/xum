import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { computeDiff } from "./diff";

const LINES = 25_000;
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
function diffLargeFiles(kind: "rewrite" | "one-line-edit"): { status: number | null; out: string } {
  const script = `${DIFF_MODULE_JS}
    const old = Array.from({ length: ${LINES} }, (_, i) => "old line " + i);
    const next = ${
      kind === "rewrite"
        ? `Array.from({ length: ${LINES} }, (_, i) => "new line " + i)`
        : `old.map((line, i) => (i === ${LINES / 2} ? "edited line" : line))`
    };
    const diff = computeDiff(old.join("\\n"), next.join("\\n"));
    process.stdout.write(JSON.stringify({ diff, rssMb: process.memoryUsage().rss / 2 ** 20 }));
  `;
  const child = spawnSync(
    "sh",
    [
      "-c",
      'ulimit -v 2621440 2>/dev/null; exec node --max-old-space-size=256 --input-type=module -e "$DIFF_SCRIPT"',
    ],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, DIFF_SCRIPT: script } }
  );
  return { status: child.status, out: child.stdout };
}

describe("computeDiff on large files", () => {
  test("a fully rewritten 25k-line file returns a short notice with bounded memory", () => {
    const { status, out } = diffLargeFiles("rewrite");
    expect(status).toBe(0);
    const { diff, rssMb } = JSON.parse(out) as { diff: string | null; rssMb: number };
    expect(diff).not.toBeNull();
    // A notice, not 50k diff lines.
    expect(diff!.length).toBeLessThan(500);
    expect(diff).not.toContain("@@");
    expect(rssMb).toBeLessThan(400);
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
