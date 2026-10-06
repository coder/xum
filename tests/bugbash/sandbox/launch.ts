/**
 * Runs one bug-bash e2e job in a disposable container: the bug-bash sandbox (#5714).
 * Usage, from tests/bugbash:
 *   bun sandbox/launch.ts -- run --config e2e.config.ts --output .e2e/<folder> [e2e args...]
 *
 * The container runs the e2e CLI, Chromium and the seeded app. It gets no network, no
 * capabilities, a read-only root, copies of the git-listed inputs, and read-only dist/ and
 * node_modules/. Its output comes back on its stdout as an export stream (exportStream.ts).
 *
 * It runs only exact-step jobs: `e2e run --config e2e.config.ts` (the repros). Other e2e commands
 * and configs (`explore`, the MCP Apps suite) let a model pick the actions. They need a model,
 * which the sandbox reaches only through its provider proxy (a later step of #5714), and they
 * never run on the host. So the launcher refuses them for now.
 * BUGBASH_SANDBOX=auto (default): without usable Docker, or with the real app AI (that needs the
 * provider proxy too), the exact-step job runs on the host as before. BUGBASH_SANDBOX=require
 * refuses instead.
 * Exit codes: the job's code, 2 when the launcher refuses, 4 when the evidence is incomplete.
 */
import { spawn, spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import { createRequire } from "module";
import * as os from "os";
import * as path from "path";
import { receiveExport } from "./exportStream";

const ROOT = path.resolve(import.meta.dir, "../../..");
const BUGBASH_DIR = path.join(ROOT, "tests/bugbash");
const DEADLINE_MS = 30 * 60_000;
// The container reads copies of these git-listed inputs. A symlink stops the launch.
const INPUTS = ["src", "tests/bugbash", "tsconfig.json", "package.json"];
// The host env names that e2e.config.ts and startApp.ts read. No other host value passes.
// Not BUGBASH_AI_REASON: after a failed probe it holds the provider URL and response text.
const PASS_ENV = [
  "BUGBASH_AI",
  "BUGBASH_AI_RESOLVED",
  "BUGBASH_APP_MODEL",
  "BUGBASH_MODEL",
  "BUGBASH_EFFORT",
  "BUGBASH_APP_LOG",
  "BUGBASH_SCENARIO",
  "E2E_TELEMETRY_DISABLED",
];

export class Refusal extends Error {}
/** The sandbox cannot run on this host. It is thrown before the job's container starts. */
class Unusable extends Refusal {}
const log = (message: string) => console.error(`sandbox ${message}`);
const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

/**
 * The env of every docker command after checkEndpoint(): PATH, the endpoint that the user
 * selected, and an empty private client config. The CLI reads no user config. Its `proxies`
 * entries (a proxy URL can hold a user and password) would otherwise go into every build as
 * build args and into every container as env, past containerEnv(). No HOME, no other DOCKER_*.
 */
let client: Record<string, string> | null = null;

function clientEnv(): Record<string, string> {
  if (client == null) throw new Refusal("docker: checkEndpoint() must pass first");
  return client;
}

/**
 * The endpoint of the user's docker CLI: DOCKER_HOST, else DOCKER_CONTEXT, else the current
 * context in the user's client config. This is the one docker command that reads the user's
 * config. It reads the context only, and starts no build and no container.
 */
function selectedEndpoint(): { host: string } | { error: string } {
  const pass = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (pass.includes(key) && value != null) env[key] = value;
  const r = run(env, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
    timeoutMs: 10_000,
  });
  return r.ok ? { host: r.stdout } : { error: r.error };
}

/** A fresh, empty client config folder. It lives until this launcher exits. */
function privateClient(host: string): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xum-bugbash-docker-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return { PATH: process.env.PATH ?? "", DOCKER_HOST: host, DOCKER_CONFIG: dir };
}

function docker(args: string[], options: { timeoutMs: number; input?: string; quiet?: boolean }) {
  return run(clientEnv(), args, options);
}

