/**
 * Agent bug bash: runs one TesterArmy `e2e explore` per charter and explorer model against
 * disposable Xum servers, then merges every explorer's findings into one Markdown file.
 *
 * Usage: make bug-bash [BUGBASH_ARGS="--only composer,settings --parallel 4 --max-steps 6"], or
 *        bun tests/bugbash/run.ts [--charters <file>] [--only <slug,...>] [--parallel 8]
 *          [--max-steps 6]
 * --charters: a branch-specific charter file (same format), instead of tests/bugbash/charters.txt.
 *
 * Models: BUGBASH_MODELS, comma-separated `<provider>:<model>`, default Opus 5.5 and Sonnet 5.5.
 * In a three-model comparison (2026-10) these two found 14 of 15 distinct bugs and overlapped on
 * only 4, so the default runs both; GPT-6.1 Sol found 1. Every model runs every charter, all in
 * one pool of --parallel explorers. Reasoning: BUGBASH_EFFORT, default medium (e2e.config.ts).
 *
 * Charters: tests/bugbash/charters.txt. Config and personas: tests/bugbash/e2e.config.ts.
 * Output: tests/bugbash/.e2e/bugbash/<run>/<model>/ with one directory, log and app log per
 * charter, and <run>/findings.md for all models. Findings are explorer claims, not confirmed bugs:
 * verify each one with a failing repro test (`e2e guide bug-bash`, steps 5-6, and the bug-bash
 * project skill).
 *
 * The e2e CLI needs Node.js 22.22.3+ or 24.8+ on PATH (or E2E_NODE=<path to node>).
 * Exit code: 0 when every charter ran (with or without findings), else the highest e2e setup or
 * infrastructure code (2, 3 or 4) among the charters.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

const projectDir = import.meta.dir;
const repoRoot = path.resolve(projectDir, "../..");
const e2eBin = path.join(repoRoot, "node_modules/e2e/dist/cli/bin.js");

interface Charter {
  slug: string;
  target: string;
  agent: string;
  goal: string;
}

interface Finding {
  kind: "issue" | "warning";
  severity: number;
  title: string;
  expected: string;
  actual: string;
  reproduction: string[];
  path?: string;
}

interface Job {
  charter: Charter;
  /** `<provider>:<model>`, passed to e2e.config.ts as BUGBASH_MODEL. */
  model: string;
  /** Path-safe form of `model`: the per-model output directory. */
  modelDir: string;
}

interface CharterResult {
  job: Job;
  exitCode: number;
  ended: string;
  findings: Finding[];
}

function readCharters(file: string): Charter[] {
  const charters: Charter[] = [];
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [slug, target, agent, ...rest] = line.split("|");
    const goal = rest.join("|").trim();
    assert(
      slug && target && agent && goal,
      `charter line must be slug|target|agent|charter: ${line}`
    );
    assert(/^[a-z0-9-]+$/.test(slug), `charter slug must be [a-z0-9-]: ${slug}`);
    charters.push({ slug, target, agent, goal });
  }
  assert(new Set(charters.map((c) => c.slug)).size === charters.length, "duplicate charter slug");
  return charters;
}

// e2e's own floor (docs: CLI reference). Older Node fails inside the runner with less clear errors.
function checkNodeVersion(node: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(node, ["--version"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.once("error", reject);
    child.once("exit", () => {
      const [major, minor, patch] = out.trim().replace(/^v/, "").split(".").map(Number);
      const ok =
        major > 24 ||
        (major === 24 && minor >= 8) ||
        (major === 22 && (minor > 22 || (minor === 22 && patch >= 3)));
      if (ok) resolve();
      else
        reject(
          new Error(
            `e2e needs Node.js 22.22.3+ or 24.8+, but ${node} is ${out.trim() || "unknown"}. ` +
              "Put a newer node first on PATH or set E2E_NODE."
          )
        );
    });
  });
}

function outRelFor(job: Job, runRel: string): string {
  return `${runRel}/${job.modelDir}/${job.charter.slug}`;
}

