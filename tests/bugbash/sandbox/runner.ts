/**
 * The runner library of the bug-bash sandbox (#5714). It finds a local Docker daemon, gets the
 * image, runs commands as tracked async children, runs the job container, and cleans up after a
 * job. launch.ts is its entry point.
 *
 * The image: main's publish workflow ("Bug-bash sandbox image") pushes one stable tag per inputs
 * key (`build.sh --key`) and attests it. ensureImage() looks up the tag of this checkout's key,
 * verifies the attestation with gh, and pulls only `name@digest`. Without a verified image it
 * builds one from this checkout with build.sh (or reuses that local build).
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = fs.realpathSync(path.resolve(import.meta.dir, "../../.."));
export const IMAGE = "ghcr.io/coder/xum-bugbash-sandbox";
/** The only workflow whose attestation ensureImage() accepts, and only from main. */
const PUBLISH_WORKFLOW = "coder/xum/.github/workflows/bugbash-sandbox-image.yml";
/** How long build.sh gets for a local image: a fresh build with no cache. */
const BUILD_MS = 25 * 60_000;
/** How long a child gets after SIGTERM before SIGKILL. */
const KILL_AFTER_MS = 5_000;
/** How long the `docker run` client gets to exit after its lifeline (stdin) closed. */
const GRACE_MS = 60_000;
/** How long one stop hook gets before the lifeline closes anyway: a hung hook must not block it. */
const HOOK_MS = 10_000;
/**
 * A short option, or a flag that names, labels or tracks the container: runJob() sets those. It
 * applies to the docker-run flags only, so the job's own arguments (e2e's `-g`) pass. `--detach`
 * and `--rm=false` pass too: harmless while launch.ts is the only caller, since cleanup removes
 * the container by ID. Refuse them if runJob() ever takes flags from a wider caller.
 */
const CALLER_FLAG = /^(-[^-]|--(name|label|label-file|cidfile)(=|$))/;

export class Refusal extends Error {}
/** The session stopped (a signal, or cleanup started) before this command could finish. */
export class Stopped extends Error {
  constructor(readonly reason: string) {
    super(`stopped: ${reason}`);
  }
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
/** `docker container inspect` output: `/name|owner label|checkout label`. */
const INSPECT = `{{.Name}}|{{index .Config.Labels "xum.bugbash.owner"}}|{{index .Config.Labels "xum.bugbash.checkout"}}`;
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
  /** The start time of each group's leader, read right after its spawn (see groupState). */
  readonly #leaders = new Map<number, string | undefined>();
  /** Per group, the members (`pid:start`) seen while its own leader still ran (groupState). */
  readonly #members = new Map<number, Set<string>>();
  readonly #signalGroup: (group: number, signal: NodeJS.Signals) => void;
  #stopped: string | null = null;
  /** The daemon's `docker info` Architecture, read by #connect for the amd64 check. */
  #architecture = "";
  #client: Record<string, string> | null = null;
  #clientDir: string | null = null;
  #cleanup: Promise<CleanupState> | null = null;
  #owned: Job | null = null;
  readonly #graceMs: number;
  readonly #hookMs: number;
  readonly #stderr: number | "inherit";
  readonly #log: (line: string) => void;
  #hooks: (() => unknown)[] = [];
  /** The `docker run` client, once spawned. A stop never signals it: it closes its stdin. */
  #runClient: ChildProcess | null = null;
  /** Settles once the stop hooks ran and the lifeline closed. */
  #ending: Promise<void> | null = null;
  #cleaning = false;

