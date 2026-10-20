import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkSeed, MAX_SEED_BYTES } from "../bugbash/sandbox/cacheSeed";
import { nextSeed, summarize, upstreamFault } from "./summary";

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
const agentStep = (mode: string, calls = 0) => ({
  kind: "agent",
  cache: { mode, replayedActions: 0 },
  model: { calls },
});
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
              steps: [agentStep("self-finalized"), agentStep("missed", 3), { kind: "expect" }],
            },
          ],
        },
        {
          titlePath: ["restart", "keeps | trust"],
          status: "failed",
          selected: true,
          attempts: [
            { durationMs: 1000, steps: [agentStep("agent-concluded", 4)] },
            { durationMs: 2000, steps: [agentStep("agent-concluded", 5)] },
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
  // 1002 entries, entry(i) recorded (createdAt) at second i: the two oldest (0 and 1) fall off
  // the cap. The mtimes say the opposite, as after a copy: createdAt must win.
  for (let i = 0; i < 1002; i++) {
    const file = write(`${cache}/${entry(i)}`, { createdAt: new Date(1_000_000 + i * 1000) });
    fs.utimesSync(file, new Date(), new Date(9_000_000 - i * 1000));
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
  const kept = JSON.parse(fs.readFileSync(path.join(seed, entry(500)), "utf8")) as {
    createdAt: string;
  };
  expect(kept.createdAt).toBe(new Date(1_500_000).toISOString());
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

test("the Electron story job gets its own rows and spend line", () => {
  const web = "tests/stories/.e2e/stories-20261019T100000Z-1";
  const electron = "tests/stories/.e2e/stories-electron-20261019T100100Z-1";
  const result = (title: string) => ({
    titlePath: [title],
    status: "passed",
    attempts: [{ durationMs: 1000, steps: [] }],
  });
  write(`${web}/report.json`, { run: { status: "passed", results: [result("web smoke")] } });
  write(`${electron}/report.json`, {
    run: { status: "passed", results: [result("electron smoke")] },
  });
  write(`${electron}.spend.json`, { spentUsd: 0.5, capUsd: 3, settled: 4, refused: 0 });
  write("tests/stories/.e2e/stories-electron-preflight/report.json", { run: { results: [] } });

  const summary = summarize(root);
  expect(row(summary, "web smoke")?.[0]).toBe("`stories-20261019T100000Z-1`");
  expect(row(summary, "electron smoke")?.[0]).toBe("`stories-electron-20261019T100100Z-1`");
  // Each job once: the web kind's prefix also starts the Electron folder names.
  expect(summary.split("\n").filter((line) => line.includes("electron smoke")).length).toBe(1);
  expect(summary).not.toContain("stories-electron-preflight");
  expect(summary).toContain(
    "- `stories-electron-20261019T100100Z-1`: e2e passed. $0.50 spent of the $3.00 cap, 4 calls settled, 0 refused."
  );
});

test("the next seed merges both story jobs' caches, less what either deleted", () => {
  const seed = path.join(root, "tests/stories/.e2e-cache-seed");
  // The seed both jobs started from: entry 1 replays in both, entry 2 the Electron job deleted.
  for (const n of [1, 2])
    write(`tests/stories/.e2e-cache-seed/${entry(n)}`, { createdAt: new Date(n * 1000) });
  const web = "tests/stories/.e2e/stories-20261019T100000Z-1/cache";
  const electron = "tests/stories/.e2e/stories-electron-20261019T100100Z-1/cache";
  for (const n of [1, 2, 10]) write(`${web}/${entry(n)}`, { createdAt: new Date(n * 1000) });
  for (const n of [1, 20]) write(`${electron}/${entry(n)}`, { createdAt: new Date(n * 1000) });

  expect(nextSeed(root, seed)).toBe(3);
  expect(fs.readdirSync(seed).sort()).toEqual([entry(1), entry(10), entry(20)]);
});

/** A job with an e2e report of `status` and a proxy record of calls with these HTTP statuses. */
type Json = Record<string, unknown>;
const job = (output: string, status: string | null, calls: Json[]) => {
  if (status != null) write(`${output}/report.json`, { run: { status, results: [] } });
  write(
    `${output}.proxy.jsonl`,
    calls.map((c) => JSON.stringify({ outcome: "kept", model: "m", ms: 1, ...c })).join("\n")
  );
};
const web = "tests/stories/.e2e/stories-20261019T100000Z-1";
const repros = "tests/bugbash/.e2e/agent-repros-20261019T100500Z-2";
const electron = "tests/stories/.e2e/stories-electron-20261019T101000Z-3";

test("a failed job with a provider 5xx gets the retry, a probe failure without a folder too", () => {
  job(web, "failed", [{ outcome: "settled", status: 200 }, { status: 529 }]);
  job(repros, "passed", [{ status: 200 }]);
  expect(upstreamFault(root).retry).toBe(true);

  // The probe's 503 refused the job before its folder existed: only the record is there.
  fs.rmSync(path.join(root, web), { recursive: true });
  job(web, null, [{ status: 503 }]);
  expect(upstreamFault(root).retry).toBe(true);
});

test("a 4xx, a refusal or a proxy-made 502 is no provider fault: no retry", () => {
  job(web, "failed", [{ status: 429 }]);
  expect(upstreamFault(root).retry).toBe(false);
  job(web, "failed", [{ outcome: "refused", status: 402, reason: "budget: call does not fit" }]);
  expect(upstreamFault(root).retry).toBe(false);
  // The job's deadline or a client that went away aborts a call, which the proxy records as 502.
  job(web, "failed", [{ status: 502, reason: "aborted: deadline, client or close" }]);
  expect(upstreamFault(root).retry).toBe(false);
});

test("a probe that the provider did not answer in time gets the retry, a started job's abort not", () => {
  // The launcher refused the job after the probe's deadline: only the record is there.
  job(repros, null, [{ status: 502, reason: "aborted: deadline, client or close" }]);
  expect(upstreamFault(root).retry).toBe(true);
  // The same abort in a job that started is a call cut by the job's deadline: maybe a test.
  write(`${repros}/log.txt`, "");
  expect(upstreamFault(root).retry).toBe(false);
});

test("a test failure with no 5xx, or a failed job with no proxy record, gets no retry", () => {
  job(web, "failed", [{ outcome: "settled", status: 200 }]);
  expect(upstreamFault(root).retry).toBe(false);
  fs.rmSync(path.join(root, `${web}.proxy.jsonl`));
  expect(upstreamFault(root).retry).toBe(false);
});

test("one failed job without a 5xx blocks the retry that another failed job's 5xx asks for", () => {
  job(web, "passed", [{ status: 529 }]);
  job(repros, "failed", [{ status: 500 }]);
  job(electron, "failed", [{ outcome: "settled", status: 200 }]);
  fs.appendFileSync(path.join(root, `${electron}.proxy.jsonl`), '\n{"status": 5'); // cut off
  expect(upstreamFault(root).retry).toBe(false);
  job(electron, "failed", [{ status: 502, reason: "upstream: unreachable" }]);
  expect(upstreamFault(root).retry).toBe(true);
});

test("no failed job gets no retry, whatever 5xx a passed job's record holds", () => {
  job(web, "passed", [{ status: 529 }, { status: 200 }]);
  job(repros, "passed", [{ status: 500 }]);
  expect(upstreamFault(root).retry).toBe(false);
  // No output at all: make stopped before the first job (a preflight or the build).
  fs.rmSync(path.join(root, "tests"), { recursive: true });
  expect(upstreamFault(root).retry).toBe(false);
});
