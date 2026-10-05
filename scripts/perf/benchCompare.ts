/**
 * Compare `*.bench.ts` results between two revisions (a small benchstat equivalent).
 *
 * Usage: make bench-compare BENCH=<filter> [BASE=<ref>] [ROUNDS=10] [RUNTIME=node|bun], or
 *        bun scripts/perf/benchCompare.ts --bench <filter> [--base <ref>] [--head <ref>]
 *          [--rounds 10] [--runtime node|bun]
 *
 * Base defaults to `git merge-base HEAD origin/main`; head defaults to the working tree, uncommitted
 * edits included. Each ref is checked out into a temporary detached worktree in the OS temp dir
 * (outside every measured tree, removed on exit); the caller's checkout, index and stash are never
 * touched. Both sides run the caller's working-tree *.bench.ts files, so only the measured code
 * differs; anything a bench file imports (helpers included) comes from each side's own tree.
 * Rounds interleave base and head as fresh processes (alternating which goes first), so host load
 * drift hits both sides alike; benchStats pairs the two runs of each round.
 * npm packages come from the caller's node_modules on both sides: this compares source changes.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
  benchName,
  discoverBenches,
  git,
  gitState,
  parseRuntime,
  prepareBench,
  repoRoot,
  runBenchCommand,
} from "./bench";
import type { BenchJson } from "./benchReport";
import { compareBenchRounds, type BenchComparison } from "./benchStats";

interface Side {
  label: "base" | "head";
  root: string;
  gitSha: string;
  dirty: boolean;
  commands: Map<string, string[]>;
  /** Per benchmark key: the mean (mitata avg) of each round, in ns. */
  means: Map<string, number[]>;
}

