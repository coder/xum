/**
 * Runs one bug-bash e2e job in a disposable container: the bug-bash sandbox (#5714).
 * Usage, from tests/bugbash, with BUGBASH_AI=mock:
 *   bun sandbox/launch.ts -- run --config e2e.config.ts --output .e2e/<folder> [e2e args...]
 *   bun sandbox/launch.ts -- run --config e2e.mcpapps.config.ts --output .e2e/<folder> [...]
 *   bun sandbox/launch.ts -- explore "<goal>" --config e2e.config.ts --output .e2e/<folder> [...]
 *   bun sandbox/launch.ts -- self-check [--export-fixture traversal|oversize] --output .e2e/<folder>
 *     (selfCheckRun.ts, `make bug-bash-sandbox-check`, against a fake upstream)
 *   bun sandbox/launch.ts --recover   (make bug-bash-sandbox-recover; see recover())
 *
 * The container runs the e2e CLI, Chromium and the seeded app with the pinned image (runner.ts).
 * It gets no network, no capabilities, a read-only root, copies of the git-listed inputs, and
 * read-only dist/ and node_modules/ (inputs.ts). Its output folder, the app log included, comes
 * back on its stdout as an export stream (exportStream.ts).
 *
 * Three job kinds run, with the mock app AI unless run.ts resolved the real one for explore. An exact-step repro run gets no model. The MCP
 * Apps suite and an `e2e explore` charter (run.ts, `make bug-bash`) are model-driven: their
 * explorer reaches BUGBASH_MODEL (default Sonnet 5.5) only through a provider proxy (proxy.ts)
 * that this process runs for the job, on a unix socket that the container gets read-only. The
 * provider key stays here, and BUGBASH_BUDGET_USD caps the spend at list price (not a billing
 * cap: the upstream key's own limit is the backstop); run.ts shares one budget across its jobs.
 * The proxy writes one record per call to `<output>.proxy.jsonl` on the host only. In an explore
 * job with the real app AI (run.ts resolves it with probeApp()), the app reaches
 * BUGBASH_APP_MODEL through the same proxy. The host pause still refuses every model-driven run
 * on the host. There is no host fallback.
 * Exit codes: the job's code, 2 refused, 3 the container state is unknown after cleanup, 4 the
 * evidence is incomplete, 5 the proxy reported a fault (a call cost more than its bound, or a
 * call outlived close()), 6 the job itself exited 3 (e2e's infrastructure error, moved so that 3
 * means only an unknown container), 130 or 143 when SIGINT or SIGTERM stopped it. Exit 3
 * outranks a stop, and a stop outranks 5.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { receiveExport } from "./exportStream";
import { PROXY_DIR } from "./inContainer";
import { startProxy, UNREACHABLE } from "./proxy";
import { Ledger, priced } from "./proxyPolicy";
// prettier-ignore
import { checkMountSource, containerEnv, exactStepRefusal, exploreRefusal, jobEnv, outputDir, plainFolders, stage } from "./inputs";
import { type CleanupState, Refusal, Session, Stopped } from "./runner";
import { DEFAULT_APP_MODEL } from "../aiMode";

const ROOT = fs.realpathSync(path.resolve(import.meta.dir, "../../.."));
const DEADLINE_MS = 30 * 60_000;
const logLine = (message: string) => console.error(`sandbox ${message}`);
const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const bootId = () => fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const pidNamespace = () => fs.readlinkSync("/proc/self/ns/pid").replace(/\D/g, "");
/** The checkout label: the first 12 hex of the sha256 of its real path. Job names hold 6. */
const checkoutId = (root: string) => sha(root).slice(0, 12);
/**
 * The fields of /proc/<pid>/stat after the command name: [0] the state, [19] the start time in
 * clock ticks. Undefined when the PID is gone.
 */
function procStat(pid: string): string[] | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Only the mock app AI runs in the sandbox, except in an `e2e explore` job whose caller (run.ts)
 * resolved the real app AI on the host (BUGBASH_AI_RESOLVED=real): that job's app reaches
 * BUGBASH_APP_MODEL through the job's proxy (aiMode.ts), and no key enters. Otherwise both mode
 * names must be mock or unset, and one must be mock: an ambient BUGBASH_AI_RESOLVED=real refuses.
 */
