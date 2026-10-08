/**
 * The runner library of the bug-bash sandbox (#5714). It finds a local Docker daemon, gets the
 * pinned image, runs commands as tracked async children, and cleans up after a job. It has no
 * entry point and starts no job container: the launch command comes in a later step.
 *
 * The trust anchor is the digest in image.json, which a reviewed pull request sets. The runner
 * pulls only `name@digest` and never builds. It refuses when the inputs key of this checkout
 * (`build.sh --key`) differs from image.json: that image was built for other inputs, and a
 * person must publish a new one (workflow "Bug-bash sandbox image") and update image.json.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = fs.realpathSync(path.resolve(import.meta.dir, "../../.."));
export const IMAGE = "ghcr.io/coder/xum-bugbash-sandbox";
/** How long a child gets after SIGTERM before SIGKILL. */
const KILL_AFTER_MS = 5_000;

export class Refusal extends Error {}
/** The session stopped (a signal, or cleanup started) before this command could finish. */
export class Stopped extends Error {
  constructor(readonly reason: string) {
    super(`stopped: ${reason}`);
  }
}

export interface ImageLock {
  image: string;
  digest: string;
  inputsKey: string;
  playwrightCore: string;
  publishedFrom: string;
}

export function readImageLock(root = ROOT): ImageLock {
  const file = path.join(root, "tests/bugbash/sandbox/image.json");
  const lock = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ImageLock>;
  const valid =
    lock.image === IMAGE &&
    /^sha256:[0-9a-f]{64}$/.test(lock.digest ?? "") &&
    /^[0-9a-f]{64}$/.test(lock.inputsKey ?? "") &&
    /^\d+\.\d+\.\d+$/.test(lock.playwrightCore ?? "") &&
    /^[0-9a-f]{40}$/.test(lock.publishedFrom ?? "");
  if (!valid) throw new Refusal("tests/bugbash/sandbox/image.json is not a valid image lock");
  return lock as ImageLock;
}

interface Result {
  ok: boolean;
  stdout: string;
  error: string;
}
/** A job container, matched by its name and both labels, never by the name alone. */
export interface Job {
  name: string;
  owner: string;
  checkout: string;
}
export type CleanupState = "removed" | `unknown: ${string}`;

export class Session {
  readonly #root: string;
  readonly #children = new Map<ChildProcess, Promise<Result>>();
  #stopped: string | null = null;
  #client: Record<string, string> | null = null;
  #clientDir: string | null = null;
  #cleanup: Promise<CleanupState> | null = null;

