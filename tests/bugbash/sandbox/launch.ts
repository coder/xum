/**
 * Runs one exact-step bug-bash e2e job in a disposable container: the bug-bash sandbox (#5714).
 * Usage, from tests/bugbash, with BUGBASH_AI=mock:
 *   bun sandbox/launch.ts -- run --config e2e.config.ts --output .e2e/<folder> [e2e args...]
 *
 * The container runs the e2e CLI, Chromium and the seeded app with the pinned image (runner.ts).
 * It gets no network, no capabilities, a read-only root, copies of the git-listed inputs, and
 * read-only dist/ and node_modules/ (inputs.ts). Its output folder, the app log included, comes
 * back on its stdout as an export stream (exportStream.ts).
 *
 * Only exact-step repro runs with the mock app AI pass. `explore`, the MCP Apps suite and the
 * real app AI need the sandbox's provider proxy (a later step of #5714), so the launcher refuses
 * them, and the #5815 host pause still refuses them on the host. There is no host fallback.
 * Exit codes: the job's code, 2 refused, 3 the container state is unknown after cleanup, 4 the
 * evidence is incomplete, 130 or 143 when SIGINT or SIGTERM stopped it.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { receiveExport } from "./exportStream";
// prettier-ignore
import { checkMountSource, containerEnv, exactStepRefusal, jobEnv, outputDir, plainFolders, stage } from "./inputs";
import { Refusal, Session, Stopped } from "./runner";

const ROOT = fs.realpathSync(path.resolve(import.meta.dir, "../../.."));
const DEADLINE_MS = 30 * 60_000;
const log = (message: string) => console.error(`sandbox ${message}`);
const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const bootId = () => fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

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

// --mount, not -v: a missing source fails instead of creating an empty folder.
function bind(src: string, dst: string): string[] {
  if (src.includes(",")) throw new Refusal(`a comma in a mount path: ${src}`);
  return ["--mount", `type=bind,src=${src},dst=${dst},readonly`];
}

/** boot id : PID namespace : PID : start time of this launcher. A later sweep reads it. */
function ownerLabel(): string {
  const pidns = fs.readlinkSync("/proc/self/ns/pid").replace(/\D/g, "");
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  return `${bootId()}:${pidns}:${process.pid}:${start}`;
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
  const notExact = exactStepRefusal(args, o.cwd, dir);
  if (notExact != null)
    throw new Refusal(`${notExact}: only exact-step repros run until the provider proxy (#5714)`);
  // First, before any docker command and before the container env exists.
  if (!mockOnly(o.env))
    throw new Refusal(
      "only the mock app AI runs until the provider proxy (#5714): set BUGBASH_AI=mock"
    );
  const output = outputDir(args);
  const dest = path.join(dir, output);
  if (fs.lstatSync(dest, { throwIfNoEntry: false }) != null)
    throw new Refusal(`${output} exists: remove it first`);
  const mounts = () =>
    (["dist", "node_modules"] as const).flatMap((rel) =>
      bind(checkMountSource(o.root, rel), `/repo/${rel}`)
    );
  mounts(); // before preflight, and again just before `docker run`
  const session = new Session(o.stop, { root: o.root });
  const checkout = sha(o.root).slice(0, 12);
  const name = `xbb-${checkout.slice(0, 6)}-${crypto.randomBytes(3).toString("hex")}`;
  const jobDir = path.join(os.tmpdir(), "xum-bugbash-sandbox", checkout, name);
  let made = false;

  const run = async (): Promise<number> => {
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
    const env = containerEnv(o.env, { ...jobEnv(output), ...host, ...MOCK });
    plainFolders(dir, path.dirname(output), true);
    // prettier-ignore
    const flags = ["--rm", "--interactive", "--init", "--log-driver", "none", "--network", "none",
      "--user", `${uid}:${gid}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--read-only", "--pids-limit", "4096", "--memory", "4g", "--memory-swap", "4g",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=4g", "--tmpfs", "/home/bugbash:rw,nosuid,nodev,size=1g",
      "--tmpfs", `/repo/tests/bugbash/.e2e:rw,nosuid,nodev,size=1g,uid=${uid},gid=${gid}`,
      ...bind(staged, "/repo"), ...mounts(),
      ...bind(path.join(jobDir, "passwd"), "/etc/passwd"), ...bind(path.join(jobDir, "group"), "/etc/group"),
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--workdir", "/repo/tests/bugbash", "--entrypoint", "bun", image, "sandbox/entry.ts",
      "--export", output, "--", "node", "../../node_modules/e2e/dist/cli/bin.js", ...args];
    // A signal during the synchronous staging runs its handler only at the next turn of the
    // event loop. This yield lets it run, so own() throws and no container starts (measured).
    await new Promise((resolve) => setImmediate(resolve));
    session.own({ name, owner: ownerLabel(), checkout });
    log(`${name} starts: --network none, mock app AI`);
    // A refused frame ends the job at once: the container would otherwise block on a full pipe
    // until the deadline (#5930 item 4).
    const receive = async (out: Readable) => {
      const result = await receiveExport(out, dest);
      if (!result.complete) session.stop(`export: ${result.error}`);
      return result;
    };
    const job = await session.runJob(flags, receive, DEADLINE_MS);
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
  const state = await session.cleanup();
  if (made) fs.rmSync(jobDir, { recursive: true, force: true });
  log(`${name} cleanup: ${state}`);
  if (state.startsWith("unknown")) return 3;
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
  launch(args, options).then(
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
