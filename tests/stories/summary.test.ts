import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkSeed, MAX_SEED_BYTES } from "../bugbash/sandbox/cacheSeed";
import { nextSeed, summarize } from "./summary";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "xum-story-summary-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (rel: string, data: unknown) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  return file;
};
const agentStep = (mode: string) => ({ kind: "agent", cache: { mode, replayedActions: 0 } });
/** The table row whose Test cell is `title`, split into cells. */
const row = (summary: string, title: string) =>
  summary
    .split("\n")
    .find((line) => line.split(" | ")[1] === title)
    ?.split(" | ")
    .map((c) => c.replace(/^\| | \|$/g, ""));
const entry = (n: number) => `${n.toString(16).padStart(64, "0")}.json`;

test("a row per selected test with its cache outcomes and model calls, then each job's spend", () => {
  const job = "tests/stories/.e2e/stories-20261019T100000Z-1";
  write(`${job}/report.json`, {
    run: {
      status: "failed",
      results: [
        {
          titlePath: ["smoke", "opens a workspace"],
          status: "passed",
          selected: true,
          attempts: [
            {
              durationMs: 1500,
              calls: 3,
              steps: [agentStep("self-finalized"), agentStep("missed"), { kind: "expect" }],
            },
          ],
        },
        {
          titlePath: ["restart", "keeps | trust"],
          status: "failed",
          selected: true,
          attempts: [
            { durationMs: 1000, calls: 4, steps: [agentStep("agent-concluded")] },
            { durationMs: 2000, calls: 5, steps: [agentStep("agent-concluded")] },
          ],
        },
        { titlePath: ["known", "bug"], status: "skipped", selected: false, attempts: [] },
      ],
    },
  });
  write(`${job}.spend.json`, { spentUsd: 0.2712, capUsd: 3, settled: 12, refused: 0 });
  write("tests/stories/.e2e/stories-preflight/report.json", { run: { results: [] } });
  const repros = "tests/bugbash/.e2e/agent-repros-20261019T100500Z-2";
  write(`${repros}/report.json`, { run: { status: "passed", results: [] } });
  write(`${repros}.spend.json`, {
    spentUsd: 3,
    capUsd: 3,
    settled: 9,
    refused: 2,
    refusedBy: { budget: 2 },
  });

  const summary = summarize(root);
  expect(row(summary, "smoke › opens a workspace")).toEqual([
    "`stories-20261019T100000Z-1`",
    "smoke › opens a workspace",
    "passed",
    "1.5 s",
    "1 / 0 / 1",
    "3",
  ]);
  // Every attempt counts: a retried test spent both attempts' time and calls.
  expect(row(summary, "restart › keeps \\| trust")?.slice(2)).toEqual([
    "failed (2 attempts)",
    "3.0 s",
    "0 / 2 / 0",
    "9",
  ]);
  // A test the selection left out did not run, and the preflight is not a job.
  expect(summary).not.toContain("known › bug");
  expect(summary).not.toContain("stories-preflight");
  expect(row(summary, "(no test selected)")?.[0]).toBe("`agent-repros-20261019T100500Z-2`");
  expect(summary).toContain(
    "- `stories-20261019T100000Z-1`: e2e failed. $0.27 spent of the $3.00 cap, 12 calls settled, 0 refused."
  );
  expect(summary).toContain(
    '- `agent-repros-20261019T100500Z-2`: e2e passed. $3.00 spent of the $3.00 cap, 9 calls settled, 2 refused {"budget":2}.'
  );
});

test("a missing, cut-off or foreign report prints a row that says so", () => {
  fs.mkdirSync(path.join(root, "tests/stories/.e2e/stories-20261019T100000Z-1"), {
    recursive: true,
  });
  write("tests/stories/.e2e/stories-20261019T100100Z-2/report.json", '{"run": {"results": [');
  write("tests/stories/.e2e/stories-20261019T100200Z-3/report.json", { schemaVersion: "x" });
  write("tests/stories/.e2e/stories-20261019T100300Z-4/report.json", {
    run: { results: [{ titlePath: ["half"], attempts: [{ steps: "?" }, null] }] },
  });

  const summary = summarize(root);
  expect(row(summary, "(report.json missing)")?.[0]).toBe("`stories-20261019T100000Z-1`");
  expect(row(summary, "(report.json not valid JSON (cut off?))")?.[0]).toBe(
    "`stories-20261019T100100Z-2`"
  );
  expect(row(summary, "(report.json has no run.results)")?.[0]).toBe(
    "`stories-20261019T100200Z-3`"
  );
  expect(row(summary, "half")?.slice(2)).toEqual(["unknown", "0.0 s", "0 / 0 / 0", "-"]);
  expect(summary).toContain("- `stories-20261019T100000Z-1`: no e2e status. spend.json missing.");
});