function runCharter(node: string, job: Job, runRel: string, maxSteps: number): Promise<number> {
  const { charter } = job;
  const outRel = outRelFor(job, runRel);
  const log = fs.openSync(path.join(projectDir, `${outRel}.log`), "w");
  const args = [
    e2eBin,
    "explore",
    charter.goal,
    "--config",
    "e2e.config.ts",
    "--target",
    charter.target,
    "--agent",
    charter.agent,
    "--output",
    outRel,
    "--max-steps",
    String(maxSteps),
    "--video=on",
    "--reporter",
    "list,markdown",
  ];
  const child = spawn(node, args, {
    cwd: projectDir,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      // startApp.ts runs `node` and the e2e bin's children resolve it from PATH too.
      PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}`,
      BUGBASH_MODEL: job.model,
      BUGBASH_APP_LOG: `${outRel}.app.log`,
      E2E_TELEMETRY_DISABLED: "1",
    },
  });
  return new Promise((resolve) => {
    child.once("error", () => resolve(4));
    child.once("exit", (code, signal) => {
      fs.closeSync(log);
      resolve(code ?? (signal ? 130 : 4));
    });
  });
}

function readResult(job: Job, runRel: string, exitCode: number): CharterResult {
  const reportPath = path.join(projectDir, outRelFor(job, runRel), "report.json");
  if (!fs.existsSync(reportPath)) return { job, exitCode, ended: "no report", findings: [] };
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
    run?: { explore?: { ended: string; findings: Finding[] } };
  };
  const explore = report.run?.explore;
  return {
    job,
    exitCode,
    ended: explore?.ended ?? "no explore record",
    findings: explore?.findings ?? [],
  };
}

const EXIT_MEANING: Record<number, string> = {
  0: "ran, no issues",
  1: "issues reported, or no step ran",
  2: "setup error",
  3: "infrastructure error",
  4: "e2e internal error",
  130: "interrupted",
};

function writeFindings(
  file: string,
  results: CharterResult[],
  models: string[],
  effort: string
): void {
  const lines = ["# Bug bash findings", ""];
  lines.push(
    "Explorer claims, not confirmed bugs. Verify each with a failing repro test before reporting it.",
    "The same defect can appear once per model: merge those before triage.",
    "",
    `Explorer models: ${models.map((m) => `\`${m}\``).join(", ")}. Effort: \`${effort}\`.`,
    "",
    "| Model | Charter | Target | Agent | Exit | Ended | Issues | Warnings |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const r of results) {
    const issues = r.findings.filter((f) => f.kind === "issue").length;
    const meaning = EXIT_MEANING[r.exitCode] ?? "unknown";
    const { charter, model } = r.job;
    lines.push(
      `| ${model} | ${charter.slug} | ${charter.target} | ${charter.agent} | ${r.exitCode} (${meaning}) | ${r.ended} | ${issues} | ${r.findings.length - issues} |`
    );
  }
  const all = results.flatMap((r) => r.findings.map((f) => ({ ...f, job: r.job })));
  all.sort((a, b) => (a.kind === b.kind ? b.severity - a.severity : a.kind === "issue" ? -1 : 1));
  for (const f of all) {
    const dir = `${f.job.modelDir}/${f.job.charter.slug}`;
    lines.push(
      "",
      `## [${f.kind} ${f.severity}/5] ${f.title}`,
      "",
      `- Model: \`${f.job.model}\`, charter: \`${f.job.charter.slug}\` (details and evidence: \`${dir}/summary.md\`, video under \`${dir}/artifacts/\`)`,
      ...(f.path ? [`- Path: \`${f.path}\``] : []),
      `- Expected: ${f.expected}`,
      `- Actual: ${f.actual}`,
      "- Steps:",
      ...f.reproduction.map((step, i) => `  ${i + 1}. ${step}`)
    );
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

/** Opus 5.5 and Sonnet 5.5: see the header comment for why both. */
const DEFAULT_MODELS = ["anthropic:claude-opus-5-5", "anthropic:claude-sonnet-5-5"];

function readModels(): string[] {
  const raw = process.env.BUGBASH_MODELS ?? DEFAULT_MODELS.join(",");
  const models = raw
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m !== "");
  assert(models.length > 0, "BUGBASH_MODELS is empty");
  for (const model of models) {
    // e2e.config.ts validates the provider and model again inside each explorer.
    assert(/^[a-z]+:\S+$/.test(model), `BUGBASH_MODELS entry must be <provider>:<model>: ${model}`);
  }
  assert(new Set(models).size === models.length, "BUGBASH_MODELS lists a model twice");
  return models;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      charters: { type: "string" },
      only: { type: "string" },
      // Total explorers at once across all models (4 per model by default).
      parallel: { type: "string", default: "8" },
      "max-steps": { type: "string", default: "6" },
    },
  });
  const parallel = Number(values.parallel);
  const maxSteps = Number(values["max-steps"]);
  assert(Number.isInteger(parallel) && parallel >= 1, "--parallel must be a positive integer");
  assert(Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 12, "--max-steps is 1-12");

  let charters = readCharters(
    values.charters != null ? path.resolve(values.charters) : path.join(projectDir, "charters.txt")
  );
  if (values.only != null) {
    const wanted = values.only.split(",").map((s) => s.trim());
    const unknown = wanted.filter((slug) => !charters.some((c) => c.slug === slug));
    assert(unknown.length === 0, `unknown charter slug(s): ${unknown.join(", ")}`);
    charters = charters.filter((c) => wanted.includes(c.slug));
  }
  assert(charters.length > 0, "no charters selected");

  const models = readModels();
  // Must match the default in e2e.config.ts; it only labels the output here.
  const effort = process.env.BUGBASH_EFFORT ?? "medium";
  const node = process.env.E2E_NODE ?? "node";
  await checkNodeVersion(node);
  for (const built of ["dist/cli/index.js", "dist/index.html"]) {
    assert(fs.existsSync(path.join(repoRoot, built)), `${built} is missing: run \`make build\``);
  }

  const runRel = `.e2e/bugbash/${new Date().toISOString().replace(/[:.]/g, "-")}-${effort}`;
  const runDir = path.join(projectDir, runRel);
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  // Not recursive: a second bug bash started in the same millisecond fails here, not mid-run.
  fs.mkdirSync(runDir);

  // Interleave models, so every model starts while the pool is still filling.
  const jobs: Job[] = charters.flatMap((charter) =>
    models.map((model) => ({ charter, model, modelDir: model.replace(/[^a-zA-Z0-9.-]+/g, "_") }))
  );
  for (const modelDir of new Set(jobs.map((j) => j.modelDir))) {
    fs.mkdirSync(path.join(runDir, modelDir));
  }
  console.log(
    `Bug bash: ${charters.length} charter(s) x ${models.length} model(s) (${models.join(", ")}), effort ${effort}, ${parallel} at a time -> ${runDir}`
  );

  const results: CharterResult[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const job = jobs[next++];
      const name = `${job.charter.slug} [${job.model}]`;
      console.log(`  started  ${name} (${job.charter.target}, ${job.charter.agent})`);
      const exitCode = await runCharter(node, job, runRel, maxSteps);
      const result = readResult(job, runRel, exitCode);
      results.push(result);
      console.log(
        `  finished ${name}: exit ${exitCode}, ${result.findings.length} finding(s), log ${path.join(projectDir, outRelFor(job, runRel))}.log`
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));

  results.sort((a, b) => jobs.indexOf(a.job) - jobs.indexOf(b.job));
  const findingsFile = path.join(runDir, "findings.md");
  writeFindings(findingsFile, results, models, effort);
  console.log(`Findings: ${findingsFile}`);
  process.exit(Math.max(0, ...results.map((r) => (r.exitCode >= 2 ? r.exitCode : 0))));
}

await main();