  /** The entry point aborts `stop` from its SIGINT and SIGTERM handlers. */
  constructor(stop: AbortSignal, options: { root?: string } = {}) {
    this.#root = options.root ?? ROOT;
    if (stop.aborted) this.#stop(String(stop.reason));
    else stop.addEventListener("abort", () => this.#stop(String(stop.reason)), { once: true });
  }

  /** The pinned image, pulled when missing, as `name@digest`. */
  async ensureImage(): Promise<string> {
    const lock = readImageLock(this.#root);
    const key = await this.#checkoutKey();
    if (key !== lock.inputsKey)
      throw new Refusal(
        `stale image: image.json has inputs key ${lock.inputsKey.slice(0, 16)}, this checkout ` +
          `${key.slice(0, 16)}. Publish a new image, then update tests/bugbash/sandbox/image.json.`
      );
    await this.#connect();
    const ref = `${lock.image}@${lock.digest}`;
    // An empty list with exit 0 means absent. Any failure refuses: it is not "absent".
    const listed = await this.#must(["images", "--no-trunc", "--quiet", ref], 15_000);
    if (listed.stdout === "") await this.#must(["pull", "--quiet", ref], 10 * 60_000);
    const inspect = ["image", "inspect", "--format", "{{json .Config.Labels}}", ref];
    const labels = JSON.parse((await this.#must(inspect, 15_000)).stdout) as Record<
      string,
      string
    > | null;
    const label = labels?.["org.xum.bugbash.inputs"];
    if (label !== key)
      throw new Refusal(`${ref}: label org.xum.bugbash.inputs is ${label}, not ${key}`);
    return ref;
  }

  /**
   * One cleanup for success, error and stop: later calls get the same promise. It stops the
   * session, waits for every child, and removes the job's container. It reports an unknown
   * container state instead of success, and it never removes an image.
   */
  cleanup(job?: Job): Promise<CleanupState> {
    this.#cleanup ??= this.#runCleanup(job);
    return this.#cleanup;
  }

  async #runCleanup(job?: Job): Promise<CleanupState> {
    this.#stop("cleanup");
    await Promise.all(this.#children.values());
    const state =
      job == null || this.#client == null ? "removed" : await this.#removeContainer(job);
    if (this.#clientDir != null) fs.rmSync(this.#clientDir, { recursive: true, force: true });
    return state;
  }

  async #removeContainer(job: Job): Promise<CleanupState> {
    // prettier-ignore
    const filters = ["--filter", `name=^/${job.name}$`, "--filter", `label=xum.bugbash.owner=${job.owner}`,
      "--filter", `label=xum.bugbash.checkout=${job.checkout}`];
    // Cleanup commands still run after a stop, so they bypass #job().
    const find = () =>
      this.#spawn("docker", ["ps", "-aq", "--no-trunc", ...filters], this.#client!, 15_000);
    const found = await find();
    if (!found.ok) return `unknown: ${found.error}`;
    if (found.stdout === "") return "removed";
    await this.#spawn("docker", ["rm", "-f", ...found.stdout.split("\n")], this.#client!, 30_000);
    const after = await find();
    if (!after.ok) return `unknown: ${after.error}`;
    return after.stdout === "" ? "removed" : `unknown: still present: ${after.stdout}`;
  }

  #stop(reason: string) {
    this.#stopped ??= reason;
    // Only the children of this moment: cleanup commands start later and must finish.
    const victims = [...this.#children.keys()];
    for (const child of victims) child.kill("SIGTERM");
    setTimeout(() => {
      for (const child of victims) if (this.#children.has(child)) child.kill("SIGKILL");
    }, KILL_AFTER_MS).unref();
  }

  async #checkoutKey(): Promise<string> {
    const script = path.join(this.#root, "tests/bugbash/sandbox/build.sh");
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const r = await this.#job(script, ["--key"], env, 30_000);
    if (!r.ok) throw new Refusal(`build.sh --key: ${r.error}`);
    return r.stdout;
  }

  /**
   * Resolves the endpoint of the user's docker CLI once, then uses an empty private client
   * config: the CLI reads no user config (its proxies can hold passwords) after this step.
   */
  async #connect() {
    if (this.#client != null) return;
    if (process.platform !== "linux")
      throw new Refusal(`${process.platform}: the sandbox needs Linux`);
    if (process.getuid?.() === 0) throw new Refusal("the sandbox does not run as root");
    const user: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"])
      if (process.env[key] != null) user[key] = process.env[key];
    const format = "{{.Endpoints.docker.Host}}";
    const context = await this.#job(
      "docker",
      ["context", "inspect", "--format", format],
      user,
      10_000
    );
    if (!context.ok) throw new Refusal(`docker context: ${context.error}`);
    // Fail closed: a remote, ssh or relative endpoint is refused, never swapped for the default.
    if (!/^unix:\/\/\/./.test(context.stdout))
      throw new Refusal(`docker endpoint ${JSON.stringify(context.stdout)}: not a local socket`);
    this.#clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "xum-bugbash-docker-"));
    const client = {
      PATH: user.PATH ?? "",
      DOCKER_HOST: context.stdout,
      DOCKER_CONFIG: this.#clientDir,
    };
    const info = await this.#job("docker", ["info", "--format", "{{json .}}"], client, 15_000);
    if (!info.ok) throw new Refusal(`docker info: ${info.error}`);
    const daemon = JSON.parse(info.stdout) as {
      OSType?: string;
      OperatingSystem?: string;
      SecurityOptions?: string[];
    };
    // `docker info` exits 0 when no daemon answers, with only the client fields.
    if ((daemon.OSType ?? "") === "") throw new Refusal("docker info: no daemon answered");
    if (daemon.OSType !== "linux" || /docker desktop/i.test(daemon.OperatingSystem ?? ""))
      throw new Refusal("Docker Desktop is not supported");
    if ((daemon.SecurityOptions ?? []).some((o) => o.includes("rootless")))
      throw new Refusal("rootless Docker is not supported");
    this.#client = client;
  }

  async #must(args: string[], timeoutMs: number): Promise<Result> {
    const r = await this.#job("docker", args, this.#client!, timeoutMs);
    if (!r.ok) throw new Refusal(`docker ${args[0]}: ${r.error}`);
    return r;
  }

  /** A job command. After a stop it refuses, and a running one ends with Stopped. */
  async #job(cmd: string, args: string[], env: Record<string, string>, timeoutMs: number) {
    if (this.#stopped != null) throw new Stopped(this.#stopped);
    const r = await this.#spawn(cmd, args, env, timeoutMs);
    if (this.#stopped != null) throw new Stopped(this.#stopped);
    return r;
  }

  #spawn(
    cmd: string,
    args: string[],
    env: Record<string, string>,
    timeoutMs: number
  ): Promise<Result> {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const result = new Promise<Result>((resolve) => {
      const done = (code: number | null, why: string) => {
        clearTimeout(timer);
        this.#children.delete(child);
        resolve({
          ok: code === 0,
          stdout: stdout.trim(),
          error: code === 0 ? "" : stderr.trim() || why,
        });
      };
      child.once("error", (error) => done(null, error.message));
      child.once("close", (code, signal) => done(code, `exit ${code ?? signal}`));
    });
    this.#children.set(child, result);
    return result;
  }
}