type AppAi = { mode: "mock" } | { mode: "real"; model: string; reason: string };
function appAi(env: NodeJS.ProcessEnv, explore: boolean): AppAi {
  const modes = [env.BUGBASH_AI, env.BUGBASH_AI_RESOLVED];
  if (modes.includes("mock") && modes.every((mode) => mode == null || mode === "mock"))
    return { mode: "mock" };
  if (!explore || env.BUGBASH_AI_RESOLVED !== "real" || !["real", "auto", undefined].includes(env.BUGBASH_AI))
    throw new Refusal(
      "only the mock app AI runs here (#5714): set BUGBASH_AI=mock, or run make bug-bash for the real one"
    ); // prettier-ignore
  const spec = env.BUGBASH_APP_MODEL ?? DEFAULT_APP_MODEL;
  const [provider, model] = spec.split(/:(.*)/s, 2);
  if (provider !== "anthropic" || !model || !priced(model))
    throw new Refusal(
      `BUGBASH_APP_MODEL ${JSON.stringify(spec)}: only a priced anthropic:<model> runs here`
    );
  return { mode: "real", model, reason: env.BUGBASH_AI_REASON ?? "resolved by the caller" };
}
/** The container's mode env, whatever else the host env holds. */
const modeEnv = (ai: AppAi): Record<string, string> =>
  ai.mode === "mock"
    ? { BUGBASH_AI: "mock", BUGBASH_AI_RESOLVED: "mock" }
    : { BUGBASH_AI: "real", BUGBASH_AI_RESOLVED: "real", BUGBASH_AI_REASON: ai.reason,
        BUGBASH_APP_MODEL: `anthropic:${ai.model}` }; // prettier-ignore
const MCP_APPS_CONFIG = "e2e.mcpapps.config.ts";
const MCP_APPS_MODEL = "anthropic:claude-sonnet-5-5";

/** The explorer model, the spend cap and the upstream of a model-driven job. */
export interface ModelJob {
  model: string;
  budgetUsd: number;
  upstream: { baseUrl: string; apiKey: string };
}

/**
 * Reads a model-driven job from the host env, before any docker command. Refusal texts never
 * hold the key or the base URL.
 */
export function modelJob(env: NodeJS.ProcessEnv, modelVar = "BUGBASH_MODEL"): ModelJob {
  const spec = env.BUGBASH_MODEL ?? MCP_APPS_MODEL;
  const [provider, model] = spec.split(/:(.*)/s, 2);
  // `modelVar` names the variable the user set (run.ts: a BUGBASH_MODELS entry).
  const named = `${modelVar} ${JSON.stringify(spec)}`;
  if (provider !== "anthropic" || !model)
    throw new Refusal(`${named}: only anthropic:<model> runs here`);
  // The proxy refuses every call of a model it cannot price, so the job could only fail.
  if (!priced(model)) throw new Refusal(`${named}: the proxy has no price for it`);
  const budget = env.BUGBASH_BUDGET_USD ?? "";
  if (!/^\d+(\.\d+)?$/.test(budget) || !(Number(budget) > 0))
    throw new Refusal("set BUGBASH_BUDGET_USD: the most this run may spend at list price, in $");
  // bash-ai-proxy needs project automation, which a model-driven job turns off (startApp.ts).
  if ((env.BUGBASH_SCENARIO ?? "") !== "")
    throw new Refusal("BUGBASH_SCENARIO does not run in a model-driven job");
  const apiKey = env.ANTHROPIC_API_KEY ?? "";
  const base = env.ANTHROPIC_BASE_URL ?? "";
  if (apiKey === "" || base === "")
    throw new Refusal("a model-driven job needs ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL");
  if (!URL.canParse(base) || !/^https?:$/.test(new URL(base).protocol))
    throw new Refusal("ANTHROPIC_BASE_URL is not an http(s) URL");
  // Like the app's settings, the base URL may end in /v1; the proxy adds /v1/messages.
  const baseUrl = base.replace(/\/+$/, "").replace(/\/v1$/, "");
  return { model, budgetUsd: Number(budget), upstream: { baseUrl, apiKey } };
}

const usd = (nanoUsd: number) => `$${(nanoUsd / 1e9).toFixed(4)}`;

/** The text of an unreachable upstream. The host only: the base URL's path can hold a token. */
export const cannotReach = (job: ModelJob) =>
  `cannot reach ANTHROPIC_BASE_URL (${new URL(job.upstream.baseUrl).host})`;
/**
 * The text of a probe that the upstream answered 401 or 403: the key is rejected. No explorer
 * can work with it, and every later call would keep its full reservation, so both callers refuse.
 */
