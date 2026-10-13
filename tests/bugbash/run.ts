/**
 * Agent bug bash: runs one TesterArmy `e2e explore` per charter and explorer model, each in its
 * own bug-bash sandbox container with a disposable Xum server (sandbox/launch.ts, #5714), then
 * merges every explorer's findings into one Markdown file. No e2e process runs on the host: the
 * host pause (hostPause.ts) still refuses `e2e explore` everywhere but in the sandbox.
 *
 * Each explorer reaches its model only through a provider proxy that the launcher runs for its
 * job. One list-price budget (BUGBASH_BUDGET_USD, required) covers the whole run, and
 * ANTHROPIC_API_KEY plus ANTHROPIC_BASE_URL stay on the host. A proxy fault (a call that costs
 * more than its bound, a call record that was not written) stops the run at once (exit 5).
 *
 * Usage: make bug-bash [BUGBASH_ARGS="--only composer,settings --parallel 4 --max-steps 6"], or
 *        bun tests/bugbash/run.ts [--charters <file>] [--only <slug,...>] [--parallel 8]
 *          [--max-steps 6]
 * --charters: a branch-specific charter file (same format), instead of tests/bugbash/charters.txt.
 * --config: e2e.mcpapps.config.ts (its seed and explorer context) instead of the default
 *   e2e.config.ts. No other config runs in the sandbox (sandbox/inputs.ts exploreRefusal).
 *   Paths are relative to the current directory.
 *
 * Models: BUGBASH_MODELS, comma-separated `anthropic:<model>`, default Sonnet 5.5 alone (6 jobs).
 * In a three-model comparison (2026-10) Opus 5.5 and Sonnet 5.5 together found 14 of 15 distinct
 * bugs and overlapped on only 4; GPT-6.1 Sol found 1. Opus about doubles the cost of a run, so it
 * is opt-in: BUGBASH_MODELS=anthropic:claude-sonnet-5-5,anthropic:claude-opus-5-5. Every model
 * runs every charter, all in one pool of --parallel explorers. Reasoning: BUGBASH_EFFORT, default
 * medium (e2e.config.ts).
 *
 * Cost: before any job, the run prints its estimate and a recommended budget (estimateRun), and
 * refuses a BUGBASH_BUDGET_USD below it.
 *
 * Charters: tests/bugbash/charters.txt. Config and personas: tests/bugbash/e2e.config.ts.
 * Output: tests/bugbash/.e2e/bugbash/<run>/<model>/ with one directory, log and app log per
 * charter, and <run>/findings.md for all models. Findings are explorer claims, not confirmed bugs:
 * verify each one with a failing repro test (`e2e guide bug-bash`, steps 5-6, and the bug-bash
 * project skill).
 *
 * App AI: BUGBASH_AI (auto, real or mock; default auto, see aiMode.ts). The run resolves it once,
 * on the host: the probe goes through a proxy and the run's budget (sandbox/launch.ts probeApp),
 * never straight to the provider. In real mode each job's app reaches BUGBASH_APP_MODEL (default
 * Haiku 4.5, Anthropic only) through that job's proxy. Charters that name a `[mock:...]` prompt
 * only work against the mock, so they always run with it. findings.md records each mode.
 *
 * Exit code: 0 when every charter ran (with or without findings). Else, in this order: 3 when a
 * container state is unknown after cleanup, 130 or 143 after SIGINT or SIGTERM, 5 after a proxy
 * fault, and otherwise the highest code among the charters (2 refused or setup, 3, 4).
 */
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_APP_MODEL } from "./aiMode";
import { EXPLORE_CONFIGS } from "./sandbox/inputs";
import {
  checkDocker,
  JOB_EXIT_3,
  type JobOutcome,
  cannotReach,
  keyRejected,
  launchJob,
  type ModelJob,
  modelJob,
  probeApp,
  probeUnreachable,
} from "./sandbox/launch";
import { Ledger, listPrice, priced, worstCaseNanoUsd } from "./sandbox/proxyPolicy";
import { Refusal, Stopped } from "./sandbox/runner";