  /** The entry point aborts `stop` from its SIGINT and SIGTERM handlers. */
  constructor(
    stop: AbortSignal,
    options: {
      root?: string;
      graceMs?: number;
      hookMs?: number;
      /** A file descriptor for the `docker run` client's stderr (the job's output). */
      stderr?: number;
      log?: (line: string) => void;
      /** Injection point: runner.test.ts records the group signals; production uses killGroup. */
      signalGroup?: (group: number, signal: NodeJS.Signals) => void;
    } = {}
  ) {
    this.#signalGroup = options.signalGroup ?? killGroup;
    this.#root = options.root ?? ROOT;
    this.#graceMs = options.graceMs ?? GRACE_MS;
    this.#hookMs = options.hookMs ?? HOOK_MS;
    this.#stderr = options.stderr ?? "inherit";
    this.#log = options.log ?? ((line) => console.error(`sandbox ${line}`));
    if (stop.aborted) this.#stop(String(stop.reason));
    else stop.addEventListener("abort", () => this.#stop(String(stop.reason)), { once: true });
  }

  /**
   * The image of this checkout's inputs key. `local` is null for the image that main's publish
   * workflow built and attested, pulled when missing, as `name@digest`. Otherwise `local` is the
   * reason it is not that image, and the image is a local build of this checkout, as its ID.
   *
   * A local build adds no power over the published image: each job already stages the
   * checkout's git-listed files and mounts its dist/ and node_modules/ (launch.ts). So a job runs
   * either an image that main's publish workflow built and attested, or one built from its own
   * checkout, never one that a registry, a tag or another branch chose.
   */
  async ensureImage(): Promise<{ ref: string; local: string | null }> {
    const key = await this.#checkoutKey();
    await this.#connect();
    this.#checkArchitecture();
    const published = await this.#publishedImage(key);
    let ref: string;
    if (published.ok) {
      ref = published.ref;
      // An empty list with exit 0 means absent. Any failure refuses: it is not "absent".
      const listed = await this.#must(["images", "--no-trunc", "--quiet", ref], 15_000);
      if (listed.stdout === "") await this.#must(["pull", "--quiet", ref], 10 * 60_000);
    } else {
      this.#log(`no verified image for inputs key ${key.slice(0, 16)}: ${published.why}`);
      ref = await this.#localImage(key);
    }
    // The same label check for both: the image must carry the key of this checkout.
    const inspect = ["image", "inspect", "--format", "{{json .Config.Labels}}", ref];
    const labels = JSON.parse((await this.#must(inspect, 15_000)).stdout) as Record<
      string,
      string
    > | null;
    const label = labels?.["org.xum.bugbash.inputs"];
    if (label !== key)
      throw new Refusal(`${ref}: label org.xum.bugbash.inputs is ${label}, not ${key}`);
    return { ref, local: published.ok ? null : published.why };
  }

  /**
   * The stable tag of `key`, looked up anonymously (the private client config), and its
   * attestation, verified by gh on the host. Any outcome but a verified digest gives the reason.
   * A stop still throws Stopped: it is no reason to build.
   */
  async #publishedImage(
    key: string
  ): Promise<{ ok: true; ref: string } | { ok: false; why: string }> {
    const tag = `${IMAGE}:inputs-${key}`;
    const format = "{{json .Manifest.Digest}}";
    const args = ["buildx", "imagetools", "inspect", "--format", format, tag];
    const look = await this.#job("docker", args, this.#client!, 60_000);
    // A missing tag fails with stderr `ERROR: <tag>: not found`.
    if (!look.ok && look.error.endsWith(": not found"))
      return { ok: false, why: `${tag} is not published` };
    if (!look.ok) return { ok: false, why: `the lookup of ${tag} failed: ${lastLine(look.error)}` };
    const digest = /^"(sha256:[0-9a-f]{64})"$/.exec(look.stdout)?.[1];
    if (digest == null)
      return { ok: false, why: `the lookup of ${tag} gave ${JSON.stringify(look.stdout)}` };
    const ref = `${IMAGE}@${digest}`;
    // gh gets the user's login (HOME, or GH_CONFIG_DIR for a custom config folder) or GH_TOKEN,
    // and nothing else of this env. Neither reaches Docker or the container (containerEnv drops
    // the token, and its allowlist has no GH_CONFIG_DIR).
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    };
    for (const name of ["GH_TOKEN", "GH_CONFIG_DIR"])
      if (process.env[name] != null) env[name] = process.env[name];
    // prettier-ignore
    const verify = await this.#job("gh", ["attestation", "verify", `oci://${ref}`, "--repo", "coder/xum",
      "--bundle-from-oci", "--source-ref", "refs/heads/main", "--signer-workflow", PUBLISH_WORKFLOW], env, 120_000);
    if (verify.ok) return { ok: true, ref };
    // Node says `spawn gh ENOENT`, Bun `Executable not found in $PATH: "gh"`.
    if (/ENOENT|Executable not found/.test(verify.error))
      return { ok: false, why: "gh is not installed" };
    // gh exits 4 when it has no login: CI sets GH_TOKEN for the launcher steps.
    if (verify.code === 4)
      return {
        ok: false,
        why: `${ref} is not verified: no gh token (set GH_TOKEN or run gh auth login)`,
      };
    return {
      ok: false,
      why: `${ref} is not verified (gh exit ${verify.code}): ${lastLine(verify.error)}`,
    };
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

