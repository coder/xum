/**
 * Runs the mitata benchmarks a `*.bench.ts` file registered and writes them as JSON.
 *
 * Only the generated entry files of scripts/perf/bench.ts import this module: they import the bench
 * file first (which registers its benchmarks) and then call runAndReport().
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "mitata";

export const BENCH_JSON_SCHEMA_VERSION = 1;

export type BenchRuntime = "node" | "bun";

/** Facts the runner knows at build time and bakes into the generated entry. */
export interface BenchMeta {
  bench: string;
  runtime: BenchRuntime;
  gitSha: string;
  dirty: boolean;
}

/** Summary stats of one mitata run in nanoseconds; heap is bytes per iteration. */
export interface BenchRunResult {
  name: string;
  args: Record<string, unknown>;
  stats: {
    avg: number;
    p50: number;
    p75: number;
    p99: number;
    min: number;
    max: number;
    samples: number;
    gc?: { avg: number; min: number; max: number; total: number };
    heap?: { avg: number; min: number; max: number; total: number };
  };
}

export interface BenchJson extends BenchMeta {
  schemaVersion: typeof BENCH_JSON_SCHEMA_VERSION;
  runtimeVersion: string;
  cpuModel: string;
  cpuCount: number;
  loadavgStart: number[];
  loadavgEnd: number[];
  startedAt: string;
  benchmarks: BenchRunResult[];
}

function formatLoadavg(loadavg: number[]): string {
  return loadavg.map((value) => value.toFixed(2)).join(" ");
}

type Summary = NonNullable<BenchRunResult["stats"]["heap"]>;

// mitata's heap object also carries an internal sample counter; keep the documented fields only.
function pickSummary(summary: Summary): Summary {
  return { avg: summary.avg, min: summary.min, max: summary.max, total: summary.total };
}

export async function runAndReport(meta: BenchMeta): Promise<void> {
  // The runner passes the JSON path per process so one bundle serves every compare round.
  const jsonPath = process.argv[2];
  assert(jsonPath, "usage: <bench entry> <json output path>");

  const runtimeVersion = meta.runtime === "bun" ? `bun ${Bun.version}` : `node ${process.version}`;
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? "unknown";
  const startedAt = new Date().toISOString();
  const loadavgStart = os.loadavg();
  console.log(
    `${meta.bench} | ${runtimeVersion} | ${cpuModel} x${cpus.length} | loadavg start ${formatLoadavg(loadavgStart)}`
  );

  const { benchmarks: trials } = await run({ format: "mitata" });
  const loadavgEnd = os.loadavg();

  const benchmarks: BenchRunResult[] = [];
  const errors: string[] = [];
  for (const trial of trials) {
    for (const runResult of trial.runs) {
      if (runResult.stats === undefined) {
        errors.push(`${runResult.name}: ${String(runResult.error)}`);
        continue;
      }
      const stats = runResult.stats;
      benchmarks.push({
        name: runResult.name,
        args: runResult.args,
        stats: {
          avg: stats.avg,
          p50: stats.p50,
          p75: stats.p75,
          p99: stats.p99,
          min: stats.min,
          max: stats.max,
          samples: stats.samples.length,
          ...(stats.gc ? { gc: pickSummary(stats.gc) } : {}),
          ...(stats.heap ? { heap: pickSummary(stats.heap) } : {}),
        },
      });
    }
  }

  const json: BenchJson = {
    schemaVersion: BENCH_JSON_SCHEMA_VERSION,
    ...meta,
    runtimeVersion,
    cpuModel,
    cpuCount: cpus.length,
    loadavgStart,
    loadavgEnd,
    startedAt,
    benchmarks,
  };
  if (errors.length > 0) {
    // A partial result must not look like a complete one: write no JSON and exit nonzero. The
    // runner removes any older file at this path.
    console.error(`${errors.length} benchmark(s) threw, no JSON written:\n${errors.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`loadavg end ${formatLoadavg(loadavgEnd)} | JSON: ${jsonPath}`);
}