const projectDir = import.meta.dir;
// Real path: the launcher labels and stages the checkout by it.
const repoRoot = fs.realpathSync(path.resolve(projectDir, "../.."));
interface AppAi {
  mode: "mock" | "real";
  reason: string;
}

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
  /** `anthropic:<model>`: the launcher passes it to the container as BUGBASH_MODEL. */
  model: string;
  /** Path-safe form of `model`: the per-model output directory. */
  modelDir: string;
  /** The app's AI for this charter (the run's mode, or the mock for `[mock:...]` charters). */
  ai: AppAi;
}

interface CharterResult {
  job: Job;
  exitCode: number;
  ended: string;
  /** Exploration steps that ran; 0 means the charter explored nothing. */
  steps: number;
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

function outRelFor(job: Job, runRel: string): string {
  return `${runRel}/${job.modelDir}/${job.charter.slug}`;
}

/** The e2e args of one charter: the explore allowlist of the launcher (sandbox/inputs.ts). */
function exploreArgs(config: string, job: Job, runRel: string, maxSteps: number): string[] {
  const { charter } = job;
  // prettier-ignore
  return ["explore", charter.goal, "--config", config, "--target", charter.target,
    "--agent", charter.agent, "--output", outRelFor(job, runRel), "--max-steps", String(maxSteps),
    "--video=on", "--reporter", "list,markdown"];
}

function readResult(job: Job, runRel: string, exitCode: number): CharterResult {
  const reportPath = path.join(projectDir, outRelFor(job, runRel), "report.json");
  if (!fs.existsSync(reportPath)) {
    return { job, exitCode, ended: "no report", steps: 0, findings: [] };
  }
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
    run?: { explore?: { ended: string; steps?: unknown[]; findings: Finding[] } };
  };
  const explore = report.run?.explore;
  return {
    job,
    exitCode,
    ended: explore?.ended ?? "no explore record",
    steps: explore?.steps?.length ?? 0,
    findings: explore?.findings ?? [],
  };
}

const EXIT_MEANING: Record<number, string> = {
  0: "ran, no issues",
  1: "issues reported, or no step ran",
  2: "setup error or refused",
  3: "infrastructure error, or the container state is unknown",
  4: "e2e internal error, or incomplete evidence",
  5: "proxy fault",
  6: "e2e infrastructure error",
  130: "interrupted",
};

/**
 * One charter's code, with the launcher's precedence (sandbox/launch.ts exitFor): an unknown
 * container state (3), then a stop (130), then a proxy fault (5), then a refusal (2) or an
 * error (4), then the job's own code (e2e's 3 as 6, so 3 means only an unknown container).
 */
function charterCode(outcome: JobOutcome): number {
  if (outcome.cleanup.startsWith("unknown")) return 3;
  if (outcome.stopped != null) return 130;
  if (outcome.proxyFault != null) return 5;
  if ("error" in outcome) return outcome.error instanceof Refusal ? 2 : 4;
  return outcome.code === 3 ? JOB_EXIT_3 : outcome.code!;
}

const usd = (nanoUsd: number) => `$${(nanoUsd / 1e9).toFixed(4)}`;