export function keyRejected(
  job: ModelJob,
  status: number,
  records: object[],
  probed?: { model: string; variable: string }
) {
  // The upstream's own status from the call record too: a 401 with an HTML or empty body (a
  // gateway's) makes the probe's response unreadable, and probeApp then reports 502.
  const upstream = records.map((r) => (r as { status?: unknown }).status);
  const rejected = [status, ...upstream].find((s) => s === 401 || s === 403);
  if (rejected == null) return undefined;
  const base = `ANTHROPIC_API_KEY rejected by ${new URL(job.upstream.baseUrl).host} (HTTP ${rejected}): check the key`;
  // A 403 can also mean the key may not use the probed model (#6094 item 13).
  return rejected === 403 && probed
    ? `${base}, and its access to ${probed.model} (${probed.variable})`
    : base;
}
/** Whether the proxy released a probe call because it could not connect (proxy.ts). */
export const probeUnreachable = (records: object[]) =>
  records.some((r) => (r as { reason?: unknown }).reason === UNREACHABLE);

/** The app AI probe's deadline: aiMode.ts's probe timeout. */
const PROBE_MS = 10_000;

/**
 * run.ts's app AI probe (aiMode.ts semantics): one `max_tokens: 1` call to the app model through
 * a proxy of its own, with the run's ledger (P7), so even the probe never goes around the policy
 * or the budget. Returns the HTTP status (502 when the upstream failed) and the call records.
 * Rejects when the proxy reports a fault (a bound miss).
 */
export async function probeApp(
  job: ModelJob,
  model: string,
  ledger: Ledger,
  stop: AbortSignal,
  deadlineMs = PROBE_MS
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xum-bugbash-probe-"));
  const records: object[] = [];
  try {
    fs.chmodSync(dir, 0o700);
    const proxy = await startProxy({
      socketPath: path.join(dir, "sock"),
      privateParent: dir, // the probe's own folder, mounted nowhere
      upstream: job.upstream,
      job: { models: [model] },
      ledger,
      // aiMode.ts's probe timeout, not the 10-minute call deadline: a silent upstream counts as
      // unavailable (502) after this.
      deadlineMs,
      log: (entry) => records.push(entry),
    });
    let status: number;
    // A stop (SIGINT, SIGTERM) closes the proxy, which aborts the probe call at once.
    const onStop = () => void proxy.close().catch(() => undefined);
    stop.addEventListener("abort", onStop, { once: true });
    try {
      if (stop.aborted) onStop();
      status = (await proxy.probe(model).catch(() => ({ status: 502 }))).status;
    } finally {
      stop.removeEventListener("abort", onStop);
      await proxy.close();
    }
    return { status, records };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The Docker part of a preflight: the local daemon answers, it is supported, and the pinned
 * image is present (pulled when missing). The Makefile runs it before the build, so a missing
 * daemon refuses in about a second instead of after it. Throws a Refusal (or Stopped); leaves no
 * folder. Returns the cleanup state: an `unknown` one (a process group still runs) outranks a
 * refusal, as in launchJob, and the caller exits 3.
 */
export async function checkDocker(o: { root: string; stop: AbortSignal }): Promise<CleanupState> {
  const session = new Session(o.stop, { root: o.root, log: logLine });
  let failure: { error: unknown } | undefined;
  try {
    await session.ensureImage();
  } catch (error) {
    failure = { error };
  }
  const cleanup = await session.cleanup();
  if (cleanup.startsWith("unknown")) {
    if (failure) logLine(`preflight: ${String(failure.error)}`);
    return cleanup;
  }
  // A stop during the check or its cleanup wins over a refusal or success: no build after it.
  if (o.stop.aborted) throw new Stopped(String(o.stop.reason));
  if (failure) throw failure.error;
  return cleanup;
}

/** Removes the per-checkout folder and its parent once empty: other jobs may still use them. */
function removeEmptyParents(jobDir: string) {
  for (const dir of [path.dirname(jobDir), path.dirname(path.dirname(jobDir))]) {
    try {
      fs.rmdirSync(dir);
    } catch {
      return; // not empty (another job), or already gone
    }
  }
}

// --mount, not -v: a missing source fails instead of creating an empty folder.
function bind(src: string, dst: string): string[] {
  if (src.includes(",")) throw new Refusal(`a comma in a mount path: ${src}`);
  return ["--mount", `type=bind,src=${src},dst=${dst},readonly`];
}

/** boot id : PID namespace : PID : start time of this launcher. ownerState() reads it. */
function ownerLabel(): string {
  return `${bootId()}:${pidNamespace()}:${process.pid}:${procStat(String(process.pid))?.[19]}`;
}

/**
 * Whether the launcher named by an owner label still runs. "dead" needs this boot and this PID
 * namespace, and a PID that is gone, a zombie (it exited and waits for its parent), or now has
 * another start time (a reused PID). Anything that
 * cannot be checked from here (another boot, another namespace, a malformed label, an
 * unreadable /proc entry, a gone PID under a /proc mount with `hidepid` or an unknown mount
 * policy) is "cannot tell", and recover() leaves it.
 */
export function ownerState(
  owner: string,
  mountinfo: () => string = () => fs.readFileSync("/proc/self/mountinfo", "utf8")
): "dead" | "alive" | "cannot tell" {
  const parts = owner.split(":");
  if (parts.length !== 4 || !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3]))
    return "cannot tell";
  const [boot, pidns, pid, start] = parts;
  if (boot !== bootId() || pidns !== pidNamespace()) return "cannot tell";
  try {
    const stat = procStat(pid);
    // With hidepid, another user's live launcher has no /proc entry either: a missing entry
    // proves nothing unless /proc shows every process.
    if (stat == null) return procShowsAll(mountinfo) ? "dead" : "cannot tell";
    return !/^[ZX]$/.test(stat[0]) && stat[19] === start ? "alive" : "dead";
  } catch {
    return "cannot tell";
  }
}

