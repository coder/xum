import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AppConfigOnDiskSchema } from "../../../src/common/config/schemas/appConfigOnDisk";
import { FixtureOptionsSchema, manifestName } from "./generate-fixture";

export const repoRoot = resolve(import.meta.dirname, "../../..");
export const outputDir = join(repoRoot, "artifacts/perf/workspace-scale");

export function benchArgs(defaultCount: number) {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      label: { type: "string" },
      repetitions: { type: "string", default: String(defaultCount) },
      launches: { type: "string", default: "1" },
    },
  });
  if (!values.root || !values.label || !/^[a-zA-Z0-9_-]+$/.test(values.label)) {
    throw new Error(
      "Required: --root <generated-fixture> --label <name> [--repetitions N] [--launches N]"
    );
  }
  return {
    root: resolve(values.root),
    label: values.label,
    repetitions: z.coerce.number().int().min(1).parse(values.repetitions),
    launches: z.coerce.number().int().min(1).parse(values.launches),
  };
}

export async function readFixture(root: string) {
  const options = FixtureOptionsSchema.parse(
    JSON.parse(await readFile(join(root, manifestName), "utf8"))
  );
  const source = await readFile(join(root, "config.json"), "utf8");
  const config = AppConfigOnDiskSchema.parse(JSON.parse(source));
  const workspaces = (config.projects ?? []).flatMap(([, project]) => project.workspaces);
  if (workspaces.length !== options.workspaces) throw new Error("Fixture workspace count changed");
  return { options, source, workspaces };
}

export async function copyFixture(source: string) {
  await readFixture(source);
  const container = await mkdtemp(join(tmpdir(), "xum-scale-"));
  const root = join(container, "root");
  try {
    await cp(source, root, { recursive: true });
    const config = await readFile(join(root, "config.json"), "utf8");
    // Absolute checkout/project paths must follow the copy, not mutate the pristine template.
    await writeFile(
      join(root, "config.json"),
      config.replaceAll(JSON.stringify(source).slice(1, -1), JSON.stringify(root).slice(1, -1))
    );
    await mkdir(join(root, "home"), { recursive: true });
    return { root, [Symbol.asyncDispose]: () => rm(container, { recursive: true, force: true }) };
  } catch (error) {
    await rm(container, { recursive: true, force: true });
    throw error;
  }
}

export function isolatedEnv(root: string): NodeJS.ProcessEnv {
  // Do not inherit credentials or global provider/agent settings from the real installation.
  return {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "home", ".config"),
    XDG_CACHE_HOME: join(root, "home", ".cache"),
    XUM_ROOT: root,
    XUM_LOG_LEVEL: "info",
    NODE_ENV: "production",
  };
}

export function summarize(samples: number[]) {
  if (!samples.length || samples.some((n) => !Number.isFinite(n)))
    throw new Error("Invalid samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    samples,
  };
}

export async function measure(operation: () => unknown) {
  const start = performance.now();
  const value: unknown = await operation();
  const ms = performance.now() - start;
  return {
    ms,
    bytes: Buffer.byteLength(JSON.stringify(value) ?? "null"),
    items: Array.isArray(value) ? value.length : undefined,
  };
}

export function printTable(rows: [string, ReturnType<typeof summarize>, string][]) {
  console.log("| Metric | Median | Min | Max | Unit |\n| --- | ---: | ---: | ---: | --- |");
  for (const [name, summary, unit] of rows) {
    console.log(
      "| " +
        [
          name,
          summary.median.toFixed(2),
          summary.min.toFixed(2),
          summary.max.toFixed(2),
          unit,
        ].join(" | ") +
        " |"
    );
  }
}

export async function writeResults(label: string, result: unknown) {
  await mkdir(outputDir, { recursive: true });
  const filename = join(outputDir, label + ".json");
  await writeFile(
    filename,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        head: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repoRoot,
          encoding: "utf8",
        }).trim(),
        machine: {
          platform: platform(),
          cpu: cpus()[0]?.model,
          cpus: cpus().length,
          bun: Bun.version,
          node: execFileSync("node", ["--version"], { encoding: "utf8" }).trim(),
        },
        result,
      },
      null,
      2
    ) + "\n"
  );
  console.log("Results: " + filename);
}