function writeFindings(
  file: string,
  results: CharterResult[],
  models: string[],
  effort: string,
  ledger: Ledger,
  runAi: AppAi
): void {
  const lines = ["# Bug bash findings", ""];
  const { calls, refused, spentNanoUsd, capNanoUsd, tokens } = ledger.totals();
  const perModel = Object.entries(tokens).map(
    ([model, t]) =>
      `\`${model}\` ${t.input} in, ${t.cacheWrite} cache write, ${t.cacheRead} cache read, ${t.output} out`
  );
  lines.push(
    "Explorer claims, not confirmed bugs. Verify each with a failing repro test before reporting it.",
    "The same defect can appear once per model: merge those before triage.",
    "",
    `Explorer models: ${models.map((m) => `\`${m}\``).join(", ")}. Effort: \`${effort}\`.`,
    `App AI: \`${runAi.mode}\` (${runAi.reason}); charters that name a \`[mock:...]\` prompt use the mock.`,
    // List price from the reported usage, not the bill (sandbox/proxyPolicy.ts).
    `Cost: ${calls} proxied calls, ${refused} refused by the budget, ${usd(spentNanoUsd)} of ` +
      `${usd(capNanoUsd)} at list price. Tokens: ${perModel.join("; ") || "none"}.`,
    "",
    "| Model | Charter | Target | Agent | App AI | Exit | Ended | Issues | Warnings |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const r of results) {
    const issues = r.findings.filter((f) => f.kind === "issue").length;
    const meaning = EXIT_MEANING[r.exitCode] ?? "unknown";
    const { charter, model } = r.job;
    lines.push(
      `| ${model} | ${charter.slug} | ${charter.target} | ${charter.agent} | ${r.job.ai.mode} | ${r.exitCode} (${meaning}) | ${r.ended} | ${issues} | ${r.findings.length - issues} |`
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

/** Sonnet 5.5 alone: see the header comment for why Opus is opt-in. */
const DEFAULT_MODELS = ["anthropic:claude-sonnet-5-5"];

/**
 * Measured list-price cost of one charter at --max-steps 6 and medium effort, explorer and app AI
 * together: four `make bug-bash` runs of Sonnet 5.5 on #5714, #6076 and #6079 averaged $0.34 to
 * $0.52 per charter (21 charters, $9.50 in all).
 */
const MEASURED_USD_PER_JOB: Record<string, number> = { "claude-sonnet-5-5": 0.45 };
const MEASURED_STEPS = 6;
/** An unmeasured model: Sonnet's measured cost, scaled by list price, times this margin. */
const UNMEASURED_MARGIN = 2;
/**
 * Explorer cost per charter relative to medium effort, where it was measured. Higher efforts add
 * thinking tokens; nothing measured them, so these are guesses, and the run labels them so. Low
 * is not lowered: an estimate must not undercount.
 */
const EFFORT_FACTOR: Record<string, number> = { low: 1, medium: 1, high: 2, xhigh: 3, max: 4 };

/**
 * The real app AI's own share per charter with Haiku 4.5, the default app model: #6079's five
 * real-mode charters spent 19,545 input and 1,022 output tokens on it, about $0.005 each. That
 * share is already in the explorer measurement above, so only another app model adds to it.
 */
const MEASURED_APP_USD_PER_JOB = 0.005;

/**
 * The run's cost estimate and the budget it needs. The estimate scales the measured cost per
 * charter linearly with --max-steps. The headroom covers the reservations of the calls in flight:
 * one per running explorer, each at the largest bound the proxy can reserve (proxyPolicy.ts).
 * Without it, the last jobs of a run that fits its estimate find the budget reserved and fail.
 * `appModel` is the app's model when its AI can be real (the probe decides later, so the check
 * assumes it is): its calls share the ledger, so its bound counts too, and a model other than the
 * measured Haiku 4.5 adds a guessed share per charter.
 */
export function estimateRun(o: {
  models: string[];
  charters: number;
  parallel: number;
  maxSteps: number;
  effort: string;
  appModel?: string;
}) {
  const { models, charters, parallel, maxSteps, appModel } = o;
  const effortFactor = EFFORT_FACTOR[o.effort];
  assert(effortFactor != null, `estimateRun: unknown effort ${o.effort}`);
  const sonnet = listPrice("claude-sonnet-5-5")!;
  const perModel = models.map((spec) => {
    const id = spec.split(/:(.*)/s, 2)[1];
    const measured = MEASURED_USD_PER_JOB[id];
    const perJob =
      (measured ??
        (MEASURED_USD_PER_JOB["claude-sonnet-5-5"] * listPrice(id)!.output * UNMEASURED_MARGIN) /
          sonnet.output) *
      (maxSteps / MEASURED_STEPS) *
      effortFactor;
    // Measured means: this model, at the effort of the measurement.
    return { spec, perJob, measured: measured != null && o.effort === "medium" };
  });
  const appId = appModel?.split(/:(.*)/s, 2)[1];
  const haiku = listPrice(DEFAULT_APP_MODEL.split(":")[1])!;
  const appPerJob =
    appId == null || appModel === DEFAULT_APP_MODEL
      ? 0
      : ((MEASURED_APP_USD_PER_JOB * listPrice(appId)!.output * UNMEASURED_MARGIN) / haiku.output) *
        (maxSteps / MEASURED_STEPS);
  const jobs = charters * models.length;
  // Each job runs its own app, so the app's share counts once per job.
  const estimateUsd = perModel.reduce((sum, m) => sum + m.perJob * charters, 0) + appPerJob * jobs;
  const inFlight = Math.min(parallel, jobs);
  const ids = [...models.map((spec) => spec.split(/:(.*)/s, 2)[1]), ...(appId ? [appId] : [])];
  const worst = Math.max(...ids.map(worstCaseNanoUsd));
  const headroomUsd = (inFlight * worst) / 1e9;
  // Whole dollars, so the number is easy to type.
  const recommendedUsd = Math.ceil(estimateUsd + headroomUsd);
  const app = appPerJob > 0 ? { spec: appModel!, perJob: appPerJob } : undefined;
  return { perModel, app, estimateUsd, headroomUsd, inFlight, recommendedUsd };
}

function modelDirName(model: string): string {
  return model.replace(/[^a-zA-Z0-9.-]+/g, "_");
}

function readModels(env: NodeJS.ProcessEnv): string[] {
  const raw = env.BUGBASH_MODELS ?? DEFAULT_MODELS.join(",");
  const models = raw
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m !== "");
  assert(models.length > 0, "BUGBASH_MODELS is empty");
  for (const model of models) {
    // The launcher checks each model again (provider, price) before any docker command.
    assert(/^[a-z]+:\S+$/.test(model), `BUGBASH_MODELS entry must be <provider>:<model>: ${model}`);
  }
  assert(new Set(models).size === models.length, "BUGBASH_MODELS lists a model twice");
  // Each model writes to its own output folder; two specs that map to one folder would overwrite
  // each other's reports and logs.
  const dirs = new Set(models.map(modelDirName));
  assert(dirs.size === models.length, "two BUGBASH_MODELS entries map to the same output folder");
  return models;
}

