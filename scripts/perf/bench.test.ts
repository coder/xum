/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `await expect(...).rejects.toThrow()` as void */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { prepareBench, repoRoot, runBenchCommand } from "./bench";
import type { BenchJson, BenchRuntime } from "./benchReport";

// Bench files and bundles live under the repo's build/ folder, like a real run: the node bundle
// keeps npm packages external, so it resolves them from the repo's node_modules.
const root = repoRoot();
let dir: string | undefined;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Writes `source` as a bench file and runs it; returns the JSON path it was told to write. */
function runBench(source: string, runtime: BenchRuntime): Promise<string> {
  fs.mkdirSync(path.join(root, "build", "bench"), { recursive: true });
  dir = fs.mkdtempSync(path.join(root, "build", "bench", "test-"));
  const benchPath = path.relative(root, path.join(dir, "sample.bench.ts"));
  fs.writeFileSync(path.join(root, benchPath), source);
  const jsonPath = path.join(dir, "result.json");
  const meta = { bench: benchPath, runtime, gitSha: "0".repeat(40), dirty: false };
  return prepareBench(root, benchPath, meta, path.join(dir, "out")).then((command) => {
    runBenchCommand(command, jsonPath, root, true);
    return jsonPath;
  });
}

describe("bench runner", () => {
  test("a node bench whose imports load a package stylesheet runs", async () => {
    const jsonPath = await runBench(
      [
        'import "katex/dist/katex.min.css";',
        'import { bench } from "mitata";',
        'bench("noop", () => {});',
      ].join("\n"),
      "node"
    );
    const json = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as BenchJson;
    expect(json.benchmarks.map((benchmark) => benchmark.name)).toEqual(["noop"]);
  }, 60_000);

  test("a bench file that registers no benchmarks fails and writes no JSON", async () => {
    await expect(runBench("export {};\n", "bun")).rejects.toThrow(/exited with 1/);
    expect(fs.existsSync(path.join(dir!, "result.json"))).toBe(false);
  }, 60_000);
});