function formatNs(ns: number): string {
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} s`;
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
  return `${ns.toFixed(0)} ns`;
}

function formatPct(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function benchmarkKey(name: string, args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return name;
  return `${name} [${entries.map(([key, value]) => `${key}=${String(value)}`).join(", ")}]`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string" },
      bench: { type: "string" },
      rounds: { type: "string", default: "10" },
      runtime: { type: "string" },
    },
  });
  assert(values.bench, "--bench <filter> is required");
  const rounds = Number(values.rounds);
  assert(Number.isInteger(rounds) && rounds >= 2, "--rounds must be an integer >= 2");
  const runtime = parseRuntime(values.runtime);

  const root = repoRoot();
  const benches = discoverBenches(root, values.bench);
  const baseSha = git(root, [
    "rev-parse",
    "--verify",
    `${values.base ?? git(root, ["merge-base", "HEAD", "origin/main"])}^{commit}`,
  ]);
  const headSha = values.head
    ? git(root, ["rev-parse", "--verify", `${values.head}^{commit}`])
    : undefined;

  // Outside the repo, so a bench that scans its cwd sees no nested checkout on the head side.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xum-bench-compare-"));
  // Bundles live in each side's own tree (node resolves the external npm packages from there).
  const buildDirName = `compare-${path.basename(tmpDir)}`;
  const buildDirs: string[] = [];
  const worktrees: string[] = [];
  // Idempotent. Signal handlers call it themselves because process.exit() skips `finally`.
  const cleanup = (): void => {
    for (const worktree of worktrees.splice(0)) {
      const removed = spawnSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: root,
        encoding: "utf8",
      });
      if (removed.status !== 0) {
        console.error(`could not remove worktree ${worktree}: ${removed.stderr}`);
        process.exitCode = 1;
      }
    }
    for (const dir of buildDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.once(signal, () => {
      cleanup();
      process.exit(code);
    });
  }

  const addWorktree = (label: string, sha: string): string => {
    const dir = path.join(tmpDir, label);
    git(root, ["worktree", "add", "--detach", dir, sha]);
    worktrees.push(dir);
    // Windows needs a junction: directory symlinks need Developer Mode or elevation there.
    fs.symlinkSync(
      path.join(root, "node_modules"),
      path.join(dir, "node_modules"),
      process.platform === "win32" ? "junction" : "dir"
    );
    // src/version.ts is generated and git-ignored; reuse the caller's copy for imports of it.
    const versionFile = path.join(root, "src", "version.ts");
    if (fs.existsSync(versionFile))
      fs.copyFileSync(versionFile, path.join(dir, "src", "version.ts"));
    for (const bench of benches) {
      fs.mkdirSync(path.dirname(path.join(dir, bench)), { recursive: true });
      fs.copyFileSync(path.join(root, bench), path.join(dir, bench));
    }
    return dir;
  };

  try {
    const newSide = (
      label: Side["label"],
      sideRoot: string,
      sha: string,
      dirty: boolean
    ): Side => ({
      label,
      root: sideRoot,
      gitSha: sha,
      dirty,
      commands: new Map(),
      means: new Map(),
    });
    const headState = gitState(root);
    const sides = [
      newSide("base", addWorktree("base", baseSha), baseSha, false),
      headSha
        ? newSide("head", addWorktree("head", headSha), headSha, false)
        : newSide("head", root, headState.gitSha, headState.dirty),
    ];

    for (const side of sides) {
      for (const bench of benches) {
        const meta = { bench, runtime, gitSha: side.gitSha, dirty: side.dirty };
        const outDir = path.join(side.root, "build", "bench", buildDirName);
        if (!buildDirs.includes(outDir)) buildDirs.push(outDir);
        side.commands.set(bench, await prepareBench(side.root, bench, meta, outDir));
      }
    }

    const loadavgStart = os.loadavg();
    for (let round = 0; round < rounds; round++) {
      // Alternate which side runs first so warm caches and load trends do not favor one side. Run
      // both sides of one bench file back to back, so each pair shares the same host conditions.
      const order = round % 2 === 0 ? sides : [...sides].reverse();
      for (const bench of benches) {
        for (const side of order) {
          const jsonPath = path.join(tmpDir, `${side.label}-${benchName(bench)}-${round}.json`);
          runBenchCommand(side.commands.get(bench)!, jsonPath, side.root, true);
          // spawnSync blocks the event loop: yield so a pending SIGINT/SIGTERM handler runs now,
          // between runs, instead of after the last round.
          await new Promise((resolve) => setImmediate(resolve));
          const result = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as BenchJson;
          const names = result.benchmarks.map((benchmark) => benchmark.name);
          for (const benchmark of result.benchmarks) {
            // mitata names usually embed the args ("$workspaces"); add them only when needed.
            const unique = names.indexOf(benchmark.name) === names.lastIndexOf(benchmark.name);
            const label = unique ? benchmark.name : benchmarkKey(benchmark.name, benchmark.args);
            const key = `${benchName(bench)}: ${label}`;
            side.means.set(key, [...(side.means.get(key) ?? []), benchmark.stats.avg]);
          }
        }
      }
      console.error(`round ${round + 1}/${rounds} done (loadavg ${os.loadavg()[0].toFixed(2)})`);
    }
    const loadavgEnd = os.loadavg();

    const [base, head] = sides;
    // Every benchmark must run on both sides in every round; a silently dropped row hides a change.
    const baseKeys = [...base.means.keys()].sort();
    const headKeys = [...head.means.keys()].sort();
    assert.deepEqual(headKeys, baseKeys, "base and head produced different benchmarks");
    const rows: Array<{ key: string } & BenchComparison> = [];
    for (const [key, baseValues] of base.means) {
      const headValues = head.means.get(key)!;
      assert(
        baseValues.length === rounds && headValues.length === rounds,
        `${key}: expected ${rounds} results per side, got ${baseValues.length}/${headValues.length}`
      );
      rows.push({ key, ...compareBenchRounds(baseValues, headValues) });
    }
    assert(rows.length > 0, "the selected benches produced no benchmarks");

    const header = ["benchmark", "base", "head", "delta", "95% CI", "verdict"];
    const table = rows.map((row) => [
      row.key,
      formatNs(row.baseMedian),
      formatNs(row.headMedian),
      formatPct(row.deltaPct),
      `[${formatPct(row.ciLowPct)}, ${formatPct(row.ciHighPct)}]`,
      row.verdict,
    ]);
    const widths = header.map((cell, i) =>
      Math.max(cell.length, ...table.map((cells) => cells[i].length))
    );
    const formatRow = (cells: string[]): string =>
      cells
        .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
        .join("  ");
    const loadavg = (values: number[]): string => values.map((v) => v.toFixed(2)).join(" ");
    const headLabel = `${head.gitSha.slice(0, 12)}${head.dirty ? " (dirty)" : ""}`;
    console.log(
      `runtime ${runtime} | rounds ${rounds} | base ${base.gitSha.slice(0, 12)} | head ${headLabel}`
    );
    console.log(`loadavg start ${loadavg(loadavgStart)} | end ${loadavg(loadavgEnd)}`);
    console.log("base/head: median over rounds of each run's mean time");
    console.log(formatRow(header));
    for (const cells of table) console.log(formatRow(cells));

    const jsonPath = path.join(
      root,
      "artifacts",
      "bench",
      // The timestamp keeps runs against the same (often dirty) head from overwriting each other.
      `compare-${head.gitSha.slice(0, 12)}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    );
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    const output = {
      schemaVersion: 1,
      runtime,
      rounds,
      benches,
      base: { gitSha: base.gitSha, means: Object.fromEntries(base.means) },
      head: { gitSha: head.gitSha, dirty: head.dirty, means: Object.fromEntries(head.means) },
      loadavgStart,
      loadavgEnd,
      rows,
    };
    fs.writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`JSON: ${jsonPath}`);
  } finally {
    cleanup();
  }
}

await main();