/**
 * Whether the /proc mount shows every process: no `hidepid`, or `hidepid=0`/`off`. False when
 * the mount cannot be read or found, so an unknown policy never proves a launcher dead.
 */
function procShowsAll(mountinfo: () => string): boolean {
  let text: string;
  try {
    text = mountinfo();
  } catch {
    return false;
  }
  // mountinfo: "<id> <parent> <dev> <root> <mount point> <options> ... - <fstype> <source> <super options>"
  // The last /proc line is the mount in effect: a later mount on /proc hides the earlier ones.
  const lines = text
    .split("\n")
    .filter((l) => l.split(" ")[4] === "/proc" && l.includes(" - proc "));
  const line = lines.at(-1);
  if (line == null) return false;
  // "- proc <source> <super options>"
  const superOptions = line.slice(line.indexOf(" - proc ") + 1).split(" ")[3] ?? "";
  const hidepid = /(?:^|,)hidepid=([^,]*)/.exec(superOptions)?.[1];
  return hidepid == null || hidepid === "0" || hidepid === "off";
}

/**
 * `make bug-bash-sandbox-recover` (#5882): removes the job containers of this checkout whose
 * launcher is dead. It needs the job name pattern and a dead owner (ownerState), and it removes
 * by ID after the same name and label check as cleanup. It lists every other container and
 * leaves it. The owner label names a launcher, not the daemon, so this runs only on purpose,
 * and it prints the Docker endpoint first. Exit 3 when a removal cannot be proved, or a
 * leftover's owner cannot be told.
 */
export async function recover(o: LaunchOptions & { log?: (line: string) => void }) {
  const say = o.log ?? logLine;
  const session = new Session(o.stop, { root: o.root, log: say });
  const checkout = checkoutId(o.root);
  const jobName = new RegExp(`^xbb-${checkout.slice(0, 6)}-[0-9a-f]{6}$`);
  let unproved = 0;
  let failure: { error: unknown } | undefined;
  try {
    say(`recover: docker endpoint ${await session.connect()}, checkout ${checkout}`);
    for (const entry of await session.listJobs(checkout)) {
      // Unknown ownership never authorizes a removal: report it, go on, and exit nonzero.
      if ("error" in entry) {
        say(`recover: left ${entry.id.slice(0, 12)}: ${entry.error}`);
        unproved += 1;
        continue;
      }
      const { id, job } = entry;
      const owner = ownerState(job.owner);
      const named = jobName.test(job.name);
      if (owner !== "dead" || !named) {
        say(`recover: left ${job.name}: owner ${owner}${named ? "" : ", not a job name"}`);
        // An owner it cannot tell needs the manual check (docs/AGENTS.md), so the run is not
        // clean: exit 3. A live launcher's container is not a leftover to fix.
        if (owner === "cannot tell") unproved += 1;
        continue;
      }
      // A removal that started finishes (cleanup commands ignore a stop); no new one starts.
      if (o.stop.aborted) throw new Stopped(String(o.stop.reason));
      const state = await session.removeJob(id, job);
      say(`recover: ${job.name} ${state}`);
      if (state !== "removed") unproved += 1;
    }
  } catch (error) {
    failure = { error };
  }
  const state = await session.cleanup();
  if (state.startsWith("unknown")) {
    say(`recover: cleanup ${state}`);
    return 3;
  }
  if (failure) throw failure.error;
  return unproved > 0 ? 3 : 0;
}