function run(
  env: Record<string, string>,
  args: string[],
  options: { timeoutMs: number; input?: string; quiet?: boolean }
) {
  const r = spawnSync("docker", args, {
    env,
    encoding: "utf8",
    timeout: options.timeoutMs,
    input: options.input,
    stdio: [
      options.input == null ? "ignore" : "pipe",
      options.quiet === false ? 2 : "pipe",
      "pipe",
    ],
  });
  const error = r.error?.message ?? (r.status === 0 ? "" : (r.stderr || `exit ${r.status}`).trim());
  return { ok: error === "", stdout: (r.stdout ?? "").trim(), error };
}

/** Why this host cannot run the sandbox, or null. It runs before any image build. */
export function checkEndpoint(): string | null {
  if (process.platform !== "linux") return `${process.platform}: the sandbox needs Linux`;
  if (process.getuid?.() === 0) return "the sandbox does not run as root";
  if (client != null) return null; // resolved and checked once per launcher
  const selected = selectedEndpoint();
  if ("error" in selected) return `docker: ${selected.error}`;
  // Fail closed: a remote, ssh or relative endpoint is refused, never swapped for the default.
  if (!/^unix:\/\/\/./.test(selected.host))
    return `docker endpoint ${JSON.stringify(selected.host)}: not a local socket`;
  const candidate = privateClient(selected.host);
  const info = run(candidate, ["info", "--format", "{{json .}}"], { timeoutMs: 15_000 });
  if (!info.ok) return `docker info: ${info.error}`;
  const daemon = JSON.parse(info.stdout) as {
    OSType?: string;
    OperatingSystem?: string;
    SecurityOptions?: string[];
    ServerErrors?: string[];
  };
  // `docker info` exits 0 when no daemon answers, with only the client fields.
  if ((daemon.OSType ?? "") === "")
    return `docker info: no daemon answered (${(daemon.ServerErrors ?? []).join("; ")})`;
  if (daemon.OSType !== "linux" || /docker desktop/i.test(daemon.OperatingSystem ?? ""))
    return "Docker Desktop is not supported";
  if ((daemon.SecurityOptions ?? []).some((o) => o.includes("rootless")))
    return "rootless Docker is not supported";
  client = candidate;
  return null;
}

function ensureImage(): string {
  const dockerfile = fs.readFileSync(path.join(import.meta.dir, "Dockerfile"), "utf8");
  // The Chromium build that the checkout's @e2e-dev/web expects.
  const web = createRequire(path.join(ROOT, "package.json")).resolve("@e2e-dev/web");
  const playwright = (createRequire(web)("playwright-core/package.json") as { version: string })
    .version;
  const image = `xum-bugbash-sandbox:${sha(`${dockerfile}\0${playwright}`).slice(0, 12)}`;
  if (docker(["image", "inspect", image], { timeoutMs: 15_000 }).ok) return image;
  log(`building ${image}`);
  const args = ["build", "--build-arg", `PLAYWRIGHT_CORE_VERSION=${playwright}`, "-t", image, "-"];
  const built = docker(args, { timeoutMs: 20 * 60_000, input: dockerfile, quiet: false });
  if (!built.ok) throw new Unusable(`image build: ${built.error}`);
  return image;
}

/**
 * Checks each folder of `rel` under `base` without following a symlink; with `create`, it makes
 * the missing ones. So a symlinked folder cannot lead a copy or an export out of the checkout.
 */
export function plainFolders(base: string, rel: string, create: boolean, seen = new Set<string>()) {
  let dir = base;
  for (const part of rel.split("/").filter((p) => p !== "" && p !== ".")) {
    dir = path.join(dir, part);
    if (seen.has(dir)) continue;
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (st == null && create) fs.mkdirSync(dir);
    else if (st?.isDirectory() !== true)
      throw new Refusal(`${path.relative(base, dir)}: not a plain folder (a symlink?)`);
    seen.add(dir);
  }
}

