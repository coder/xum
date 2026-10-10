/**
 * Runs one bug-bash e2e job in a disposable container: the bug-bash sandbox (#5714).
 * Usage, from tests/bugbash, with BUGBASH_AI=mock:
 *   bun sandbox/launch.ts -- run --config e2e.config.ts --output .e2e/<folder> [e2e args...]
 *   bun sandbox/launch.ts -- run --config e2e.mcpapps.config.ts --output .e2e/<folder> [...]
 *   bun sandbox/launch.ts --recover   (make bug-bash-sandbox-recover; see recover())
 *
 * The container runs the e2e CLI, Chromium and the seeded app with the pinned image (runner.ts).
 * It gets no network, no capabilities, a read-only root, copies of the git-listed inputs, and
 * read-only dist/ and node_modules/ (inputs.ts). Its output folder, the app log included, comes
 * back on its stdout as an export stream (exportStream.ts).
 *
 * Two job kinds run, both with the mock app AI. An exact-step repro run gets no model. The MCP
 * Apps suite is model-driven: its explorer reaches BUGBASH_MODEL (default Sonnet 5.5) only
 * through a provider proxy (proxy.ts) that this process runs for the job, on a unix socket that
 * the container gets read-only. The provider key stays here, and BUGBASH_BUDGET_USD caps the
 * spend at list price (not a billing cap: the upstream key's own limit is the backstop). The
 * proxy writes one record per call to `<output>.proxy.jsonl` on the host only. `e2e explore` and
 * the real app AI come in a later step of #5714, and the host pause still refuses every
 * model-driven run on the host. There is no host fallback.
 * Exit codes: the job's code, 2 refused, 3 the container state is unknown after cleanup, 4 the
 * evidence is incomplete, 5 a proxied call cost more than its bound (the cost model is wrong),
 * 130 or 143 when SIGINT or SIGTERM stopped it.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { receiveExport } from "./exportStream";
import { PROXY_DIR } from "./inContainer";
import { startProxy } from "./proxy";
import { Ledger } from "./proxyPolicy";
// prettier-ignore
import { checkMountSource, containerEnv, exactStepRefusal, jobEnv, outputDir, plainFolders, stage } from "./inputs";
import { Refusal, Session, Stopped } from "./runner";

const ROOT = fs.realpathSync(path.resolve(import.meta.dir, "../../.."));
const DEADLINE_MS = 30 * 60_000;
const log = (message: string) => console.error(`sandbox ${message}`);
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
 * Only the mock app AI runs until the provider proxy (#5714): no provider key enters the
 * sandbox, so a real mode could not work, and it must never start a job. Both mode names must be
 * mock or unset, and one must be mock: an ambient BUGBASH_AI_RESOLVED=real (aiMode.ts) refuses.
 */
function mockOnly(env: NodeJS.ProcessEnv): boolean {
  const modes = [env.BUGBASH_AI, env.BUGBASH_AI_RESOLVED];
  return modes.includes("mock") && modes.every((mode) => mode == null || mode === "mock");
}
/** The container always gets the mock mode, whatever else the host env holds. */
const MOCK = { BUGBASH_AI: "mock", BUGBASH_AI_RESOLVED: "mock" };
const MCP_APPS_CONFIG = "e2e.mcpapps.config.ts";
const MCP_APPS_MODEL = "anthropic:claude-sonnet-5-5";

/** The explorer model, the spend cap and the upstream of a model-driven job. */
interface ModelJob {
  model: string;
  budgetUsd: number;
  upstream: { baseUrl: string; apiKey: string };
}

/**
 * Reads a model-driven job from the host env, before any docker command. Refusal texts never
 * hold the key or the base URL.
 */
function modelJob(env: NodeJS.ProcessEnv): ModelJob {
  const spec = env.BUGBASH_MODEL ?? MCP_APPS_MODEL;
  const [provider, model] = spec.split(/:(.*)/s, 2);
  if (provider !== "anthropic" || !model)
    throw new Refusal(`BUGBASH_MODEL ${JSON.stringify(spec)}: only anthropic:<model> runs here`);
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
 * unreadable /proc entry) is "cannot tell", and recover() leaves it.
 */