test("no job output says that make test-stories stopped before its first job", () => {
  expect(summarize(root)).toContain("stopped before its first job");
});

test("the next seed is the newest job's cache: valid entries only, at most 1000, newest kept", () => {
  const seed = path.join(root, "tests/stories/.e2e-cache-seed");
  write(`tests/stories/.e2e-cache-seed/${entry(99_999)}`, "old seed");
  const older = "tests/stories/.e2e/stories-20261018T100000Z-1/cache";
  write(`${older}/${entry(77_777)}`, "older job");
  const cache = "tests/stories/.e2e/stories-20261019T100000Z-2/cache";
  // 1002 entries, entry(i) recorded at second i: the two oldest (0 and 1) fall off the cap.
  for (let i = 0; i < 1002; i++) {
    const file = write(`${cache}/${entry(i)}`, `entry ${i}`);
    fs.utimesSync(file, new Date(), new Date(1_000_000 + i * 1000));
  }
  // What checkSeed refuses must not reach the seed: the next launch would refuse it all.
  write(`${cache}/notes.txt`, "x");
  write(`${cache}/${"b".repeat(64)}.json`, "x".repeat((1 << 20) + 1));
  fs.symlinkSync("/etc/passwd", path.join(root, cache, `${"c".repeat(64)}.json`));

  expect(nextSeed(root, seed)).toBe(1000);
  const names = fs.readdirSync(seed).sort();
  expect(names.length).toBe(1000);
  expect(names[0]).toBe(entry(2));
  expect(names.at(-1)).toBe(entry(1001));
  expect(fs.readFileSync(path.join(seed, entry(500)), "utf8")).toBe("entry 500");
  // Kept mtimes: the next run cuts the same entries again.
  expect(fs.statSync(path.join(seed, entry(2))).mtimeMs).toBe(1_002_000);
  expect(fs.readdirSync(path.dirname(seed)).sort()).toEqual([".e2e", ".e2e-cache-seed"]);
});

test("the next seed stops at the byte cap, newest first, so checkSeed accepts it", () => {
  const seed = path.join(root, "tests/stories/.e2e-cache-seed");
  const cache = "tests/stories/.e2e/stories-20261019T100000Z-2/cache";
  const size = 1 << 20; // the largest entry e2e reads
  const count = MAX_SEED_BYTES / size + 2;
  for (let i = 0; i < count; i++) {
    const file = write(`${cache}/${entry(i)}`, "x".repeat(size));
    fs.utimesSync(file, new Date(), new Date(1_000_000 + i * 1000));
  }
  expect(nextSeed(root, seed)).toBe(MAX_SEED_BYTES / size);
  expect(fs.readdirSync(seed).sort()[0]).toBe(entry(2)); // the two oldest fall off
  expect(checkSeed(seed, (reason) => new Error(reason)).length).toBe(MAX_SEED_BYTES / size);
});

test("with no recorded entry the seed stays as it was", () => {
  const seed = path.join(root, "tests/stories/.e2e-cache-seed");
  write(`tests/stories/.e2e-cache-seed/${entry(1)}`, "old seed");
  // A job that failed before e2e ran, and one whose cache holds nothing valid.
  fs.mkdirSync(path.join(root, "tests/stories/.e2e/stories-20261019T100000Z-1"), {
    recursive: true,
  });
  write("tests/stories/.e2e/stories-20261019T100100Z-2/cache/notes.txt", "x");

  expect(nextSeed(root, seed)).toBeNull();
  expect(fs.readdirSync(seed)).toEqual([entry(1)]);
  expect(fs.readFileSync(path.join(seed, entry(1)), "utf8")).toBe("old seed");
});