export interface LaunchOptions {
  /** The checkout: its real path. */
  root: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The entry point aborts it on SIGINT or SIGTERM, with the signal name as the reason. */
  stop: AbortSignal;
  /** run.ts: one budget for all its jobs. Without it, a job's own from BUGBASH_BUDGET_USD. */
  ledger?: Ledger;
  /** Where the launcher's own lines go (run.ts: the charter's log). Default: stderr. */
  log?: (line: string) => void;
  /** A file descriptor for the container's stderr (the e2e output). Default: ours. */
  stderr?: number;
  /** Called once, at once, on the job's first proxy fault (run.ts stops its other jobs). */
  onProxyFault?: (reason: string) => void;
}

/**
 * How one job ended, every part kept apart. exitFor() turns it into the launcher's exit code;
 * run.ts reads the parts. `error` is anything thrown after the preflight (a Refusal too).
 */
export interface JobOutcome {
  /** The job's own exit code, or 4 when its evidence is incomplete. Unset: it did not end. */
  code?: number;
  error?: unknown;
  cleanup: CleanupState;
  /** The stop reason (SIGINT, SIGTERM), when a stop came before cleanup ended. */
  stopped?: string;
  /** The proxy's fault: a call cost more than its bound, or a call outlived close(). */
  proxyFault?: string;
}

/** e2e's own exit 3 (its infrastructure error) as a launcher code: 3 means an unknown container. */
export const JOB_EXIT_3 = 6;

/** The one precedence rule: unknown cleanup (3), then a stop, then a proxy fault (5). */
export function exitFor(outcome: JobOutcome): number {
  if (outcome.cleanup.startsWith("unknown")) return 3;
  if (outcome.stopped != null) throw new Stopped(outcome.stopped);
  if (outcome.proxyFault != null) return 5;
  if ("error" in outcome) throw outcome.error;
  return outcome.code === 3 ? JOB_EXIT_3 : outcome.code!;
}

/** Runs the job and returns the launcher's exit code. Refusal and Stopped are thrown. */
export async function launch(args: string[], o: LaunchOptions): Promise<number> {
  return exitFor(await launchJob(args, o));
}

/** Export fixtures of the self-check: each makes entry.ts send one frame the host must refuse. */
const EXPORT_FIXTURES = ["traversal", "oversize"];

/**
 * The self-check job's fixed form: `self-check [--export-fixture <name>] --output .e2e/<dir>`.
 * Its command is fixed too (`bun sandbox/selfCheck.ts`): no other argument, flag or command.
 */
function selfCheckRefusal(args: string[]): string | null {
  const [kind, ...rest] = args;
  if (kind !== "self-check") return "not a self-check";
  const fixture = rest[0] === "--export-fixture" ? rest[1] : undefined;
  const tail = fixture === undefined ? rest : rest.slice(2);
  if (fixture !== undefined && !EXPORT_FIXTURES.includes(fixture))
    return `--export-fixture must be ${EXPORT_FIXTURES.join(" or ")}`;
  if (tail.length !== 2 || tail[0] !== "--output")
    return "self-check takes only --output .e2e/<folder>";
  return null;
}

/** The checks of a job that need no docker command. Throws a Refusal. */
function checkJob(args: string[], o: LaunchOptions) {
  const dir = path.join(o.root, "tests/bugbash");
  const mcpApps = exactStepRefusal(args, o.cwd, dir, MCP_APPS_CONFIG) == null;
  const selfCheck = args[0] === "self-check";
  if (selfCheck) {
    const notSelfCheck = selfCheckRefusal(args);
    if (notSelfCheck != null) throw new Refusal(`${notSelfCheck} (#5714)`);
  } else if (args[0] === "explore") {
    const notExplore = exploreRefusal(args, o.cwd, dir);
    if (notExplore != null) throw new Refusal(`${notExplore}: not one explore charter (#5714)`);
  } else if (!mcpApps) {
    const notExact = exactStepRefusal(args, o.cwd, dir);
    if (notExact != null)
      throw new Refusal(
        `${notExact}: only exact-step repros, the MCP Apps suite and explore charters run (#5714)`
      );
  }
  // First, before any docker command and before the container env exists.
  const ai = appAi(o.env, args[0] === "explore");
  const driven = mcpApps || selfCheck || args[0] === "explore" ? modelJob(o.env) : undefined;
  return { dir, mcpApps, selfCheck, ai, driven };
}