/** A job's mode env for the launcher (sandbox/launch.ts appAi): resolved here, never by it. */
function jobMode(ai: AppAi, appModel: string): Record<string, string | undefined> {
  return ai.mode === "real"
    ? { BUGBASH_AI: "real", BUGBASH_AI_RESOLVED: "real", BUGBASH_AI_REASON: ai.reason,
        BUGBASH_APP_MODEL: appModel } // prettier-ignore
    : { BUGBASH_AI: "mock", BUGBASH_AI_RESOLVED: undefined, BUGBASH_AI_REASON: ai.reason };
}

/** Injection point: run.test.ts passes a fake launcher; production runs the sandbox. */
export interface RunDeps {
  launchJob: typeof launchJob;
  probeApp?: typeof probeApp;
  checkDocker?: typeof checkDocker;
  /** Progress lines (default stdout) and problems (default stderr). */
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * The whole run; returns its exit code. `stop` is aborted with the signal name by the entry
 * point. Refuses (exit 2) before any folder, job or provider request when the run cannot work.
 */
export async function runBugBash(
  argv: string[],
  env: NodeJS.ProcessEnv,
  stop: AbortSignal,
  deps: RunDeps = { launchJob }
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  // The run resolves the app AI itself, through its budget: refuse a mode resolved elsewhere.
  const requested = env.BUGBASH_AI ?? "auto";
  if (!["auto", "real", "mock"].includes(requested)) {
    err(`make bug-bash: BUGBASH_AI must be auto, real or mock, got "${requested}"`);
    return 2;
  }
  if (env.BUGBASH_AI_RESOLVED != null && env.BUGBASH_AI_RESOLVED !== "mock") {
    err("make bug-bash: unset BUGBASH_AI_RESOLVED: the run probes the app AI through its proxy");
    return 2;
  }
  const { values } = parseArgs({
    args: argv,
    options: {
      charters: { type: "string" },
      config: { type: "string" },
      only: { type: "string" },
      // Total explorers (containers) at once across all models.
      parallel: { type: "string", default: "8" },
      "max-steps": { type: "string", default: "6" },
      // The Makefile's check before the build: every check below, Docker too, then exit 0.
      preflight: { type: "boolean", default: false },
    },
  });
  const parallel = Number(values.parallel);
  const maxSteps = Number(values["max-steps"]);
  assert(Number.isInteger(parallel) && parallel >= 1, "--parallel must be a positive integer");
  assert(Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 12, "--max-steps is 1-12");

  // e2e runs in projectDir: pass the config relative to it.
  const config =
    values.config != null
      ? path.relative(projectDir, path.resolve(values.config))
      : "e2e.config.ts";
  assert(fs.existsSync(path.join(projectDir, config)), `--config not found: ${config}`);
  // The launcher runs only the two bug-bash configs: refuse another one here, before any folder.
  if (!EXPLORE_CONFIGS.includes(config)) {
    err(`make bug-bash: --config ${config}: only ${EXPLORE_CONFIGS.join(" or ")} run (#5714)`);
    return 2;
  }

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

  // run.ts reads BUGBASH_MODELS; the launcher's BUGBASH_MODEL would be ignored without a word.
  if ((env.BUGBASH_MODEL ?? "") !== "") {
    err("make bug-bash: unset BUGBASH_MODEL: use BUGBASH_MODELS=anthropic:<model>[,...]");
    return 2;
  }
  const models = readModels(env);
  // Must match the default in e2e.config.ts; it only labels the output here.
  const effort = env.BUGBASH_EFFORT ?? "medium";
  // The effort becomes part of the output path, so check it before any directory exists. The same
  // list as e2e.config.ts, which checks it again inside each explorer.
  assert(
    ["low", "medium", "high", "xhigh", "max"].includes(effort),
    `BUGBASH_EFFORT must be one of low, medium, high, xhigh, max, got "${effort}"`
  );
  // Every model, the budget and the provider settings, before any folder or job (launch.ts).
  let job0: ModelJob | undefined;
  try {
    for (const model of models)
      job0 = modelJob({ ...env, BUGBASH_MODEL: model }, "BUGBASH_MODELS entry");
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    err(`make bug-bash: ${error.message}`);
    return 2;
  }
  const budgetUsd = job0!.budgetUsd;
  // The app AI can be real unless it is pinned to the mock (see the probe below).
  const appReal = requested !== "mock" && !charters.every((c) => c.goal.includes("[mock:"));
  const appSpec = env.BUGBASH_APP_MODEL ?? DEFAULT_APP_MODEL;
  const appPriced = appSpec.startsWith("anthropic:") && priced(appSpec.slice("anthropic:".length));
  const cost = estimateRun({
    models,
    charters: charters.length,
    parallel,
    maxSteps,
    effort,
    appModel: appReal && appPriced ? appSpec : undefined,
  });
  const per = cost.perModel.map(
    (m) => `${m.spec} $${m.perJob.toFixed(2)}${m.measured ? "" : " (not measured: a guess)"}`
  );
  if (cost.app)
    per.push(
      `app ${cost.app.spec} +$${cost.app.perJob.toFixed(2)} per job (not measured: a guess)`
    );
  out(
    `Estimate: $${cost.estimateUsd.toFixed(2)} for ${charters.length} charter(s) x ${models.length} model(s) ` +
      `(per charter: ${per.join(", ")}), plus $${cost.headroomUsd.toFixed(2)} headroom for ` +
      `${cost.inFlight} call(s) in flight. Recommended budget: $${cost.recommendedUsd}.`
  );
  if (budgetUsd < cost.recommendedUsd) {
    err(
      `make bug-bash: set BUGBASH_BUDGET_USD to at least $${cost.recommendedUsd} (it is $${budgetUsd}), ` +
        "or run fewer charters (--only), fewer at a time (--parallel) or fewer models"
    );
    return 2;
  }
  // One budget for the whole run: every job's proxy reserves from it (sandbox/proxyPolicy.ts).
  const ledger = new Ledger(budgetUsd);
  const mockPin: AppAi = { mode: "mock", reason: "the charter names a [mock:...] prompt" };
  const needsMock = (charter: Charter) => charter.goal.includes("[mock:");
  const appModel = env.BUGBASH_APP_MODEL ?? DEFAULT_APP_MODEL;
  const probing = requested !== "mock" && !charters.every(needsMock);
  const [provider, id] = appModel.split(/:(.*)/s, 2);
  if (probing && (provider !== "anthropic" || !id || !priced(id))) {
    err(`make bug-bash: BUGBASH_APP_MODEL "${appModel}": only a priced anthropic:<model> runs`);
    return 2;
  }
  // Docker once for the run, before the probe and any folder: not once per charter.
  try {
    const state = await (deps.checkDocker ?? checkDocker)({ root: repoRoot, stop });
    if (state.startsWith("unknown")) {
      err(`make bug-bash: Docker check cleanup: ${state}`);
      return 3;
    }
  } catch (error) {
    if (error instanceof Stopped) return stop.reason === "SIGTERM" ? 143 : 130;
    if (!(error instanceof Refusal)) throw error;
    err(`make bug-bash: ${error.message}`);
    return 2;
  }
  if (values.preflight) return 0;
  let runAi: AppAi = { mode: "mock", reason: "BUGBASH_AI=mock" };
  let probeRecords: object[] = [];
  // The app model when the app AI may be real; else an explorer model: the explorers need the
  // upstream in every mode, so even a mock run probes it once.
  const probeModel = probing ? id : job0!.model;
  let status: number;
  try {
    ({ status, records: probeRecords } = await (deps.probeApp ?? probeApp)(
      job0!,
      probeModel,
      ledger,
      stop
    ));
  } catch (error) {
    // The probe's own proxy fault (a bound miss): the cost model is wrong.
    err(`make bug-bash: probe: ${error instanceof Error ? error.message : String(error)}`);
    return 5;
  }
  // A stop during the probe ends the run here, before any folder or job.
  if (stop.aborted) return stop.reason === "SIGTERM" ? 143 : 130;
  // No explorer works without the upstream either, so this refuses in every mode.
  if (probeUnreachable(probeRecords)) {
    err(`make bug-bash: ${cannotReach(job0!)}: check the URL and the network`);
    return 2;
  }
  // A rejected key too, in every mode: each explorer call would fail and keep its reservation.
  const rejected = keyRejected(job0!, status, probeRecords, {
    model: probeModel,
    variable: probing ? "BUGBASH_APP_MODEL" : "BUGBASH_MODELS",
  });
  if (rejected != null) {
    err(`make bug-bash: ${rejected}`);
    return 2;
  }
  if (probing) {
    const unavailable = status === 429 || status >= 500;
    if (status === 200) runAi = { mode: "real", reason: `${appModel} answered the probe` };
    else if (requested === "auto" && unavailable)
      runAi = { mode: "mock", reason: `upstream unavailable (probe HTTP ${status})` };
    else if (
      probeRecords.some((r) => String((r as { reason?: unknown }).reason).startsWith("budget:"))
    ) {
      // The proxy refused the probe itself (HTTP 402): no call left, so the key is not at fault.
      err(
        `make bug-bash: BUGBASH_BUDGET_USD ($${budgetUsd}) is too small to cover the ${appModel} probe. Raise it, or set BUGBASH_AI=mock.`
      );
      return 2;
    } else {
      err(
        `make bug-bash: ${appModel} probe failed (HTTP ${status}). Fix the key or base URL, or set BUGBASH_AI=mock.`
      );
      return 2;
    }
  }
  out(`App AI: ${runAi.mode} (${runAi.reason})`);

  // A random suffix: two runs in the same millisecond (run.test.ts runs several) get two folders.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runRel = `.e2e/bugbash/${stamp}-${crypto.randomBytes(3).toString("hex")}-${effort}`;
  const runDir = path.join(projectDir, runRel);
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  // Not recursive: a second bug bash started in the same millisecond fails here, not mid-run.
  fs.mkdirSync(runDir);
  if (probeRecords.length > 0)
    fs.writeFileSync(
      path.join(runDir, "probe.proxy.jsonl"),
      probeRecords.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      { mode: 0o600 }
    );

  // Interleave models, so every model starts while the pool is still filling.
  const jobs: Job[] = charters.flatMap((charter) =>
    models.map((model) => ({
      charter,
      model,
      modelDir: modelDirName(model),
      ai: needsMock(charter) ? mockPin : runAi,
    }))
  );
  for (const modelDir of new Set(jobs.map((j) => j.modelDir))) {
    fs.mkdirSync(path.join(runDir, modelDir));
  }
  out(
    `Bug bash: ${charters.length} charter(s) x ${models.length} model(s) (${models.join(", ")}), effort ${effort}, ${parallel} at a time, budget $${budgetUsd.toFixed(2)} -> ${runDir}`
  );

  // A proxy fault (a call cost more than its bound) means the cost model is wrong: no new job
  // starts, and the running ones stop. Each job's stop follows the run's.
  const halt = new AbortController();
  let fault: string | undefined;
  const onFault = (name: string, reason: string) => {
    if (fault != null) return;
    fault = reason;
    err(`  ${name}: ${reason}. No new charter starts, and the running ones stop.`);
    halt.abort("proxy fault");
  };
  let unknownCleanup = false;
  const results: CharterResult[] = [];
  let next = 0;
  /** Jobs that ended in a refusal with a known cleanup: nothing else to keep for them. */
  let refused = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length && !stop.aborted && !halt.signal.aborted) {
      const job = jobs[next++];
      const name = `${job.charter.slug} [${job.model}]`;
      const outRel = outRelFor(job, runRel);
      out(`  started  ${name} (${job.charter.target}, ${job.charter.agent})`);
      const fd = fs.openSync(path.join(projectDir, `${outRel}.log`), "w");
      const jobStop = AbortSignal.any([stop, halt.signal]);
      let outcome: JobOutcome;
      try {
        outcome = await deps.launchJob(exploreArgs(config, job, runRel, maxSteps), {
          root: repoRoot,
          cwd: projectDir,
          env: { ...env, ...jobMode(job.ai, appModel), BUGBASH_MODEL: job.model },
          stop: jobStop,
          ledger,
          log: (line) => fs.writeSync(fd, `sandbox ${line}\n`),
          stderr: fd,
          // At once, from inside the job: the other jobs must not keep spending until it ends.
          onProxyFault: (reason) => onFault(name, reason),
        });
      } catch (error) {
        // A refusal before any docker command; anything else is a launcher bug.
        outcome = { error, cleanup: "none" };
      }
      // A refusal thrown or returned (a later docker refusal): its reason goes to the charter
      // log and to stderr, or the run shows only "setup error or refused".
      if ("error" in outcome) {
        const { error } = outcome;
        const message = error instanceof Error ? error.message : String(error);
        const what = error instanceof Refusal ? "refused" : "failed";
        fs.writeSync(fd, `sandbox ${what}: ${message}\n`);
        err(`  ${name}: ${what}: ${message}`);
        if (error instanceof Refusal && !outcome.cleanup.startsWith("unknown")) refused += 1;
      }
      fs.closeSync(fd);
      if (outcome.cleanup.startsWith("unknown")) unknownCleanup = true;
      // A fault that close() found (a call that outlived it) has no earlier signal.
      if (outcome.proxyFault != null) onFault(name, outcome.proxyFault);
      const result = readResult(job, runRel, charterCode(outcome));
      // The app logs the mode it really started in. A mismatch means the mode never reached it
      // (e2e passes the app only `command.env`), so the charter tested something else: fail it.
      const appLog = path.join(projectDir, outRel, "app.log");
      const started = fs.existsSync(appLog)
        ? /app AI: (real|mock)/.exec(fs.readFileSync(appLog, "utf8"))?.[1]
        : undefined;
      if (started != null && started !== job.ai.mode) {
        err(`  ${name}: app started with ${started} AI, expected ${job.ai.mode}`);
        result.exitCode = Math.max(result.exitCode, 2);
      }
      results.push(result);
      out(
        `  finished ${name}: exit ${result.exitCode}, ${result.findings.length} finding(s), log ${path.join(projectDir, outRel)}.log`
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));

