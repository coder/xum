/**
 * Desktop cold-start A/B runner (T3 #5971, desktop protocol D2). Each tree is a checkout after
 * `make build`. A launch is a cold Electron start of the tree's dist (XUM_E2E=1, XUM_E2E_LOAD_DIST=1,
 * mock AI) that reads the renderer's `xum:app-shell-ready` mark startTime. Pairs run ABBA (see
 * launchPlan) so order effects and drift hit both arms alike. Each launch gets a fresh copy of the
 * seeded root at one fixed path: config.json holds absolute paths, and state one launch writes must
 * not speed up the next. Each tree runs its own Electron, so an Electron bump is measured too.
 * Runs under Node (tsx), not Bun: under Bun 1.3.12 Playwright never finishes the websocket
 * upgrade to Electron's debugger, so every launch hangs (`bun x playwright test` uses Node too).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { _electron as electron } from "playwright";
import { setXumE2EEnv } from "../../tests/e2e/env";
import { prepareDemoProject } from "../../tests/e2e/utils/demoProject";
import { launchPlan, pairedRelativeDelta, type PlannedLaunch } from "./desktopColdStartStats";

const MARK = "xum:app-shell-ready";
const USAGE =
  "usage: node --import tsx scripts/perf/desktopColdStart.ts --base <appTree> --head <appTree> [--pairs 20] [--warmups 2] [--json] [--timeout-ms 120000]";
const E2E_ENV = { E2E: "1", E2E_LOAD_DIST: "1", MOCK_AI: "1", ENABLE_TUTORIALS_IN_SANDBOX: "0" };
type Arm = PlannedLaunch["arm"];
// Run in the renderer: Playwright serializes them, so they must not close over module state.
const markCount = (n: string) => performance.getEntriesByName(n, "mark").length;
const markTimes = (n: string) => performance.getEntriesByName(n, "mark").map((e) => e.startTime);
type Launch = PlannedLaunch & { index: number; warmup: boolean; markMs: number; wallMs: number };

function usageError(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

function intArg(name: string, raw: string, min: number): number {
  if (!/^[0-9]+$/.test(raw) || Number(raw) < min) usageError(`--${name}: integer >= ${min}`);
  return Number(raw);
}

/** Checks that the tree is built and returns its own Electron binary. */
function electronFor(tree: string): string {
  const manifest = path.join(tree, "package.json");
  if (!fs.existsSync(manifest)) usageError(`${tree}: no package.json`);
  const { main } = JSON.parse(fs.readFileSync(manifest, "utf8")) as { main?: string };
  for (const rel of [main ?? "<package.json main>", "dist/index.html", "node_modules/electron"]) {
    if (!fs.existsSync(path.join(tree, rel))) usageError(`${tree}: missing ${rel} (make build)`);
  }
  return createRequire(manifest)("electron") as string;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2; // odd length: the same index twice
}

async function main(): Promise<void> {
  // Only the result goes to stdout: electron logs "Downloading..." there when its binary is missing.
  const out = (line: string) => process.stdout.write(`${line}\n`);
  console.log = console.error;
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        base: { type: "string" },
        head: { type: "string" },
        pairs: { type: "string", default: "20" },
        warmups: { type: "string", default: "2" },
        json: { type: "boolean", default: false },
        "timeout-ms": { type: "string", default: "120000" },
      },
    }));
  } catch (error) {
    usageError(String(error));
  }
  if (!values.base || !values.head) usageError("--base and --head are required");
  const pairs = intArg("pairs", values.pairs, 2);
  const warmups = intArg("warmups", values.warmups, 0);
  const timeout = intArg("timeout-ms", values["timeout-ms"], 1);
  const tree = { base: path.resolve(values.base), head: path.resolve(values.head) };
  const bin = { base: electronFor(tree.base), head: electronFor(tree.head) };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xum-cold-start-"));
  const [root, seed] = [path.join(tmp, "root"), path.join(tmp, "seed")];
  // Enumerating process.env yields only strings. setXumE2EEnv also replaces XUM_ROOT / MUX_ROOT.
  const env = { ...process.env, NODE_ENV: "production" } as Record<string, string>;
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
  for (const [k, v] of Object.entries({ ...E2E_ENV, ROOT: root })) setXumE2EEnv(env, k, v);
  const launchOnce = async (arm: Arm) => {
    const start = Date.now();
    const args = process.platform === "linux" ? ["--no-sandbox", "."] : ["."];
    const executablePath = bin[arm];
    const app = await electron.launch({ executablePath, cwd: tree[arm], args, env, timeout });
    try {
      // E2E mode skips the splash, so the first window is the main window.
      const window = await app.firstWindow({ timeout });
      await window.waitForFunction(markCount, MARK, { timeout });
      const startTimes = await window.evaluate(markTimes, MARK);
      assert(startTimes.length === 1 && startTimes[0] > 0, `${MARK} marks: [${startTimes.join()}]`);
      return { markMs: startTimes[0], wallMs: Date.now() - start };
    } finally {
      await app.close();
    }
  };
  const launches: Launch[] = [];
  try {
    prepareDemoProject(root);
    fs.cpSync(root, seed, { recursive: true });
    for (const [index, { arm, pair }] of launchPlan(pairs, warmups).entries()) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.cpSync(seed, root, { recursive: true });
      // No retries: retrying failed launches would bias the sample.
      const result = await launchOnce(arm).catch((error: unknown) => {
        throw new Error(`launch ${index} (${arm}) failed: ${String(error)}`);
      });
      launches.push({ index, arm, pair, warmup: pair === null, ...result });
      console.error(`launch ${index} ${arm} ${pair ?? "warmup"}: ${result.markMs.toFixed(1)} ms`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // launchPlan visits pairs in increasing order, so index i of each arm is pair i.
  const measured = (arm: Arm) =>
    launches.filter((l) => l.arm === arm && !l.warmup).map((l) => l.markMs);
  const [base, head] = [measured("base"), measured("head")];
  const stats = pairedRelativeDelta(base, head);
  if (values.json) {
    const side = (arm: Arm) => {
      const git = spawnSync("git", ["-C", tree[arm], "rev-parse", "HEAD"], { encoding: "utf8" });
      return { tree: tree[arm], gitSha: git.status === 0 ? git.stdout.trim() : null };
    };
    const result = { base: side("base"), head: side("head"), pairs, warmupsPerArm: warmups };
    out(JSON.stringify({ ...result, launches, stats }, null, 2));
    return;
  }
  const pct = (fraction: number) => `${(fraction * 100).toFixed(2)}%`;
  out(["index", "arm", "pair", "mark ms", "wall ms"].join("\t"));
  for (const l of launches) {
    out([l.index, l.arm, l.pair ?? "warmup", l.markMs.toFixed(1), l.wallMs].join("\t"));
  }
  const { n, meanDelta, halfWidth95, upperBound95 } = stats;
  out(`\nn=${n}  mean delta ${pct(meanDelta)}  one-sided 95% upper bound ${pct(upperBound95)}`);
  out(`half-width ${pct(halfWidth95)} (<= 2.5%: ${halfWidth95 <= 0.025 ? "yes" : "no"})`);
  out(`median mark ms: base ${median(base).toFixed(1)}, head ${median(head).toFixed(1)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