/** A job's checks and the Docker check, with no job: `--preflight` (Makefile, before the build). */
export async function preflight(args: string[], o: LaunchOptions): Promise<CleanupState> {
  checkJob(args, o);
  return checkDocker(o);
}

/** Runs one job. A refusal before any docker command is thrown; anything later is returned. */
export async function launchJob(args: string[], o: LaunchOptions): Promise<JobOutcome> {
  const log = o.log ?? logLine;
  const { dir, mcpApps, selfCheck, ai, driven } = checkJob(args, o);
  const output = outputDir(args);
  const dest = path.join(dir, output);
  const records = `${dest}.proxy.jsonl`;
  for (const file of [dest, records])
    if (fs.lstatSync(file, { throwIfNoEntry: false }) != null)
      throw new Refusal(`${path.relative(dir, file)} exists: remove it first`);
  const mounts = () =>
    (["dist", "node_modules"] as const).flatMap((rel) =>
      bind(checkMountSource(o.root, rel), `/repo/${rel}`)
    );
  mounts(); // before preflight, and again just before `docker run`
  const session = new Session(o.stop, { root: o.root, log, stderr: o.stderr });
  const checkout = checkoutId(o.root);
  const name = `xbb-${checkout.slice(0, 6)}-${crypto.randomBytes(3).toString("hex")}`;
  const jobDir = path.join(os.tmpdir(), "xum-bugbash-sandbox", checkout, name);
  let made = false;
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  let ledger: Ledger | undefined;
  // The stop hook and the normal end share one close. Its rejection is a bound miss.
  let closing: Promise<string | undefined> | undefined;
  // A call record that could not be written (a full disk): the proxy record is incomplete, so
  // the job must not look successful. The errno code only: the message can hold the path.
  let recordFault: string | undefined;
  /** The MCP Apps probe's proxy fault: its own proxy, closed before the job's starts. */
  let probeFault: string | undefined;
  // The first proxy fault stops this job at once (its proxy closes with the lifeline), so no
  // more paid calls go out on a wrong cost model or without a record.
  let faulted = false;
  const fault = (reason: string) => {
    if (faulted) return;
    faulted = true;
    log(`${name} ${reason}: the job stops`);
    session.stop("proxy fault");
    o.onProxyFault?.(reason);
  };
  const record = (entry: object) => {
    try {
      fs.appendFileSync(records, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (error) {
      recordFault ??= `proxy: a call record was not written (${(error as NodeJS.ErrnoException).code ?? "error"})`;
      fault(recordFault);
    }
  };
  // Nothing is cached before the proxy exists, so a stop during the staging cannot skip a close.
  const closeProxy = () =>
    proxy == null
      ? Promise.resolve(undefined)
      : (closing ??= proxy.close().then(
          () => recordFault,
          (error: Error) => error.message
        ));
  session.onStop(closeProxy);

  const run = async (): Promise<number> => {
    // Leftovers of crashed launches (#5882) are only listed here, first, so a launch that fails
    // later (a long or failed pull) still shows them. recover removes the dead ones.
    await session.connect();
    for (const entry of await session.listJobs(checkout))
      log(
        "error" in entry
          ? `leftover: ${entry.id.slice(0, 12)} cannot be inspected (${entry.error})`
          : `leftover: ${entry.job.name} owner ${ownerState(entry.job.owner)} (make bug-bash-sandbox-recover)`
      );
    const image = await session.ensureImage();
    // Another job's cleanup can remove the empty per-checkout folder between the two mkdirs.
    for (let attempt = 1; ; attempt++) {
      fs.mkdirSync(path.dirname(jobDir), { recursive: true, mode: 0o700 });
      try {
        fs.mkdirSync(jobDir, { mode: 0o700 }); // EEXIST: not this job's folder, so cleanup keeps it
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt === 3) throw error;
      }
    }
    made = true;
    const staged = path.join(jobDir, "stage");
    log(`${name} staged ${stage(o.root, staged)} files`);
    const nonce = crypto.randomUUID();
    fs.writeFileSync(path.join(staged, ".sandbox-nonce"), nonce, { flag: "wx" });
    const [uid, gid] = [process.getuid!(), process.getgid!()];
    const passwd = `root:x:0:0::/root:/usr/sbin/nologin\nbugbash:x:${uid}:${gid}::/home/bugbash:/bin/sh\n`;
    fs.writeFileSync(path.join(jobDir, "passwd"), passwd);
    fs.writeFileSync(path.join(jobDir, "group"), `root:x:0:\nbugbash:x:${gid}:\n`);
    // The self-check compares its own uid with this one.
    const host = {
      BUGBASH_HOST_BOOT: bootId(),
      BUGBASH_HOST_NONCE: nonce,
      BUGBASH_HOST_UID: String(uid),
    };
    const drivenEnv = driven && {
      BUGBASH_MODEL: `anthropic:${driven.model}`,
      BUGBASH_MODEL_DRIVEN: "1",
    };
    const env = containerEnv(o.env, { ...jobEnv(output), ...host, ...modeEnv(ai), ...drivenEnv });
    plainFolders(dir, path.dirname(output), true);
    // The MCP Apps suite fails every test without its explorer model, so one probe call of that
    // model, through the job's ledger, refuses a dead upstream or key before the container starts.
    // run.ts probes before its explore jobs; the self-check has a fake upstream.
    if (mcpApps && driven) {
      ledger = o.ledger ?? new Ledger(driven.budgetUsd);
      // A bound miss in the probe is a proxy fault like any other: exit 5, and run-wide halt.
      const probe = await probeApp(driven, driven.model, ledger, o.stop).catch((error: Error) => {
        probeFault = error.message;
        fault(probeFault);
        throw error;
      });
      for (const entry of probe.records) record(entry);
      if (o.stop.aborted) throw new Stopped(String(o.stop.reason));
      if (probe.status !== 200)
        throw new Refusal(
          probeUnreachable(probe.records)
            ? `${cannotReach(driven)}: check the URL and the network`
            : (keyRejected(driven, probe.status, probe.records, {
                model: driven.model,
                variable: "BUGBASH_MODEL",
              }) ??
                `the ${driven.model} probe failed (HTTP ${probe.status}): check ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL and BUGBASH_BUDGET_USD`)
        );
      log(`${name} probe: ${driven.model} answered`);
    }
    const proxyMount: string[] = [];
    if (driven) {
      // The socket's folder, read-only: connect() needs no write access to the mount (measured
      // on Docker 27.5.1), and the container can add nothing to a host folder.
      const proxyDir = path.join(jobDir, "proxy");
      fs.mkdirSync(proxyDir, { mode: 0o700 });
      fs.mkdirSync(path.join(staged, path.relative("/repo", PROXY_DIR))); // its mount point
      ledger ??= o.ledger ?? new Ledger(driven.budgetUsd);
      proxy = await startProxy({
        socketPath: path.join(proxyDir, "sock"),
        // The job folder: not mounted (only stage/ and proxy/ are), and one place to clean up.
        privateParent: jobDir,
        upstream: driven.upstream,
        // The explorer, and in real mode the app too: nothing else.
        job: { models: [...new Set([driven.model, ...(ai.mode === "real" ? [ai.model] : [])])] },
        ledger,
        log: record,
        onFault: fault,
      });
      proxyMount.push(...bind(proxyDir, PROXY_DIR));
    }
    // prettier-ignore
    const flags = ["--rm", "--interactive", "--init", "--log-driver", "none", "--network", "none",
      "--user", `${uid}:${gid}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--read-only", "--pids-limit", "4096", "--memory", "4g", "--memory-swap", "4g",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=4g", "--tmpfs", "/home/bugbash:rw,nosuid,nodev,size=1g",
      "--tmpfs", `/repo/tests/bugbash/.e2e:rw,nosuid,nodev,size=1g,uid=${uid},gid=${gid}`,
      ...bind(staged, "/repo"), ...mounts(), ...proxyMount,
      ...bind(path.join(jobDir, "passwd"), "/etc/passwd"), ...bind(path.join(jobDir, "group"), "/etc/group"),
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--workdir", "/repo/tests/bugbash", "--entrypoint", "bun"];
    const fixture = selfCheck && args[1] === "--export-fixture" ? args[2] : undefined;
    const jobCommand = selfCheck
      ? ["bun", "sandbox/selfCheck.ts", output]
      : ["node", "../../node_modules/e2e/dist/cli/bin.js", ...args];
    const command: [string, ...string[]] = [
      image,
      "sandbox/entry.ts",
      "--export",
      output,
      ...(fixture !== undefined ? ["--export-fixture", fixture] : []),
      "--",
      ...jobCommand,
    ];
    // A signal during the synchronous staging runs its handler only at the next turn of the
    // event loop. This yield lets it run, so own() throws and no container starts (measured).
    await new Promise((resolve) => setImmediate(resolve));
    session.own({ name, owner: ownerLabel(), checkout });
    const budget = o.ledger ? "the run's budget" : `budget $${driven?.budgetUsd.toFixed(2)}`;
    const via = driven ? `proxy for anthropic:${driven.model} (${budget}), ` : "";
    const app = ai.mode === "real" ? `real app AI anthropic:${ai.model}` : "mock app AI";
    log(`${name} starts: --network none, ${via}${app}, launcher pid ${process.pid}`);
    // A refused frame ends the job at once: the container would otherwise block on a full pipe
    // until the deadline (#5930 item 4).
    const receive = async (out: Readable) => {
      const result = await receiveExport(out, dest);
      if (!result.complete) session.stop(`export: ${result.error}`);
      return result;
    };
    const job = await session.runJob(flags, command, receive, DEADLINE_MS);
    const { complete, files, error } = job.received;
    log(
      `${name} exit ${job.code}, ${files} files, ${complete ? "complete" : `incomplete: ${error}`}`
    );
    if (o.stop.aborted) throw new Stopped(String(o.stop.reason));
    return complete ? job.code : 4;
  };

  // One cleanup for every outcome. An unknown container state outranks the job's result.
  let result: number | { error: unknown };
  try {
    result = await run();
  } catch (error) {
    result = { error };
  }
  const missed = await closeProxy();
  if (proxy && ledger) {
    const { settled, kept, refused, released, refusedBy } = proxy.stats();
    if (released > 0)
      log(`${name} proxy: ${cannotReach(driven!)}: ${released} call(s) released at $0`);
    // A shared ledger's totals are the run's: run.ts reports them once.
    const { spentNanoUsd, capNanoUsd } = ledger.totals();
    const spent = o.ledger ? "" : `, ${usd(spentNanoUsd)} of ${usd(capNanoUsd)} at list price`;
    log(
      `${name} proxy: ${settled} settled, ${kept} kept in full, ${refused} refused ` +
        `${JSON.stringify(refusedBy)}${spent}`
    );
  }
  const cleanup = await session.cleanup();
  if (made) fs.rmSync(jobDir, { recursive: true, force: true });
  removeEmptyParents(jobDir);
  log(`${name} cleanup: ${cleanup}`);
  if (missed != null) log(`${name} ${missed}`);
  return {
    ...(typeof result === "number" ? { code: result } : { error: result.error }),
    cleanup,
    // Read after cleanup: a stop seen before cleanup ended counts.
    ...(o.stop.aborted && { stopped: String(o.stop.reason) }),
    // recordFault too: a probe record that was not written, before the job's proxy existed.
    ...((missed ?? probeFault ?? recordFault) != null && {
      proxyFault: missed ?? probeFault ?? recordFault,
    }),
  };
}

if (import.meta.main) {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => controller.abort(signal));
  // bun removes the first "--" after the script; a launcher started another way keeps it.
  const given = process.argv.slice(2);
  const args = given[0] === "--" ? given.slice(1) : given;
  const options = { root: ROOT, cwd: process.cwd(), env: process.env, stop: controller.signal };
  const recovering = args.length === 1 && args[0] === "--recover";
  // `--preflight -- <job args>`: the job's checks and the Docker check, then exit 0.
  const checking = args[0] === "--preflight";
  const job = checking ? args.slice(args[1] === "--" ? 2 : 1) : args;
  const run = recovering
    ? recover(options)
    : checking
      ? preflight(job, options).then((state) => {
          if (!state.startsWith("unknown")) return 0;
          logLine(`preflight cleanup: ${state}`);
          return 3;
        })
      : launch(args, options);
  run.then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof Stopped) {
        logLine(error.message);
        process.exit(error.reason === "SIGINT" ? 130 : 143);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof Refusal) {
        logLine(`refused: ${message}`);
        process.exit(2);
      }
      // An internal error exits 4, as run.ts maps it for a charter: e2e's own exit 1 means a
      // failed test, so 1 must not also mean a launcher bug (#6094 item 17).
      logLine(`error: ${message}`);
      process.exit(4);
    }
  );
}
