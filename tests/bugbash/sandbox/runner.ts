/**
 * The runner library of the bug-bash sandbox (#5714). It finds a local Docker daemon, gets the
 * pinned image, runs commands as tracked async children, runs the job container, and cleans up
 * after a job. launch.ts is its entry point.
 *
 * The trust anchor is the digest in image.json, which a reviewed pull request sets. The runner
 * pulls only `name@digest` and never builds. It refuses when the inputs key of this checkout
 * (`build.sh --key`) differs from image.json: that image was built for other inputs, and a
 * person must publish a new one (workflow "Bug-bash sandbox image") and update image.json.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
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
  /** The shell convention: the exit code, or 128 + the number of the signal that ended it. */
  code: number;
  stdout: string;
  error: string;
}
/** A job container, matched by its name and both labels, never by the name alone. */
export interface Job {
  readonly name: string;
  readonly owner: string;
  readonly checkout: string;
}
/** "none": the session owned no job, so no container can exist. */
export type CleanupState = "none" | "removed" | `unknown: ${string}`;
/** The container name goes into a `name=^/…$` filter, which is a regex: no dots, no specials. */
const CONTAINER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class Session {
  readonly #root: string;
  readonly #children = new Map<ChildProcess, Promise<Result>>();
  /**
   * The process groups of all commands, by leader PID, until they are empty. A group outlives its
   * leader when a member ignores SIGTERM, so a stop signals groups, not children (#5877).
   */
  readonly #groups = new Set<number>();
  #stopped: string | null = null;
  #client: Record<string, string> | null = null;
  #clientDir: string | null = null;
  #cleanup: Promise<CleanupState> | null = null;
  #owned: Job | null = null;
  /** The ID that `docker create` returned, and whether its outcome is unknown (a killed CLI). */
  #createdId: string | null = null;
  #createUnknown = false;
  /** Groups that a stop must not signal: a create that must run to its end. */
  readonly #protected = new Set<number>();
  /** Set once cleanup has stopped the job: a later signal must not end cleanup's commands. */
  #cleaning = false;

  /** The entry point aborts `stop` from its SIGINT and SIGTERM handlers. */
  constructor(stop: AbortSignal, options: { root?: string } = {}) {
    this.#root = options.root ?? ROOT;
    if (stop.aborted) this.#stop(String(stop.reason));
    else
      stop.addEventListener(
        "abort",
        () => {
          if (!this.#cleaning) this.#stop(String(stop.reason));
        },
        { once: true }
      );
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
   * Registers the one job container of this session. The launcher calls it before `docker run`,
   * so cleanup always knows the container it must remove. After a stop it refuses: cleanup may
   * already be done, and the container must then never start.
   */
  own(job: Job): void {
    if (this.#stopped != null) throw new Stopped(this.#stopped);
    if (this.#owned != null) throw new Error("a session owns one job only");
    if (this.#client == null)
      throw new Error("own() needs a connected session: ensureImage() first");
    if (!CONTAINER_NAME.test(job.name))
      throw new Refusal(`bad container name ${JSON.stringify(job.name)}`);
    // A frozen copy: a later change to the caller's object cannot change what cleanup removes.
    this.#owned = Object.freeze({ name: job.name, owner: job.owner, checkout: job.checkout });
  }

  /**
   * Runs the owned job's container: `docker run --name <job> --label …` and then `args`. Its
   * stdin is the lifeline: entry.ts stops the job on EOF, so it ends when this process dies. Its
   * stdout goes to `receive`, its stderr to ours. A stop or the timeout ends the docker client,
   * and cleanup() removes the container.
   */
  async runJob<T>(args: string[], receive: (out: Readable) => Promise<T>, timeoutMs: number) {
    const job = this.#owned;
    if (job == null) throw new Error("runJob() needs own() first");
    if (this.#stopped != null) throw new Stopped(this.#stopped);
    // The name and both labels are what cleanup matches, so no caller arg may set them: docker
    // takes the last --name, and an extra label would not matter, but a label file could.
    const setsName = args.find((a) => /^(--name|--label|--label-file|-l)(=|$)/.test(a));
    if (setsName != null) throw new Error(`runJob() sets the name and labels itself: ${setsName}`);
    // Create, then start: a stop in between starts nothing. The create runs to its end even
    // after a stop, because killing its CLI does not cancel the daemon's create, and only a
    // finished create tells cleanup whether a container exists.
    // prettier-ignore
    const create = ["create", "--name", job.name, "--label", `xum.bugbash.owner=${job.owner}`,
      "--label", `xum.bugbash.checkout=${job.checkout}`, ...args];
    const created = await this.#spawn("docker", create, this.#client!, 60_000, undefined, true);
    if (!created.ok && created.code > 128) this.#createUnknown = true;
    if (this.#stopped != null) throw new Stopped(this.#stopped);
    if (!created.ok) throw new Error(`docker create: ${created.error}`);
    this.#createdId = created.stdout;
    const received: Promise<T>[] = [];
    const start = ["start", "--attach", "--interactive", this.#createdId];
    const r = await this.#spawn("docker", start, this.#client!, timeoutMs, (child) => {
      child.stdin?.on("error", () => undefined); // EPIPE once the container is gone
      const p = receive(child.stdout!);
      // A receiver that gives up reads no more output, so the job would only end at the
      // timeout. End the docker client now: the lifeline then stops the job.
      p.catch(() => {
        if (child.pid != null) this.#terminate([child.pid]);
      });
      received.push(p);
    });
    return { code: r.code, received: await received[0] };
  }

  /**
   * One cleanup for success, error and stop: later calls get the same promise. It stops the
   * session, waits for every child, and removes the owned job's container. It reports an unknown
   * container state instead of success, and it never removes an image.
   */
  cleanup(): Promise<CleanupState> {
    this.#cleanup ??= this.#runCleanup();
    return this.#cleanup;
  }

  async #runCleanup(): Promise<CleanupState> {
    this.#stop("cleanup");
    this.#cleaning = true;
    await Promise.all(this.#children.values());
    // The SIGKILL of #stop() comes after KILL_AFTER_MS, so the groups end by then.
    const left = await this.#groupsGone(KILL_AFTER_MS + 2_000);
    // own() needs a client, so an owned job always has one.
    const state = this.#owned == null ? "none" : await this.#removeContainer(this.#owned);
    if (this.#clientDir != null) fs.rmSync(this.#clientDir, { recursive: true, force: true });
    if (left.length > 0) return `unknown: process groups ${left.join(" ")} still run`;
    return state;
  }

  /**
   * Finds the job's container by its exact name, also when create never returned an ID, and
   * removes it only after its name, both labels and the created ID match.
   */
  async #removeContainer(job: Job): Promise<CleanupState> {
    const found = await this.#inspect(job.name);
    if (found === "absent")
      return this.#createUnknown ? "unknown: the create's outcome is unknown" : "removed";
    if ("error" in found) return `unknown: ${found.error}`;
    const ours =
      found.name === `/${job.name}` &&
      found.owner === job.owner &&
      found.checkout === job.checkout &&
      (this.#createdId == null || found.id === this.#createdId);
    if (!ours) return `unknown: ${job.name} is not this job's container, so it stays`;
    // Cleanup commands still run after a stop, so they bypass #job().
    await this.#spawn("docker", ["rm", "-f", found.id], this.#client!, 30_000);
    const after = await this.#inspect(found.id);
    if (after === "absent") return "removed";
    return "error" in after ? `unknown: ${after.error}` : `unknown: still present: ${found.id}`;
  }

  /** The container with this exact name or ID, "absent", or the error of the lookup. */
  async #inspect(ref: string) {
    // prettier-ignore
    const format = ["{{.Id}}", "{{.Name}}", '{{index .Config.Labels "xum.bugbash.owner"}}',
      '{{index .Config.Labels "xum.bugbash.checkout"}}'].join(" ");
    const args = ["container", "inspect", "--format", format, "--", ref];
    const r = await this.#spawn("docker", args, this.#client!, 15_000);
    if (!r.ok) return /No such (container|object)/.test(r.error) ? "absent" : { error: r.error };
    const [id = "", name = "", owner = "", checkout = ""] = r.stdout.split(" ");
    return { id, name, owner, checkout };
  }

  #stop(reason: string) {
    this.#stopped ??= reason;
    // Only the groups of this moment: cleanup commands start later and must finish.
    this.#terminate([...this.#groups].filter((group) => !this.#protected.has(group)));
  }

  /** SIGTERM to each group now, SIGKILL to the ones left after the grace period. */
  #terminate(victims: number[]) {
    for (const group of victims) this.#signal(group, "SIGTERM");
    setTimeout(() => {
      for (const group of victims) this.#signal(group, "SIGKILL");
    }, KILL_AFTER_MS).unref();
  }

  /**
   * Signals a tracked group that still has a member. A group ID stays reserved while any member
   * lives, so a signal right after a live probe cannot reach a new group with a reused ID.
   */
  #signal(group: number, signal: NodeJS.Signals) {
    if (!this.#groups.has(group)) return;
    if (!groupAlive(group)) this.#groups.delete(group);
    else killGroup(group, signal);
  }

  /** Waits until every tracked group is empty, or `ms` ends. Returns the groups left. */
  async #groupsGone(ms: number): Promise<number[]> {
    const end = Date.now() + ms;
    for (;;) {
      for (const group of this.#groups) if (!groupAlive(group)) this.#groups.delete(group);
      if (this.#groups.size === 0 || Date.now() >= end) return [...this.#groups];
      await Bun.sleep(50);
    }
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
    // #job() already throws after a stop. This check keeps it so if code moves in between: a
    // folder made after cleanup would never be removed (#5877).
    if (this.#stopped != null) throw new Stopped(this.#stopped);
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

  /** With `stream`, the child gets a stdin pipe and our stderr, and `stream` reads its stdout. */
  #spawn(
    cmd: string,
    args: string[],
    env: Record<string, string>,
    timeoutMs: number,
    stream?: (child: ChildProcess) => void,
    protect = false
  ): Promise<Result> {
    // detached: its own process group, so a stop or a timeout reaches its children too.
    const stdio =
      stream == null
        ? (["ignore", "pipe", "pipe"] as const)
        : (["pipe", "pipe", "inherit"] as const);
    const child = spawn(cmd, args, { env, stdio: [...stdio], detached: true });
    let stdout = "";
    let stderr = "";
    if (stream != null) stream(child);
    else child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const group = child.pid;
    if (group != null) this.#groups.add(group);
    if (group != null && protect) this.#protected.add(group);
    const timer = setTimeout(() => {
      if (group != null) this.#signal(group, "SIGKILL");
    }, timeoutMs);
    const result = new Promise<Result>((resolve) => {
      const done = (code: number | null, signal: NodeJS.Signals | null, why: string) => {
        clearTimeout(timer);
        this.#children.delete(child);
        // An empty group is done. A group with members left stays tracked until cleanup.
        if (group != null && !groupAlive(group)) this.#groups.delete(group);
        resolve({
          ok: code === 0,
          code: code ?? (signal != null ? 128 + os.constants.signals[signal] : 1),
          stdout: stdout.trim(),
          error: code === 0 ? "" : stderr.trim() || why,
        });
      };
      child.once("error", (error) => done(null, null, error.message));
      child.once("close", (code, signal) => done(code, signal, `exit ${code ?? signal}`));
    });
    this.#children.set(child, result);
    return result;
  }
}

// ESRCH: the group is empty. EPERM: its members belong to another user, so it is not a group
// that this session started (every command runs as this user). Neither is an error here: these
// run from timers, where a throw would end the launcher before cleanup.
const GONE = new Set(["ESRCH", "EPERM"]);

/** Signals a process group. A group that just emptied is no error. */
function killGroup(group: number, signal: NodeJS.Signals) {
  try {
    process.kill(-group, signal);
  } catch (error) {
    if (!GONE.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

/** Whether a process group of this user has a member: signal 0 tests it without a signal. */
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if (GONE.has((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