function stage(into: string): number {
  // Tracked files, and new files that git does not ignore (a new repro). Ignored files stay out:
  // old .e2e runs, app logs and local env files.
  // prettier-ignore
  const listArgs = ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"];
  const listed = spawnSync("git", ["-C", ROOT, ...listArgs, "--", ...INPUTS], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  if (listed.status !== 0) throw new Refusal(`git ls-files: ${listed.stderr}`);
  let count = 0;
  const seen = new Set<string>();
  for (const rel of listed.stdout.split("\0").filter((name) => name !== "")) {
    const st = fs.lstatSync(path.join(ROOT, rel), { throwIfNoEntry: false });
    if (st == null) continue; // deleted in the work tree
    plainFolders(ROOT, path.dirname(rel), false, seen); // lstat above follows symlinked folders
    if (!st.isFile()) throw new Refusal(`stage: ${rel} is not a regular file`);
    fs.mkdirSync(path.join(into, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(into, rel), fs.constants.COPYFILE_EXCL);
    count += 1;
  }
  // Mount points for the read-only build outputs and the job's tmpfs.
  for (const dir of ["dist", "node_modules", "tests/bugbash/.e2e"])
    fs.mkdirSync(path.join(into, dir), { recursive: true });
  return count;
}

// --mount, not -v: a missing source fails instead of creating an empty folder.
function bind(src: string, dst: string): string[] {
  if (`${src}${dst}`.includes(",")) throw new Refusal(`a comma in a mount path: ${src}`);
  return ["--mount", `type=bind,src=${src},dst=${dst},readonly`];
}

/** Same boot id: the daemon shares this kernel. Same nonce: it sees this host's files at these paths. */
function checkSameHost(image: string, stageDir: string): string | null {
  const nonce = crypto.randomUUID();
  fs.writeFileSync(path.join(stageDir, ".nonce"), nonce, { flag: "wx" });
  // prettier-ignore
  const probe = ["run", "--rm", "--network", "none", ...bind(stageDir, "/probe"), image,
    "cat", "/proc/sys/kernel/random/boot_id", "/probe/.nonce"];
  const r = docker(probe, { timeoutMs: 60_000 });
  if (!r.ok) return `probe container: ${r.error}`;
  const [boot, seen] = r.stdout.split("\n");
  if (boot !== fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim())
    return "the daemon runs on another kernel";
  return seen === nonce ? null : "the daemon sees other files at these paths";
}

/** boot id : PID namespace : PID : start time of this launcher. A later sweep reads it. */
function ownerLabel(): string {
  const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const pidns = fs.readlinkSync("/proc/self/ns/pid").replace(/\D/g, "");
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  return `${boot}:${pidns}:${process.pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
}

// No credential reaches the container, also not through a caller's extra values.
const CREDENTIAL = /(_API_KEY|_AUTH_TOKEN|_TOKEN|_BASE_URL|_SECRET|_PASSWORD)$/i;

/** The container env: fixed values, the allowlisted host names and the caller's extra values. */
export function containerEnv(
  host: NodeJS.ProcessEnv,
  extra: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = { HOME: "/home/bugbash", TMPDIR: "/tmp" };
  for (const key of PASS_ENV) if (host[key] != null) env[key] = host[key];
  Object.assign(env, extra, { BUGBASH_CONTAINER: "1" });
  for (const key of Object.keys(env))
    if (CREDENTIAL.test(key)) throw new Refusal(`${key}: no credential enters the sandbox`);
  return env;
}

export interface SandboxRun {
  command: string[];
  /** The job's output folder, relative to tests/bugbash. It comes back to the same host path. */
  exportDir: string;
  env?: Record<string, string>;
}

export async function runInSandbox(run: SandboxRun): Promise<number> {
  const dest = path.join(BUGBASH_DIR, run.exportDir);
  if (fs.existsSync(dest)) throw new Refusal(`${run.exportDir} exists: remove it first`);
  const image = ensureImage();
  const checkoutId = sha(ROOT).slice(0, 12);
  const name = `xbb-${checkoutId.slice(0, 6)}-${crypto.randomBytes(3).toString("hex")}`;
  const jobDir = path.join(os.tmpdir(), "xum-bugbash-sandbox", checkoutId, name);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  try {
    const stageDir = path.join(jobDir, "stage");
    const started = Date.now();
    const files = stage(stageDir);
    log(`${name} staged ${files} files in ${((Date.now() - started) / 1000).toFixed(2)} s`);
    const different = checkSameHost(image, stageDir);
    if (different != null) throw new Unusable(different);
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    fs.writeFileSync(
      path.join(jobDir, "passwd"),
      `root:x:0:0::/root:/usr/sbin/nologin\nbugbash:x:${uid}:${gid}::/home/bugbash:/bin/sh\n`
    );
    fs.writeFileSync(path.join(jobDir, "group"), `root:x:0:\nbugbash:x:${gid}:\n`);
    const env = containerEnv(process.env, run.env ?? {});
    const owner = ownerLabel();
    // prettier-ignore
    const args = ["run", "--rm", "-i", "--init", "--name", name,
      "--label", `xum.bugbash.checkout=${checkoutId}`, "--label", `xum.bugbash.owner=${owner}`,
      "--log-driver", "none", "--network", "none", "--user", `${uid}:${gid}`,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
      "--pids-limit", "4096", "--memory", "4g", "--memory-swap", "4g",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=4g", "--tmpfs", "/home/bugbash:rw,nosuid,nodev,size=1g",
      "--tmpfs", `/repo/tests/bugbash/.e2e:rw,nosuid,nodev,size=1g,uid=${uid},gid=${gid}`,
      ...bind(stageDir, "/repo"), ...bind(path.join(ROOT, "dist"), "/repo/dist"),
      ...bind(path.join(ROOT, "node_modules"), "/repo/node_modules"),
      ...bind(path.join(jobDir, "passwd"), "/etc/passwd"), ...bind(path.join(jobDir, "group"), "/etc/group"),
      ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      "-w", "/repo/tests/bugbash", "--entrypoint", "bun", image,
      "sandbox/entry.ts", "--export", run.exportDir, "--", ...run.command];
    plainFolders(BUGBASH_DIR, path.dirname(run.exportDir), true);
    log(`${name} --network none, ${appAi() ?? "no"} app AI, no proxy`);
    return await runContainer(args, { name, owner, checkout: checkoutId, dest });
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}

interface Job {
  name: string;
  owner: string;
  checkout: string;
}

async function runContainer(args: string[], job: Job & { dest: string }) {
  // The lifeline: this process holds the container's stdin. When it dies, the pipe closes and
  // entry.ts stops the job (measured: the container was gone 0.59 s after a SIGKILL).
  const child = spawn("docker", args, { env: clientEnv(), stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.on("error", () => undefined);
  const exported = receiveExport(child.stdout, job.dest);
  let stopped: string | null = null;
  const stop = (reason: string) => {
    if (stopped != null) return;
    stopped = reason;
    log(`${job.name} stopping: ${reason}`);
    log(`${job.name} ${removeContainer(job)}`);
    // Also when the removal failed: the closed lifeline stops the job in the container, and the
    // killed client ends the wait below, so the deadline always bounds this launcher.
    child.stdin.end();
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => stop("the 30 min deadline"), DEADLINE_MS);
  const onSignal = (signal: NodeJS.Signals) => stop(signal);
  process.on("SIGINT", onSignal).on("SIGTERM", onSignal);
  const code = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(125)).on("exit", (exit) => resolve(exit ?? 125));
  });
  clearTimeout(timer);
  process.off("SIGINT", onSignal).off("SIGTERM", onSignal);
  const result = await exported;
  const size = `${result.files} files, ${(result.bytes / 1e6).toFixed(1)} MB`;
  log(
    `${job.name} job exit ${code}, export ${size}, ${result.complete ? "complete" : `incomplete: ${result.error}`}`
  );
  log(`${job.name} ${removeContainer(job)}`);
  if (stopped != null) return stopped === "SIGINT" ? 130 : 143;
  return result.complete ? code : 4;
}

/**
 * Removes the job's container. It matches the name, the owner label AND this checkout's label,
 * never the name alone: other checkouts on this host run their own sandboxes.
 */
export function removeContainer(job: Job): string {
  // prettier-ignore
  const filters = ["--filter", `name=^/${job.name}$`, "--filter", `label=xum.bugbash.owner=${job.owner}`,
    "--filter", `label=xum.bugbash.checkout=${job.checkout}`];
  const find = () => docker(["ps", "-aq", "--no-trunc", ...filters], { timeoutMs: 15_000 });
  const found = find();
  if (!found.ok) return `container state unknown: ${found.error}`;
  if (found.stdout === "") return "removed";
  docker(["rm", "-f", found.stdout], { timeoutMs: 30_000 });
  const after = find();
  if (!after.ok) return `container state unknown: ${after.error}`;
  return after.stdout === "" ? "removed" : `still present: docker rm -f ${found.stdout}`;
}

/** The app AI mode, read the way e2e.config.ts reads it. */
export const appAi = (env: NodeJS.ProcessEnv = process.env) =>
  env.BUGBASH_AI_RESOLVED ?? (env.BUGBASH_AI === "mock" ? "mock" : undefined);

/** Why this job runs on the host, or null for the sandbox. */
function hostReason(): string | null {
  if (appAi() !== "mock")
    return "the real app AI needs the sandbox's provider proxy, which is not built yet (#5714)";
  return checkEndpoint();
}

function runOnHost(args: string[]): Promise<number> {
  const spec = process.env.E2E_NODE ?? "node";
  const node = spec.includes("/") ? spec : Bun.which(spec);
  if (node == null) throw new Refusal(`E2E_NODE ${spec}: not found`);
  // The node directory leads PATH, so the app command and its children use the same node.
  const PATH = `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}`;
  const child = spawn(node, [path.join(ROOT, "node_modules/.bin/e2e"), ...args], {
    cwd: BUGBASH_DIR, // where exactStepRefusal() checked e2e.config.ts
    stdio: "inherit",
    env: { ...process.env, PATH },
  });
  // A signal to this launcher alone reaches e2e too, and the launcher waits for e2e's teardown.
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGINT", forward).on("SIGTERM", forward);
  return new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve(exitCode(code, signal)))
  );
}

/** The shell convention: the exit code, or 128 + the number of the signal that ended the process. */
export function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? (signal != null ? 128 + os.constants.signals[signal] : 1);
}

// The `e2e run` options that a repro run may use: selection and output only. Not allowed, among
// others: a second --config, positional files, "--", --agent and the cache and trace switches.
// e2e reads no env var that picks a config or an agent (only E2E_TELEMETRY_*, the E2E_USER*,
// E2E_SECRET* and E2E_OAUTH_CREDENTIALS test values, NODE_OPTIONS and CI names; e2e 0.17).
const RUN_VALUE_OPTIONS = ["--config", "--output", "--tag", "--exclude-tag", "--tag-mode",
  "--grep", "--grep-invert", "--target", "--shard", "--workers", "--retries", "--max-failures",
  "--reporter"]; // prettier-ignore
const RUN_FLAGS = ["--pass-with-no-tests", "--last-failed", "--debug"];

/**
 * Why these e2e args are not an exact-step repro run, or null. Only `e2e run` with the repro
 * config passes: its tests are repros/** (no agent fixture: reproRules.test.ts). e2e resolves
 * --config from its cwd, so the cwd must be tests/bugbash and the config a regular file there.
 */
export function exactStepRefusal(args: string[], cwd: string, dir = BUGBASH_DIR): string | null {
  if (args[0] !== "run") return `${JSON.stringify(args[0] ?? "")} is not \`e2e run\``;
  if (args.includes("explore")) return "an `explore` argument";
  const configs: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const [name, inline] = args[i].startsWith("--") ? args[i].split(/=(.*)/s, 2) : [args[i]];
    if (RUN_FLAGS.includes(name) && inline == null) continue;
    if (!RUN_VALUE_OPTIONS.includes(name)) return `the argument ${JSON.stringify(args[i])}`;
    const value = inline ?? args[++i];
    if (value == null || value === "" || value.startsWith("-"))
      return `${name} needs a value, got ${JSON.stringify(value ?? "")}`;
    if (name === "--config") configs.push(value);
  }
  if (configs.length !== 1 || configs[0] !== "e2e.config.ts")
    return `--config must be given once as e2e.config.ts, got ${JSON.stringify(configs)}`;
  if (fs.realpathSync(cwd) !== fs.realpathSync(dir)) return `the cwd must be ${dir}, got ${cwd}`;
  if (fs.lstatSync(path.join(dir, "e2e.config.ts"), { throwIfNoEntry: false })?.isFile() !== true)
    return `${dir}/e2e.config.ts is not a regular file (a symlink?)`;
  return null;
}