  /** Connects to the local daemon as ensureImage() does, and returns the endpoint it uses. */
  async connect(): Promise<string> {
    await this.#connect();
    return this.#client!.DOCKER_HOST;
  }

  /**
   * Every job container of one checkout, of any owner, by its checkout label (#5882). It
   * removes nothing: a launch logs the list, and only recover() removes from it.
   */
  /**
   * The job containers of a checkout. One that cannot be inspected comes back with its `error`
   * and no job: the caller reports it and never removes it (its owner is unknown).
   */
  async listJobs(
    checkout: string
  ): Promise<({ id: string; job: Job } | { id: string; error: string })[]> {
    if (!/^[0-9a-f]{12}$/.test(checkout)) throw new Refusal(`bad checkout ID ${checkout}`);
    const filter = ["--filter", `label=xum.bugbash.checkout=${checkout}`];
    const ps = await this.#must(["ps", "-aq", "--no-trunc", ...filter], 15_000);
    const found: ({ id: string; job: Job } | { id: string; error: string })[] = [];
    for (const id of ps.stdout.split("\n").filter((line) => line !== "")) {
      if (!/^[0-9a-f]{64}$/.test(id)) throw new Refusal(`docker ps: unexpected ID ${id}`);
      const args = ["container", "inspect", "--format", INSPECT, id];
      const look = await this.#job("docker", args, this.#client!, 15_000);
      // Removed since the list: nothing to report. Any other failure is reported, not skipped.
      if (!look.ok && look.error.includes("No such container")) continue;
      if (!look.ok) {
        found.push({ id, error: `docker container inspect: ${look.error}` });
        continue;
      }
      // The label filter picked the checkout; removeJob() checks all three again before a removal.
      const [name, owner] = look.stdout.replace(/^\//, "").split("|");
      found.push({ id, job: { name, owner, checkout } });
    }
    return found;
  }

  /** Removes one listed container by ID, with the same name and label check as cleanup(). */
  removeJob(id: string, job: Job): Promise<CleanupState> {
    if (this.#owned != null) throw new Error("removeJob() is for a session without its own job");
    return this.#removeById(id, job, "the leftover list");
  }

  /** Runs `fn` first on a stop, before the lifeline closes (B1: the provider proxy's close). */
  onStop(fn: () => unknown): void {
    this.#hooks.push(fn);
  }

  /** Stops the session from inside, e.g. when the export receiver refused a frame. */
  stop(reason: string): void {
    this.#stop(reason);
  }

  /**
   * Runs the owned job's container: `docker run --name <job> --label … --cidfile …`, then
   * `flags`, then `command` (the image and its arguments). Its stdin is the lifeline: entry.ts stops the job on EOF, and the container also
   * gets EOF when this process dies. Its stdout goes to `receive`, its stderr to ours. A stop or
   * the timeout closes the lifeline; the client is killed only if it outlives the grace period.
   * cleanup() then removes the container by the ID that the CLI wrote to the cidfile.
   */
  async runJob<T>(
    flags: string[],
    command: [image: string, ...args: string[]],
    receive: (out: Readable) => Promise<T>,
    timeoutMs: number
  ) {
    const job = this.#owned;
    if (job == null) throw new Error("runJob() needs own() first");
    if (this.#stopped != null) throw new Stopped(this.#stopped);
    const flag = flags.find((arg) => CALLER_FLAG.test(arg));
    if (flag != null) throw new Refusal(`runJob() sets ${flag} itself; use long options`);
    // prettier-ignore
    const named = ["run", "--name", job.name, "--label", `xum.bugbash.owner=${job.owner}`,
      "--label", `xum.bugbash.checkout=${job.checkout}`, "--cidfile", this.#cidFile(), ...flags, ...command];
    const received: Promise<T>[] = [];
    const r = await this.#spawn("docker", named, this.#client!, timeoutMs, (child) => {
      this.#runClient = child;
      child.stdin?.on("error", () => undefined); // EPIPE once the container is gone
      const p = receive(child.stdout!);
      p.catch(() => undefined); // handled: the await below rethrows it
      received.push(p);
    });
    return { code: r.code, received: await received[0] };
  }

  /** In the private client folder (0700), which cleanup removes. The CLI refuses an existing one. */
  #cidFile(): string {
    return path.join(this.#clientDir!, "job.cid");
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
    // From here a stop only logs: cleanup commands must finish (#5930 item 3).
    this.#cleaning = true;
    await this.#ending;
    await Promise.all(this.#children.values());
    // Every child closed. A group that still has a member gets SIGKILL now (#5930 item 2).
    for (const group of this.#groups) this.#signal(group, "SIGKILL");
    const left = await this.#groupsGone(2_000);
    // own() needs a client, so an owned job always has one.
    const state = this.#owned == null ? "none" : await this.#removeContainer(this.#owned);
    if (this.#clientDir != null) fs.rmSync(this.#clientDir, { recursive: true, force: true });
    if (left.length > 0) return `unknown: process groups ${left.join(" ")} still run`;
    return state;
  }

  /**
   * The container is gone only when a known ID is no longer found. The ID comes from the
   * cidfile (the create finished), or else from a match by name and both labels. Without either,
   * a spawned `docker run` leaves the state unknown: its create may still finish in the daemon.
   * Cleanup commands still run after a stop, so they bypass #job().
   */
  async #removeContainer(job: Job): Promise<CleanupState> {
    const cid = this.#clientDir == null ? "" : this.#cidFile();
    const written = fs.existsSync(cid) ? fs.readFileSync(cid, "utf8").trim() : "";
    if (written !== "" && !/^[0-9a-f]{64}$/.test(written)) return "unknown: a malformed cidfile";
    if (written !== "") return this.#removeById(written, job, "the cidfile");
    // prettier-ignore
    const filters = ["--filter", `name=^/${job.name}$`, "--filter", `label=xum.bugbash.owner=${job.owner}`,
      "--filter", `label=xum.bugbash.checkout=${job.checkout}`];
    const ps = ["ps", "-aq", "--no-trunc", ...filters];
    const found = await this.#spawn("docker", ps, this.#client!, 15_000);
    if (!found.ok) return `unknown: ${found.error}`;
    const ids = found.stdout.split("\n").filter((line) => line !== "");
    // Docker names are unique, so two matches mean the lookup is not what this code assumes.
    if (ids.length > 1) return `unknown: ${ids.length} containers match the name and labels`;
    if (ids.length === 1) return this.#removeById(ids[0], job, "name and labels");
    if (this.#runClient != null) return "unknown: `docker run` left no container ID";
    return "removed"; // no `docker run` ran, so no container of this job can exist
  }

  /** Removes the container `id` only when its name and both labels are this job's. */
  async #removeById(id: string, job: Job, source: string): Promise<CleanupState> {
    const inspect = () =>
      this.#spawn(
        "docker",
        ["container", "inspect", "--format", INSPECT, id],
        this.#client!,
        15_000
      );
    const short = id.slice(0, 12);
    this.#log(`${job.name} cleanup: container ${short}, ID from ${source}`);
    let look = await inspect();
    if (!look.ok && look.error.includes("No such container")) return "removed";
    if (!look.ok) return `unknown: ${look.error}`;
    if (look.stdout !== `/${job.name}|${job.owner}|${job.checkout}`)
      return `unknown: container ${short} has another name or labels; left in place`;
    await this.#spawn("docker", ["rm", "-f", id], this.#client!, 30_000);
    look = await inspect();
    if (!look.ok && look.error.includes("No such container")) return "removed";
    return `unknown: container ${short} ${look.ok ? "is still present" : look.error}`;
  }

  #stop(reason: string) {
    if (this.#cleaning) return this.#log(`stop (${reason}) during cleanup: cleanup goes on`);
    this.#stopped ??= reason;
    // Only the groups of this moment: cleanup commands start later and must finish. Never the
    // `docker run` client: a signal there can cut the create between the daemon and the cidfile.
    const victims = [...this.#groups].filter((group) => group !== this.#runClient?.pid);
    for (const group of victims) this.#signal(group, "SIGTERM");
    setTimeout(() => {
      for (const group of victims) this.#signal(group, "SIGKILL");
    }, KILL_AFTER_MS).unref();
    this.#ending ??= this.#endJob();
  }

  /** The stop hooks first, then the lifeline; SIGKILL only for a client past the grace period. */
  async #endJob() {
    await Promise.allSettled(this.#hooks.splice(0).map((fn) => this.#bounded(fn)));
    const client = this.#runClient;
    if (client == null || client.exitCode != null || client.signalCode != null) return;
    client.stdin?.end();
    const pid = client.pid;
    const timer = setTimeout(() => {
      this.#log(`docker run did not exit ${this.#graceMs} ms after its lifeline closed: SIGKILL`);
      if (pid != null) this.#signal(pid, "SIGKILL");
    }, this.#graceMs);
    timer.unref();
    client.once("close", () => clearTimeout(timer));
  }

  /** Runs one stop hook, but waits at most #hookMs for it. */
  async #bounded(fn: () => unknown) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.#log(`a stop hook did not settle in ${this.#hookMs} ms: the lifeline closes anyway`);
        resolve();
      }, this.#hookMs);
    });
    try {
      await Promise.race([(async () => fn())(), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Signals a tracked group only while it is still ours: it has a live member and its ID was not
   * reused (groupState). Other agents share this host, so an emptied group is never signalled.
   */
  #signal(group: number, signal: NodeJS.Signals) {
    if (!this.#groups.has(group)) return;
    if (!this.#ours(group)) return;
    this.#signalGroup(group, signal);
  }

  /**
   * Whether a tracked group is still ours. An empty or reused one stops being tracked. An
   * unproved one stays tracked but gets no signal, so cleanup reports it as unknown.
   */
  #ours(group: number): boolean {
    const known = this.#members.get(group) ?? new Set<string>();
    this.#members.set(group, known);
    const state = groupState(group, this.#leaders.get(group), known);
    if (state === "ours") return true;
    if (state === "unproved") return false;
    this.#groups.delete(group);
    this.#leaders.delete(group);
    this.#members.delete(group);
    return false;
  }

  /** Waits until every tracked group is empty, or `ms` ends. Returns the groups left. */
  async #groupsGone(ms: number): Promise<number[]> {
    const end = Date.now() + ms;
    for (;;) {
      for (const group of this.#groups) this.#ours(group);
      if (this.#groups.size === 0 || Date.now() >= end) return [...this.#groups];
      await Bun.sleep(50);
    }
  }

  /**
   * A pull request that changes the image inputs has no published image yet (main publishes it
   * after the merge), so build.sh builds one from its committed source into the local Docker. It
   * runs with the private client config: no registry login, and nothing is pushed. A present image
   * under build.sh's local tag is reused: the self-check runs three jobs, then CI runs the repros.
   */
  async #localImage(key: string): Promise<string> {
    const tag = `xum-bugbash-sandbox:inputs-${key}`; // build.sh's local tag
    let id = (await this.#must(["images", "--no-trunc", "--quiet", tag], 15_000)).stdout;
    if (id === "") {
      this.#log(`building ${tag} with build.sh (up to 25 minutes)`);
      const script = path.join(this.#root, "tests/bugbash/sandbox/build.sh");
      const built = await this.#job(script, [], this.#client!, BUILD_MS);
      // The tail only: the error holds the whole build log.
      if (!built.ok)
        throw new Refusal(`build.sh: ${built.error.split("\n").slice(-20).join("\n")}`);
      id = built.stdout;
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Refusal(`${tag}: unexpected image ID ${id}`);
    return id;
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
      Architecture?: string;
      SecurityOptions?: string[];
    };
    this.#architecture = daemon.Architecture ?? "";
    // `docker info` exits 0 when no daemon answers, with only the client fields.
    if ((daemon.OSType ?? "") === "") throw new Refusal("docker info: no daemon answered");
    if (daemon.OSType !== "linux" || /docker desktop/i.test(daemon.OperatingSystem ?? ""))
      throw new Refusal("Docker Desktop is not supported");
    if ((daemon.SecurityOptions ?? []).some((o) => o.includes("rootless")))
      throw new Refusal("rootless Docker is not supported");
    this.#client = client;
  }

  /**
   * The published image is linux/amd64 only (build.sh), so refuse another daemon architecture
   * before the pull. Emulation is not detected: the review of #6197 found a new way each host-side
   * check of it could be wrong, so the sandbox is amd64 only. Not in #connect: recover() needs no
   * image and works on any host.
   */
  #checkArchitecture() {
    const arch = this.#architecture;
    if (arch === "x86_64" || arch === "amd64") return;
    throw new Refusal(
      `the sandbox image is linux/amd64 and Docker runs on ${arch || "an unknown architecture"}: use an amd64 host`
    );
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
    stream?: (child: ChildProcess) => void
  ): Promise<Result> {
    // detached: its own process group, so a stop or a timeout reaches its children too.
    const stdio =
      stream == null
        ? (["ignore", "pipe", "pipe"] as const)
        : (["pipe", "pipe", this.#stderr] as const);
    const child = spawn(cmd, args, { env, stdio: [...stdio], detached: true });
    let stdout = "";
    let stderr = "";
    if (stream != null) stream(child);
    else child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const group = child.pid;
    if (group != null) {
      this.#groups.add(group);
      this.#leaders.set(group, startTime(String(group)));
    }
    // The job's deadline closes its lifeline like a stop. Other commands get SIGKILL.
    const timer = setTimeout(() => {
      if (stream != null) this.#stop("deadline");
      else if (group != null) this.#signal(group, "SIGKILL");
    }, timeoutMs);
    const result = new Promise<Result>((resolve) => {
      const done = (code: number | null, signal: NodeJS.Signals | null, why: string) => {
        clearTimeout(timer);
        this.#children.delete(child);
        // An empty group is done. A group with members left stays tracked until cleanup.
        if (group != null) this.#ours(group);
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

/** The last line of a command's stderr: a reason line, not the whole log. */
const lastLine = (error: string) => error.split("\n").at(-1) ?? "";

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

/** Fields of /proc/<pid>/stat after the command name: state, ppid, pgrp, ..., start time. */
function readStat(pid: string, proc: string): string[] | undefined {
  try {
    const stat = fs.readFileSync(path.join(proc, pid, "stat"), "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return undefined; // the process is gone, or not ours to read
  }
}
const startTime = (pid: string, proc = "/proc") => readStat(pid, proc)?.[19];

/**
 * Whether the process group `group` is still the one this session started. Linux gives a group
 * ID to a new process only after the old group emptied, and a group whose leader exited has no
 * process left that names its creator, so ownership is proved in two ways only:
 * - "ours", with our leader: the process with the group's ID is the leader this session
 *   spawned (same start time; it may be a zombie that the runtime has not reaped). Its live
 *   members are added to `known`.
 * - "ours", without a leader: every live member is in `known`, seen while our leader ran.
 * "reused": another process (also a zombie) has the group's ID as its PID. "none": no live
 * (non-zombie) member. "unproved": live members, no leader, and one of them unknown: maybe our
 * leader's late child, maybe a stranger in a reused group. It never gets a signal. The check
 * reads /proc right before each signal, so a reuse would have to fall into that short window.
 */
export function groupState(
  group: number,
  leaderStart: string | undefined,
  known: Set<string>,
  proc = "/proc"
): "ours" | "none" | "reused" | "unproved" {
  const members: string[] = [];
  let leader = false;
  for (const pid of fs.readdirSync(proc)) {
    if (!/^\d+$/.test(pid)) continue;
    const fields = readStat(pid, proc);
    if (fields?.[2] !== String(group)) continue;
    if (pid === String(group)) {
      if (leaderStart == null || fields[19] !== leaderStart) return "reused";
      leader = true;
    }
    if (!/^[ZX]$/.test(fields[0])) members.push(`${pid}:${fields[19]}`);
  }
  if (members.length === 0) return "none";
  if (leader) for (const member of members) known.add(member);
  return leader || members.every((member) => known.has(member)) ? "ours" : "unproved";
}
