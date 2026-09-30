import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { z } from "zod";
import {
  benchArgs,
  copyFixture,
  isolatedEnv,
  printTable,
  readFixture,
  repoRoot,
  writeResults,
} from "./common";

const args = benchArgs(20);
await using copy = await copyFixture(args.root);
const fixture = await readFixture(copy.root);
// Config's default stores resolve the home directory at import time, before CLI code can set env.
const child = spawn(
  process.execPath,
  [join(import.meta.dirname, "config-micro-worker.ts"), String(args.repetitions)],
  {
    cwd: repoRoot,
    env: isolatedEnv(copy.root),
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 300_000,
  }
);
let stdout = "";
child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
  stdout += chunk;
});
await once(child, "close");
if (child.exitCode !== 0) throw new Error("Config microbenchmark failed: " + stdout.slice(-4000));
const line = stdout.split("\n").find((value) => value.startsWith("WORKSPACE_SCALE_RESULT="));
if (!line) throw new Error("Worker did not return measurements");
const timings = z
  .record(
    z.string(),
    z.object({ median: z.number(), min: z.number(), max: z.number(), samples: z.array(z.number()) })
  )
  .parse(JSON.parse(line.slice("WORKSPACE_SCALE_RESULT=".length)));
console.log("\n### " + args.label + " config micro (" + args.repetitions + " iterations)");
printTable(Object.entries(timings).map(([name, stats]) => [name, stats, "ms"]));
await writeResults(args.label + ".micro", {
  fixture: fixture.options,
  configBytes: Buffer.byteLength(fixture.source),
  iterations: args.repetitions,
  timings,
});
