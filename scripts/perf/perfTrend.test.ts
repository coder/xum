import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The CLI runs as a child process with a fake `gh` first on PATH, so it needs no test-only seam.
// The fake answers `gh api <path>` and `gh run download <id>` from a fixture file.
const root = mkdtempSync(join(tmpdir(), "perf-trend-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "bin"));
writeFileSync(
  join(root, "bin", "gh"),
  `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const key = args[0] === "api" ? args.find((arg) => arg.startsWith("repos/")) : "download " + args[2];
const reply = JSON.parse(fs.readFileSync(process.env.FAKE_GH, "utf8"))[key] ?? { err: key, code: 1 };
if (reply.dir) fs.cpSync(reply.dir, args[args.indexOf("-D") + 1], { recursive: true });
if (reply.out) process.stdout.write(JSON.stringify(reply.out));
if (reply.err) process.stderr.write(reply.err);
process.exit(reply.code ?? 0);
`
);
chmodSync(join(root, "bin", "gh"), 0o755);

const RUNS = "repos/o/r/actions/workflows/perf-profiles.yml/runs";
const HOSTILE = "HTTP 401: ::error::bad \u001b[31m`tick`<b>|\nsecond line";
let files = 0;

/** A one-test artifact whose chat-typing scenario has `scriptMs`, or an unparseable summary. */
function artifact(scriptMs: number | "invalid"): string {
  const dir = join(root, `artifact-${files++}`);
  const spec = { file: "tests/e2e/scenarios/perf.chatTyping.spec.ts", title: "typing" };
  mkdirSync(join(dir, "perf/electron/chat-typing"), { recursive: true });
  const metrics = {
    ScriptDuration: Number(scriptMs) / 1000,
    TaskDuration: 0.7,
    LayoutCount: 13,
    RecalcStyleCount: 5,
  };
  const profile = {
    wallTimeMs: 900,
    metrics: { ...metrics, DevToolsCommandDuration: 0, JSHeapUsedSize: 1 },
  };
  const summary = { schemaVersion: 1, runLabel: "chat-typing", test: { ...spec, retry: 0 } };
  const text =
    scriptMs === "invalid" ? "{" : JSON.stringify({ ...summary, chromeProfile: profile });
  writeFileSync(join(dir, "perf/electron/chat-typing/perf-summary.json"), text);
  const tests = [{ status: "expected", results: [{ retry: 0 }] }];
  const suites = [{ file: spec.file, specs: [{ title: spec.title, tests }] }];
  writeFileSync(join(dir, "perf/playwright-results.json"), JSON.stringify({ suites }));
  return dir;
}

type Replies = Record<string, { out?: unknown; err?: string; code?: number; dir?: string }>;
type Fixture = number | "invalid" | "expired" | "absent";

/** Run JSON for slot `slot` (0 = current, id 100); slot n is n days older. */
function apiRun(slot: number, overrides: Record<string, unknown> = {}) {
  const createdAt = new Date(Date.parse("2099-03-01T08:30:00Z") - slot * 86_400_000).toISOString();
  const base = {
    event: "schedule",
    head_branch: "main",
    status: "completed",
    created_at: createdAt,
  };
  return { id: 100 - slot, conclusion: "success", ...base, ...overrides };
}

/** Replies for history slots 1..n, listed oldest first (the CLI must order them). */
function replies(history: Fixture[]): Replies {
  const runs = history.map((_, index) => apiRun(index + 1)).reverse();
  const all: Replies = {
    "repos/o/r/actions/runs/100": { out: apiRun(0, { status: "in_progress" }) },
    [RUNS]: { out: { total_count: runs.length, workflow_runs: runs } },
  };
  history.forEach((night, index) => {
    const id = 99 - index;
    const artifacts =
      night === "absent" ? [] : [{ name: `perf-artifacts-${id}`, expired: night === "expired" }];
    all[`repos/o/r/actions/runs/${id}/artifacts`] = { out: { artifacts } };
    if (night !== "absent" && night !== "expired") all[`download ${id}`] = { dir: artifact(night) };
  });
  return all;
}

const ENV = { GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "100", GH_TOKEN: "t" };

function run(fixture: Replies, env: Record<string, string> = {}, extra: string[] = []) {
  const file = join(root, `fixture-${files++}.json`);
  writeFileSync(file, JSON.stringify(fixture));
  const args = ["--current", artifact(200), "--perf-result", "success", ...extra];
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "perfTrend.ts"), ...args], {
    // Only this env: CI's own GITHUB_ACTIONS and GITHUB_STEP_SUMMARY must not leak in.
    env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, FAKE_GH: file, ...ENV, ...env },
  });
  return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() };
}

