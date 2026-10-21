import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkSeed, MAX_SEED_BYTES } from "../bugbash/sandbox/cacheSeed";
import { jobSections, nextSeed, NO_OUTPUT_NOTE, storyPage, upstreamFault } from "./summary";

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
const entry = (n: number) => `${n.toString(16).padStart(64, "0")}.json`;
// Real reports of `make test-stories` under Haiku, trimmed (prComment.test.ts uses them too).
const fixture = (name: string) =>
  fs.readFileSync(path.join(import.meta.dir, "testdata", `${name}.report.json`), "utf8");
const headlines = (page: string) => page.split("\n").filter((line) => line.startsWith("### "));

test("a section per job in run order, each with its spend under the headline", () => {
  const web = "tests/stories/.e2e/stories-20261019T100000Z-1";
  write(`${web}/report.json`, fixture("red"));
  write(`${web}.spend.json`, {
    spentUsd: 0.2712,
    capUsd: 3,
    settled: 12,
    refused: 2,
    refusedBy: { budget: 2 },
  });
  // The web kind's prefix also starts the Electron folder names: each job shows once.
  write("tests/stories/.e2e/stories-electron-20261019T100100Z-1/report.json", fixture("green"));
  write("tests/stories/.e2e/stories-preflight/report.json", { run: { results: [] } });
  write("tests/stories/.e2e/stories-electron-preflight/report.json", { run: { results: [] } });

  const page = storyPage(jobSections(root, { model: "anthropic:claude-sonnet-5-5" }));
  expect(headlines(page)).toEqual([
    "### 🔴 e2e stories (Sonnet): 1 failed, 1 passed",
    "### 🟢 e2e Electron stories (Sonnet): 3 passed",
  ]);
  // Each spend line is in its job's head, the part a passing job folds to in the PR comment.
  const [stories, electron] = jobSections(root);
  expect(stories.head.split("\n").at(-1)).toBe(
    'Spend: $0.27 of the $3.00 cap (proxy ledger), 2 calls refused {"budget":2}'
  );
  expect(electron.head.split("\n").at(-1)).toBe("Spend: no record (spend.json missing)");
  expect(stories.rest).toContain("ASSERTION_FAILED");
  expect(page).not.toContain("preflight");
});

test("a missing, cut-off or foreign report gets a red headline that says so", () => {
  fs.mkdirSync(path.join(root, "tests/stories/.e2e/stories-20261019T100000Z-1"), {
    recursive: true,
  });
  write("tests/stories/.e2e/stories-20261019T100100Z-2/report.json", '{"run": {"results": [');
  write("tests/stories/.e2e/stories-20261019T100200Z-3/report.json", { schemaVersion: "x" });
  // The right version, a shape e2e cannot render (no serialGroups, no summary).
  write("tests/stories/.e2e/stories-20261019T100300Z-4/report.json", {
    schemaVersion: "report-1",
    run: { results: [{ titlePath: ["half"], attempts: [{ steps: "?" }, null] }] },
  });

  expect(headlines(storyPage(jobSections(root)))).toEqual([
    "### 🔴 e2e stories: report.json missing",
    "### 🔴 e2e stories: report.json not valid JSON (cut off?)",
    "### 🔴 e2e stories: report.json is not an e2e report-1 document",
    "### 🔴 e2e stories: report.json could not be rendered",
  ]);
});

test("no job output says that make test-stories stopped before its first job", () => {
  expect(storyPage(jobSections(root))).toBe(`${NO_OUTPUT_NOTE}\n`);
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
