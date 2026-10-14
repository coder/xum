/**
 * Microbenchmark runner for `*.bench.ts` files (mitata). See docs/reference/code-benchmarks.mdx.
 *
 * Usage: bun scripts/perf/bench.ts [--runtime node|bun] [--json <path>] [filter]
 *
 * The filter is a path substring, or a glob when it contains glob characters. Node is the default
 * runtime because production runs on V8 (Electron and `xum server`); Bun runs on JavaScriptCore.
 * Each bench runs in a fresh process and writes JSON (default: artifacts/bench/<name>-<runtime>-<sha>.json).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import type { BenchMeta, BenchRuntime } from "./benchReport";

const BENCH_REPORT_PATH = path.join(import.meta.dir, "benchReport.ts");

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert(result.status === 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function repoRoot(): string {
  return git(process.cwd(), ["rev-parse", "--show-toplevel"]);
}

export function gitState(root: string): { gitSha: string; dirty: boolean } {
  return {
    gitSha: git(root, ["rev-parse", "HEAD"]),
    dirty: git(root, ["status", "--porcelain"]).length > 0,
  };
}

export function parseRuntime(value: string | undefined): BenchRuntime {
  const runtime = value ?? "node";
  assert(runtime === "node" || runtime === "bun", `--runtime must be node or bun, got ${runtime}`);
  return runtime;
}

/** Tracked and untracked (not ignored) bench files matching the filter, relative to root. */
export function discoverBenches(root: string, filter: string | undefined): string[] {
  // -z: without it git C-quotes paths with non-ASCII or special characters, and those benches would
  // fail the existence check below and be skipped silently.
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.bench.ts"],
    { cwd: root, encoding: "utf8" }
  );
  assert(listed.status === 0, `git ls-files failed: ${listed.stderr}`);
  const all = listed.stdout
    .split("\0")
    .filter((file) => file.length > 0 && fs.existsSync(path.join(root, file)));
  if (!filter) return all;
  const glob = /[*?[{]/.test(filter) ? new Bun.Glob(filter) : undefined;
  const matches = all.filter((file) => (glob ? glob.match(file) : file.includes(filter)));
  if (matches.length === 0) {
    console.error(`No *.bench.ts file matches "${filter}". Available benches:`);
    for (const file of all) console.error(`  ${file}`);
    process.exit(1);
  }
  return matches;
}

/**
 * File-name-safe identity of a bench file: its base name plus a hash of the repo-relative path, so
 * same-named files in different directories never share an entry or JSON path.
 */
export function benchName(benchPath: string): string {
  const hash = createHash("sha256").update(benchPath).digest("hex").slice(0, 8);
  return `${path.basename(benchPath, ".bench.ts")}-${hash}`;
}

/**
 * Writes the entry (and the node bundle) for one bench into `outDir`, a directory private to this
 * invocation, and returns the command that runs it (append the JSON output path). `root` is the
 * tree whose implementation is measured; the reporting code always comes from this harness.
 */
export async function prepareBench(
  root: string,
  benchPath: string,
  meta: BenchMeta,
  outDir: string
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const name = benchName(benchPath);
  const entryPath = path.join(outDir, `${name}.entry.ts`);
  fs.writeFileSync(
    entryPath,
    [
      `import ${JSON.stringify(path.join(root, benchPath))};`,
      `import { runAndReport } from ${JSON.stringify(BENCH_REPORT_PATH)};`,
      `await runAndReport(${JSON.stringify(meta)});`,
      "",
    ].join("\n")
  );

  if (meta.runtime === "bun") {
    // Bun resolves the `@/` aliases through the tsconfig next to the bench file.
    return [process.execPath, entryPath];
  }

  // Node cannot run TypeScript with path aliases: bundle the sources, keep npm packages external
  // so node loads them natively, and lower syntax (`using`) for Node 22.
  const bundlePath = path.join(outDir, `${name}.mjs`);
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entryPath],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    tsconfig: path.join(root, "tsconfig.json"),
    packages: "external",
    metafile: true,
    logLevel: "error",
    // App sources compile to CommonJS, and some read `__filename`, `__dirname` or `require` at
    // module scope (src/node/utils/main/workerPool.ts). An ESM bundle has no such bindings, so
    // define them for the bundle file.
    banner: {
      js: [
        'import { createRequire as __benchCreateRequire } from "node:module";',
        'import { dirname as __benchDirname } from "node:path";',
        'import { fileURLToPath as __benchFileURLToPath } from "node:url";',
        "const __filename = __benchFileURLToPath(import.meta.url);",
        "const __dirname = __benchDirname(__filename);",
        "const require = __benchCreateRequire(import.meta.url);",
      ].join("\n"),
    },
  });
  for (const [input, info] of Object.entries(result.metafile.inputs)) {
    const bunImport = info.imports.find((imported) => imported.path.startsWith("bun:"));
    if (bunImport) {
      throw new Error(
        `${benchPath} imports ${bunImport.path} via ${input}; benches run on node too`
      );
    }
  }
  return ["node", "--expose-gc", bundlePath];
}

/** Runs a prepared bench in `cwd` (the measured tree), so cwd-relative work sees that tree. */
export function runBenchCommand(
  command: string[],
  jsonPath: string,
  cwd: string,
  quiet: boolean
): void {
  const result = spawnSync(command[0], [...command.slice(1), jsonPath], {
    cwd,
    stdio: ["ignore", quiet ? "ignore" : "inherit", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`${command.join(" ")} exited with ${result.status ?? result.signal}`);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { runtime: { type: "string" }, json: { type: "string" } },
    allowPositionals: true,
  });
  assert(positionals.length <= 1, "usage: bench.ts [--runtime node|bun] [--json <path>] [filter]");
  const runtime = parseRuntime(values.runtime);
  const root = repoRoot();
  const benches = discoverBenches(root, positionals[0]);
  assert(!values.json || benches.length === 1, "--json needs a filter that selects one bench");

  const state = gitState(root);
  // A private build dir per invocation, so concurrent runs never overwrite each other's bundles.
  fs.mkdirSync(path.join(root, "build", "bench"), { recursive: true });
  const outDir = fs.mkdtempSync(path.join(root, "build", "bench", "run-"));
  let failed = false;
  for (const bench of benches) {
    const jsonPath =
      values.json ??
      path.join(
        root,
        "artifacts",
        "bench",
        `${benchName(bench)}-${runtime}-${state.gitSha.slice(0, 12)}.json`
      );
    // The one cleanup boundary for the output: the file exists afterwards only if the build and
    // the run both succeeded, whatever failed in between (build error, throw at import or in a
    // benchmark, a crash after a partial write).
    fs.rmSync(jsonPath, { force: true });
    try {
      const command = await prepareBench(root, bench, { bench, runtime, ...state }, outDir);
      runBenchCommand(command, path.resolve(jsonPath), root, false);
    } catch (error) {
      fs.rmSync(jsonPath, { force: true });
      console.error(`${bench}: ${error instanceof Error ? error.message : String(error)}`);
      failed = true;
    }
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  if (failed) process.exit(1);
}

if (import.meta.main) {
  await main();
}