/** The one `--output .e2e/<folder>` of the e2e args. The export comes back to that folder only. */
export function outputDir(args: string[]): string {
  const values = args.flatMap((arg, i) =>
    arg === "--output" ? [args[i + 1] ?? ""] : arg.startsWith("--output=") ? [arg.slice(9)] : []
  );
  const [dir] = values;
  if (
    values.length !== 1 ||
    !/^\.e2e(\/[\w.-]+)+$/.test(dir) ||
    dir.split("/").some((part) => /^\.+$/.test(part) && part !== ".e2e")
  )
    throw new Refusal(
      `the e2e args need exactly one --output .e2e/<folder>, got ${JSON.stringify(values)}`
    );
  return dir;
}

async function main(): Promise<number> {
  // bun removes the first "--" after the script; a launcher started another way keeps it.
  const given = process.argv.slice(2);
  const e2eArgs = given[0] === "--" ? given.slice(1) : given;
  if (e2eArgs.length === 0) throw new Refusal("usage: launch.ts -- <e2e args...>");
  const mode = process.env.BUGBASH_SANDBOX ?? "auto";
  if (mode !== "auto" && mode !== "require")
    throw new Refusal(`BUGBASH_SANDBOX must be auto or require, got ${mode}`);
  // Before the sandbox and the host fallback both: neither runs anything else.
  const notExact = exactStepRefusal(e2eArgs, process.cwd());
  if (notExact != null)
    throw new Refusal(
      `${notExact}: only \`e2e run --config e2e.config.ts\` (exact-step repros) runs for now. ` +
        "Model-driven runs wait for the sandbox's provider proxy (#5714)."
    );
  const why = hostReason();
  if (why != null && mode === "require") throw new Refusal(`${why} (BUGBASH_SANDBOX=require)`);
  if (why != null) {
    log(`not used: ${why}. These exact-step tests run on the host, as before.`);
    return runOnHost(e2eArgs);
  }
  const output = outputDir(e2eArgs);
  const command = ["node", "../../node_modules/e2e/dist/cli/bin.js", ...e2eArgs];
  // The app log goes into the output folder, so that it comes back with the report.
  const env = { BUGBASH_APP_LOG: process.env.BUGBASH_APP_LOG ?? `${output}/app.log` };
  try {
    return await runInSandbox({ command, exportDir: output, env });
  } catch (error) {
    // A failed image build or same-host probe: as without Docker (the job did not start).
    if (!(error instanceof Unusable) || mode === "require") throw error;
    log(`not used: ${error.message}. These exact-step tests run on the host, as before.`);
    return runOnHost(e2eArgs);
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      log(`refused: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(error instanceof Refusal ? 2 : 1);
    }
  );
}