export function ownerState(owner: string): "dead" | "alive" | "cannot tell" {
  const parts = owner.split(":");
  if (parts.length !== 4 || !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3]))
    return "cannot tell";
  const [boot, pidns, pid, start] = parts;
  if (boot !== bootId() || pidns !== pidNamespace()) return "cannot tell";
  try {
    const stat = procStat(pid);
    return stat != null && !/^[ZX]$/.test(stat[0]) && stat[19] === start ? "alive" : "dead";
  } catch {
    return "cannot tell";
  }
}

/**
 * `make bug-bash-sandbox-recover` (#5882): removes the job containers of this checkout whose
 * launcher is dead. It needs the job name pattern and a dead owner (ownerState), and it removes
 * by ID after the same name and label check as cleanup. It lists every other container and
 * leaves it. The owner label names a launcher, not the daemon, so this runs only on purpose,
 * and it prints the Docker endpoint first. Exit 3 when a removal cannot be proved.
 */
export async function recover(o: LaunchOptions & { log?: (line: string) => void }) {
  const say = o.log ?? log;
  const session = new Session(o.stop, { root: o.root, log: say });
  const checkout = checkoutId(o.root);
  const jobName = new RegExp(`^xbb-${checkout.slice(0, 6)}-[0-9a-f]{6}$`);
  let unproved = 0;
  let failure: { error: unknown } | undefined;
  try {
    say(`recover: docker endpoint ${await session.connect()}, checkout ${checkout}`);
    for (const { id, job } of await session.listJobs(checkout)) {
      const owner = ownerState(job.owner);
      const named = jobName.test(job.name);
      if (owner !== "dead" || !named) {
        say(`recover: left ${job.name}: owner ${owner}${named ? "" : ", not a job name"}`);
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
}

/** Runs the job and returns the launcher's exit code. Refusal and Stopped are thrown. */
export async function launch(args: string[], o: LaunchOptions): Promise<number> {
  const dir = path.join(o.root, "tests/bugbash");
  const mcpApps = exactStepRefusal(args, o.cwd, dir, MCP_APPS_CONFIG) == null;
  const notExact = mcpApps ? null : exactStepRefusal(args, o.cwd, dir);
  if (notExact != null)
    throw new Refusal(`${notExact}: only exact-step repros and the MCP Apps suite run (#5714)`);
  // First, before any docker command and before the container env exists.
  if (!mockOnly(o.env))
    throw new Refusal("only the mock app AI runs in the sandbox (#5714): set BUGBASH_AI=mock");
  const driven = mcpApps ? modelJob(o.env) : undefined;
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
  const session = new Session(o.stop, { root: o.root });
  const checkout = checkoutId(o.root);
  const name = `xbb-${checkout.slice(0, 6)}-${crypto.randomBytes(3).toString("hex")}`;
  const jobDir = path.join(os.tmpdir(), "xum-bugbash-sandbox", checkout, name);
  let made = false;
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  let ledger: Ledger | undefined;
  // The stop hook and the normal end share one close. Its rejection is a bound miss.
  let closing: Promise<string | undefined> | undefined;
  // Nothing is cached before the proxy exists, so a stop during the staging cannot skip a close.
  const closeProxy = () =>
    proxy == null
      ? Promise.resolve(undefined)
      : (closing ??= proxy.close().then(
          () => undefined,
          (error: Error) => error.message
        ));
  session.onStop(closeProxy);

  const run = async (): Promise<number> => {
    // Leftovers of crashed launches (#5882) are only listed here, first, so a launch that fails
    // later (a long or failed pull) still shows them. recover removes the dead ones.
    await session.connect();
    for (const { job } of await session.listJobs(checkout))
      log(`leftover: ${job.name} owner ${ownerState(job.owner)} (make bug-bash-sandbox-recover)`);
    const image = await session.ensureImage();
    fs.mkdirSync(path.dirname(jobDir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(jobDir, { mode: 0o700 }); // EEXIST: not this job's folder, so cleanup keeps it
    made = true;
    const staged = path.join(jobDir, "stage");
    log(`${name} staged ${stage(o.root, staged)} files`);
    const nonce = crypto.randomUUID();
    fs.writeFileSync(path.join(staged, ".sandbox-nonce"), nonce, { flag: "wx" });
    const [uid, gid] = [process.getuid!(), process.getgid!()];
    const passwd = `root:x:0:0::/root:/usr/sbin/nologin\nbugbash:x:${uid}:${gid}::/home/bugbash:/bin/sh\n`;
    fs.writeFileSync(path.join(jobDir, "passwd"), passwd);
    fs.writeFileSync(path.join(jobDir, "group"), `root:x:0:\nbugbash:x:${gid}:\n`);
    const host = { BUGBASH_HOST_BOOT: bootId(), BUGBASH_HOST_NONCE: nonce };
    const drivenEnv = driven && {
      BUGBASH_MODEL: `anthropic:${driven.model}`,
      BUGBASH_MODEL_DRIVEN: "1",
    };
    const env = containerEnv(o.env, { ...jobEnv(output), ...host, ...MOCK, ...drivenEnv });
    plainFolders(dir, path.dirname(output), true);
    const proxyMount: string[] = [];
    if (driven) {
      // The socket's folder, read-only: connect() needs no write access to the mount (measured
      // on Docker 27.5.1), and the container can add nothing to a host folder.
      const proxyDir = path.join(jobDir, "proxy");
      fs.mkdirSync(proxyDir, { mode: 0o700 });
      fs.mkdirSync(path.join(staged, path.relative("/repo", PROXY_DIR))); // its mount point
      ledger = new Ledger(driven.budgetUsd);
      proxy = await startProxy({
        socketPath: path.join(proxyDir, "sock"),
        upstream: driven.upstream,
        job: { models: [driven.model] }, // the app AI is the mock: only the explorer calls
        ledger,
        log: (entry) => fs.appendFileSync(records, `${JSON.stringify(entry)}\n`, { mode: 0o600 }),
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
    const command: [string, ...string[]] = [
      image,
      "sandbox/entry.ts",
      "--export",
      output,
      "--",
      "node",
      "../../node_modules/e2e/dist/cli/bin.js",
      ...args,
    ];
    // A signal during the synchronous staging runs its handler only at the next turn of the
    // event loop. This yield lets it run, so own() throws and no container starts (measured).
    await new Promise((resolve) => setImmediate(resolve));
    session.own({ name, owner: ownerLabel(), checkout });
    const via = driven
      ? `proxy for anthropic:${driven.model} (budget $${driven.budgetUsd.toFixed(2)}), `
      : "";
    log(`${name} starts: --network none, ${via}mock app AI, launcher pid ${process.pid}`);
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
    const { settled, kept, refused, refusedBy } = proxy.stats();
    const { spentNanoUsd, capNanoUsd } = ledger.totals();
    log(
      `${name} proxy: ${settled} settled, ${kept} kept in full, ${refused} refused ` +
        `${JSON.stringify(refusedBy)}, ${usd(spentNanoUsd)} of ${usd(capNanoUsd)} at list price`
    );
  }
  const state = await session.cleanup();
  if (made) fs.rmSync(jobDir, { recursive: true, force: true });
  log(`${name} cleanup: ${state}`);
  if (state.startsWith("unknown")) return 3;
  if (missed != null) {
    log(`${name} ${missed}`);
    return 5;
  }
  // A stop seen before cleanup ended outranks the job's result and an earlier error.
  if (o.stop.aborted) throw new Stopped(String(o.stop.reason));
  if (typeof result !== "number") throw result.error;
  return result;
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
  (recovering ? recover(options) : launch(args, options)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof Stopped) {
        log(error.message);
        process.exit(error.reason === "SIGINT" ? 130 : 143);
      }
      log(`refused: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(error instanceof Refusal ? 2 : 1);
    }
  );
}