  results.sort((a, b) => jobs.indexOf(a.job) - jobs.indexOf(b.job));
  // Every charter refused and nothing was spent: the folder would hold only the refusals that
  // stderr already shows. A run that made a proxied call keeps it, as the record of that call.
  // A launcher error or an unknown cleanup keeps the folder: its logs are the diagnostics.
  if (refused === jobs.length && !stop.aborted && fault == null && ledger.totals().calls === 0) {
    fs.rmSync(runDir, { recursive: true, force: true });
    err("Every charter refused: no run folder kept.");
    return Math.max(2, ...results.map((r) => r.exitCode));
  }
  const findingsFile = path.join(runDir, "findings.md");
  writeFindings(findingsFile, results, models, effort, ledger, runAi);
  out(`Findings: ${findingsFile}`);
  const { spentNanoUsd, capNanoUsd } = ledger.totals();
  out(`Cost: ${usd(spentNanoUsd)} of ${usd(capNanoUsd)} at list price`);
  // Exit 1 means "issues reported" or "no step ran". Only the first is a finished charter: a
  // charter that explored nothing fails the run even when its exit code is 1.
  const failures = results.map((r) => (r.exitCode >= 2 ? r.exitCode : r.steps === 0 ? 1 : 0));
  for (const r of results.filter((r) => r.exitCode < 2 && r.steps === 0)) {
    err(`  no exploration step ran: ${r.job.charter.slug} [${r.job.model}] (${r.ended})`);
  }
  // The launcher's precedence for the whole run: an unknown container state, then a stop (a
  // stopped run is incomplete, whatever the finished charters reported), then a proxy fault.
  if (unknownCleanup) return 3;
  if (stop.aborted) return stop.reason === "SIGTERM" ? 143 : 130;
  if (fault != null) return 5;
  // No run-level stop and no halt came, so a charter's 130 is its own failure: keep it.
  return Math.max(0, ...failures);
}

if (import.meta.main) {
  // A SIGINT or SIGTERM sent to this orchestrator alone (a CI timeout, a task runner cancel)
  // must stop every job too, or containers and paid model calls keep running.
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => controller.abort(signal));
  process.exit(await runBugBash(process.argv.slice(2), process.env, controller.signal));
}