const HISTORY: Fixture[] = [200, 200, "expired", "absent", "invalid", 100, 100, 100, 100, 100];

describe("perfTrend CLI", () => {
  test("missing, expired and unusable artifacts keep their slots as warned gaps", () => {
    const result = run(replies(HISTORY));
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Compared with 10 scheduled main nights (2099-02-19 to 2099-02-28)."
    );
    expect(result.out).toContain(
      "- regressed: `chat-typing` script ms 200 (+100%), 3 of 3 nights above"
    );
    expect(result.out).toContain(
      "- run 97: artifact missing or expired\n- run 96: artifact missing or expired\n- run 95: no usable summary\n"
    );
    expect(result.err).toBe(
      "perf trend: 1 regressed, 0 watch, 0 lost series over 10 nights; details in the job summary\n"
    );
  });

  const broken = (overrides: Record<string, unknown>) => ({
    out: { total_count: 2, workflow_runs: [apiRun(1), apiRun(2, overrides)] },
  });
  const failures: Array<[string, string, Replies[string]]> = [
    ["a runs listing that exits 1", RUNS, { err: HOSTILE, code: 1 }],
    ["a failed current-run fetch", "repos/o/r/actions/runs/100", { err: HOSTILE, code: 1 }],
    ["a failed artifact listing", "repos/o/r/actions/runs/99/artifacts", { err: HOSTILE, code: 1 }],
    ["a truncated listing", RUNS, { out: { total_count: 101, workflow_runs: [] } }],
    // Input the core rejects. Bun's Date.parse would roll 02-30 over to March.
    ["an impossible date", RUNS, broken({ created_at: "2099-02-30T08:30:00Z" })],
    ["a negative run id", RUNS, broken({ id: -5 })],
    ["two nights at one time", RUNS, broken({ created_at: apiRun(1).created_at })],
    ["a malformed createdAt", RUNS, broken({ created_at: "yesterday" })],
    ["a run without an event", RUNS, broken({ event: null })],
  ];
  for (const [name, key, reply] of failures) {
    test(`${name} is a history error with no table`, () => {
      const gap = { out: { artifacts: [] } };
      const fixture = { ...replies(["absent", "absent"]), [key]: reply };
      const result = run({ ...fixture, "repos/o/r/actions/runs/-5/artifacts": gap });
      expect(result.code).toBe(0);
      expect(result.out).toContain("### Problems\n\n- history fetch failed: `");
      expect(result.out).not.toMatch(/^\||no baseline|No earlier/m);
      expect(result.err).toBe("perf trend: history fetch failed; details in the job summary\n");
    });
  }

  test("in Actions, stdout stays empty and API text reaches only the summary, sanitized", () => {
    const summary = join(root, "summary.md");
    // The first run has no summary path, so only the GITHUB_ACTIONS check keeps stdout empty.
    for (const [fixture, path] of [
      [replies(HISTORY), ""],
      [{ ...replies([]), [RUNS]: { err: HOSTILE, code: 1 } }, summary],
    ] as const) {
      const result = run(fixture, { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: path });
      expect([result.code, result.out]).toEqual([0, ""]);
      expect(result.err).toMatch(/^perf trend: [a-z0-9 ,;]+\n$/);
    }
    const markdown = readFileSync(summary, "utf8");
    expect(markdown).toContain("- history fetch failed: `HTTP 401: ::error::bad tickb`\n");
    expect(markdown).not.toMatch(/[\u001b<>]|second line/);
  });

  test("a crash prints one sanitized line and exits 1", () => {
    const summary = join(root, "::error::x");
    mkdirSync(summary);
    // Bun's EISDIR message omits the path, so an unknown flag carries the workflow command.
    for (const result of [
      run(replies([]), { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary }),
      run(replies([]), {}, ["--::error::x"]),
    ]) {
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/^perf trend: crashed: [^\n]+\n$/);
      expect(result.err).not.toContain("::");
    }
  });
});
