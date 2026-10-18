import * as fs from "fs/promises";
import * as path from "path";
import type { AgentResourceLimits } from "@/common/config/schemas/agentResourceLimits";
import type { AgentResourceLimitsStatus } from "@/common/orpc/schemas/agentResourceLimits";
import { getErrorMessage } from "@/common/utils/errors";
import { agentCgroupEnrollmentLine } from "@/node/runtime/agentCgroupEnrollment";
import { log } from "@/node/services/log";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { execFileAsync } from "@/node/utils/disposableExec";
import { getBashPath } from "@/node/utils/main/bashPath";

/** The kernel's default `cpu.max` period, in microseconds. */
const CPU_PERIOD_US = 100_000;
const AGENTS_CGROUP = "xum-agents";
/**
 * Where the processes of xum's cgroup move when it must enable controllers: a cgroup that holds
 * processes cannot enable controllers for its children.
 */
const APP_CGROUP = "xum-app";
const MAX_ENABLE_ATTEMPTS = 5;
const PROBE_TIMEOUT_MS = 10_000;
/**
 * The docs' "With sudo" steps, run as root: `$1` is the cgroup directory, `$2` the uid that gets
 * it, `$3` xum's PID. xum moves straight into xum-app, because a restarted xum finds the
 * controllers of `$1` enabled, and such a cgroup cannot take processes itself.
 */
const SUDO_DELEGATE_SCRIPT = `set -e
mkdir -p "$1/xum-app"
for dir in "$1" "$1/xum-app"; do
  chown "$2" "$dir" "$dir/cgroup.procs" "$dir/cgroup.subtree_control" "$dir/cgroup.threads"
done
echo "$3" > "$1/xum-app/cgroup.procs"`;
/**
 * The error of each host's last failed sudo delegation. Applies that may not run sudo report it,
 * so the status keeps the sudo error until an apply that may run sudo succeeds or fails again, or
 * the limits are cleared, after which the old sudo error no longer describes them.
 */
const failedSudoDelegations = new WeakMap<AgentCgroupHost, string>();

type Controller = "cpu" | "memory";

/** The host facts and kernel writes that applying limits needs; tests replace them. */
export interface AgentCgroupHost {
  platform: NodeJS.Platform;
  /** Mount point of the cgroup v2 hierarchy. */
  cgroupRoot: string;
  /** Contents of `/proc/self/cgroup`. */
  readSelfCgroup: () => Promise<string>;
  /** Write one value to a cgroup interface file. */
  writeFile: (file: string, value: string) => Promise<void>;
  /** Start a shell with the enrollment line for `procsFile`; returns its `/proc/self/cgroup`. */
  probeEnrollment: (procsFile: string) => Promise<string>;
  /** The uid of the xum process, or undefined where the platform has none. */
  uid: number | undefined;
  /** Whether systemd manages the host's cgroup tree. */
  isSystemdBooted: () => Promise<boolean>;
  /** With `sudo -n`, create `cgroupDir` and its xum-app child for xum's user and move xum in. */
  delegateWithSudo: (cgroupDir: string) => Promise<void>;
}

export interface AgentCgroupResult {
  status: AgentResourceLimitsStatus;
  /** The `cgroup.procs` file new agent shells join, or null when no limit applies. */
  enrollmentTarget: string | null;
}

export const linuxAgentCgroupHost: AgentCgroupHost = {
  platform: process.platform,
  cgroupRoot: "/sys/fs/cgroup",
  readSelfCgroup: () => fs.readFile("/proc/self/cgroup", "utf-8"),
  writeFile: (file, value) => fs.writeFile(file, value),
  probeEnrollment: async (procsFile) => {
    using probe = execFileAsync(
      getBashPath(),
      ["-c", `${agentCgroupEnrollmentLine(procsFile)}cat /proc/self/cgroup`],
      { timeoutMs: PROBE_TIMEOUT_MS }
    );
    return (await probe.result).stdout;
  },
  uid: process.getuid?.(),
  isSystemdBooted: async () => {
    try {
      await fs.access("/run/systemd/system");
      return true;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  },
  delegateWithSudo: async (cgroupDir) => {
    const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    // The abort sends SIGTERM to sudo, which relays it to the root script. No tree kill: a user
    // cannot signal root's processes, and a SIGKILL that sudo cannot relay would leave the root
    // script running, so it could still move xum after the status reported a failure.
    using sudo = execFileAsync(
      "sudo",
      [
        "-n",
        "sh",
        "-c",
        SUDO_DELEGATE_SCRIPT,
        "sh",
        cgroupDir,
        String(linuxAgentCgroupHost.uid),
        String(process.pid),
      ],
      { signal: timeout }
    );
    // The result settles only once sudo's pipes close, and a root descendant that outlives the
    // SIGTERM can hold them open, so the timeout also settles the call on its own.
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout.addEventListener("abort", () => reject(new Error("sudo timed out")), { once: true });
    });
    try {
      await Promise.race([sudo.result, timedOut]);
    } catch (error) {
      if (timeout.aborted) {
        log.debug("sudo was stopped after its timeout", { error: getErrorMessage(error) });
        throw new Error(`sudo did not finish within ${PROBE_TIMEOUT_MS / 1000} seconds.`);
      }
      throw error;
    }
  },
};

export function cpuMaxValue(cpuCores: number | undefined): string {
  return cpuCores === undefined
    ? `max ${CPU_PERIOD_US}`
    : `${Math.round(cpuCores * CPU_PERIOD_US)} ${CPU_PERIOD_US}`;
}

export function memoryMaxValue(memoryGiB: number | undefined): string {
  return memoryGiB === undefined ? "max" : String(Math.round(memoryGiB * 2 ** 30));
}

/** The cgroup v2 path in `/proc/self/cgroup` (the `0::` line), or null outside cgroup v2. */
export function parseSelfCgroup(contents: string): string | null {
  for (const line of contents.split("\n")) {
    if (line.startsWith("0::")) {
      return line.slice(3).trim() || null;
    }
  }
  return null;
}

/**
 * Apply `limits` to the `xum-agents` cgroup under xum's own cgroup, creating it when needed.
 * It works only when xum's own cgroup (or its parent, after xum moved into `xum-app`) is writable
 * by the user that runs xum, or when xum can delegate a cgroup to itself with sudo.
 *
 * `trySudo` is set only for applies a user asked for (startup, a save, the switch, Try again).
 * Every config write re-applies limits that are not applied, and on a host where sudo needs a
 * password each sudo call can add an auth-log entry or incident mail.
 */
export async function applyAgentCgroupLimits(
  limits: AgentResourceLimits,
  host: AgentCgroupHost,
  options: { trySudo: boolean } = { trySudo: false }
): Promise<AgentCgroupResult> {
  const needed = neededControllers(limits);
  if (needed.length === 0) {
    failedSudoDelegations.delete(host);
    try {
      await clearAgentCgroupLimits(host);
    } catch (error) {
      // Agent processes still in xum-agents keep the old limits, so report them as a failure.
      return unavailable(
        `Could not remove the limits from the agent cgroup: ${getErrorMessage(error)}`
      );
    }
    return { status: { state: "off" }, enrollmentTarget: null };
  }

  const found = await findBaseCgroup(host);
  if (typeof found !== "string") {
    return found;
  }
  const base = await findManageableBase(found, options.trySudo, host);
  if (typeof base !== "string") {
    return base;
  }
  const baseDir = path.join(host.cgroupRoot, base);
  const problem = await findMissingControllers(base, baseDir, needed);
  if (problem !== null) {
    return problem;
  }
  try {
    return await setUpAgentsCgroup(base, baseDir, limits, needed, host);
  } catch (error) {
    return unavailable(
      `Could not set up cgroup ${base}/${AGENTS_CGROUP}: ${getErrorMessage(error)}`
    );
  }
}

function neededControllers(limits: AgentResourceLimits): Controller[] {
  const needed: Controller[] = [];
  if (limits.cpuCores !== undefined) needed.push("cpu");
  if (limits.memoryGiB !== undefined) needed.push("memory");
  return needed;
}

/**
 * `base` when the user running xum can manage it. Otherwise, on a host without systemd where xum
 * runs in a top-level cgroup, the cgroup that xum delegated to itself with sudo, as the docs'
 * "With sudo" steps do.
 */
async function findManageableBase(
  base: string,
  trySudo: boolean,
  host: AgentCgroupHost
): Promise<string | AgentCgroupResult> {
  const accessError = await findAccessError(path.join(host.cgroupRoot, base));
  if (accessError === null) {
    return base;
  }
  const reason = cannotManageReason(base, accessError);
  const delegated = await findSudoDelegationTarget(base, host);
  if (delegated === null) {
    return unavailable(reason);
  }
  if (!trySudo) {
    const failed = failedSudoDelegations.get(host);
    return unavailable(failed === undefined ? reason : sudoFailedReason(reason, delegated, failed));
  }
  try {
    await host.delegateWithSudo(path.join(host.cgroupRoot, delegated));
  } catch (error) {
    const sudoError = getErrorMessage(error);
    failedSudoDelegations.set(host, sudoError);
    return unavailable(sudoFailedReason(reason, delegated, sudoError));
  }
  failedSudoDelegations.delete(host);
  log.info("Delegated a cgroup to xum with sudo", { cgroup: delegated });
  const moved = await findBaseCgroup(host);
  if (typeof moved !== "string") {
    return moved;
  }
  const movedError = await findAccessError(path.join(host.cgroupRoot, moved));
  return movedError === null ? moved : unavailable(cannotManageReason(moved, movedError));
}

/** The top-level cgroup that xum may delegate to itself with sudo, or null when it must not. */
async function findSudoDelegationTarget(
  base: string,
  host: AgentCgroupHost
): Promise<string | null> {
  if (host.uid === undefined) {
    return null;
  }
  const own = parseSelfCgroup(await host.readSelfCgroup());
  // A sibling of a nested cgroup such as /docker/<id> would escape the container's limits.
  if (own !== base || path.posix.dirname(own) !== "/") {
    return null;
  }
  // systemd owns the tree on its hosts; delegation there goes through systemd-run instead.
  if (await host.isSystemdBooted()) {
    return null;
  }
  return `/xum-${host.uid}`;
}

/** Why the user running xum cannot manage the cgroup at `baseDir`, or null when it can. */
async function findAccessError(baseDir: string): Promise<string | null> {
  for (const file of [
    baseDir,
    ...["cgroup.procs", "cgroup.subtree_control"].map((name) => path.join(baseDir, name)),
  ]) {
    try {
      await fs.access(file, fs.constants.W_OK);
    } catch (error) {
      return getErrorMessage(error);
    }
  }
  return null;
}

function cannotManageReason(base: string, accessError: string): string {
  return `xum runs in cgroup ${base}, which the user running xum cannot manage (${accessError}). Start xum in a cgroup delegated to that user.`;
}

function sudoFailedReason(reason: string, delegated: string, sudoError: string): string {
  return `${reason} Delegating ${delegated} with sudo failed: ${sudoError}`;
}

/** Why the base cgroup lacks a controller that the limits need, or null when it has them. */
async function findMissingControllers(
  base: string,
  baseDir: string,
  needed: Controller[]
): Promise<AgentCgroupResult | null> {
  const controllers = await readWords(path.join(baseDir, "cgroup.controllers"));
  const missing = needed.filter((controller) => !controllers.includes(controller));
  if (missing.length > 0) {
    return unavailable(
      `The ${missing.join(" and ")} controller is not available in cgroup ${base}. Enable it in the parent cgroup's cgroup.subtree_control.`
    );
  }
  return null;
}

async function setUpAgentsCgroup(
  base: string,
  baseDir: string,
  limits: AgentResourceLimits,
  needed: Controller[],
  host: AgentCgroupHost
): Promise<AgentCgroupResult> {
  await enableControllers(baseDir, needed, host);
  const agentsDir = path.join(baseDir, AGENTS_CGROUP);
  await fs.mkdir(agentsDir, { recursive: true });
  await writeLimits(baseDir, limits, host);
  const procsFile = path.join(agentsDir, "cgroup.procs");
  const agentsCgroup = path.posix.join(base, AGENTS_CGROUP);
  const probed = parseSelfCgroup(await host.probeEnrollment(procsFile));
  if (probed !== agentsCgroup) {
    return unavailable(`A test command ran in cgroup ${probed ?? "unknown"}, not ${agentsCgroup}.`);
  }
  return { status: { state: "active", cgroup: agentsCgroup }, enrollmentTarget: procsFile };
}

/** Remove the limits from an existing `xum-agents` cgroup, for agent processes still in it. */
async function clearAgentCgroupLimits(host: AgentCgroupHost): Promise<void> {
  if (host.platform !== "linux") {
    return;
  }
  const base = await findBaseCgroup(host);
  if (typeof base !== "string") {
    return;
  }
  const baseDir = path.join(host.cgroupRoot, base);
  try {
    await fs.access(path.join(baseDir, AGENTS_CGROUP));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  await writeLimits(baseDir, {}, host);
}

/** xum's cgroup, or its parent when xum already moved into `xum-app`. */
async function findBaseCgroup(host: AgentCgroupHost): Promise<string | AgentCgroupResult> {
  if (host.platform !== "linux") {
    return unavailable("Agent resource limits need Linux with cgroup v2.");
  }
  const own = parseSelfCgroup(await host.readSelfCgroup());
  try {
    await fs.access(path.join(host.cgroupRoot, "cgroup.controllers"));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
    return unavailable(`No cgroup v2 hierarchy is mounted at ${host.cgroupRoot}.`);
  }
  if (own === null) {
    return unavailable("xum does not run in a cgroup v2 hierarchy.");
  }
  if (own === "/") {
    // Setting up here would move every process of the host or container into xum-app.
    return unavailable("xum runs in the root cgroup. Start xum in a cgroup of its own.");
  }
  const name = path.posix.basename(own);
  if (name === AGENTS_CGROUP) {
    // Setting up here would move the outer xum's agent processes and break their enrollment.
    return unavailable(
      `xum runs in cgroup ${own}, the agent cgroup of another xum, whose limits already apply.`
    );
  }
  return name === APP_CGROUP ? path.posix.dirname(own) : own;
}

async function enableControllers(
  baseDir: string,
  needed: Controller[],
  host: AgentCgroupHost
): Promise<void> {
  const subtreeControl = path.join(baseDir, "cgroup.subtree_control");
  const enabled = await readWords(subtreeControl);
  const toEnable = needed.filter((controller) => !enabled.includes(controller));
  if (toEnable.length === 0) {
    return;
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      await host.writeFile(
        subtreeControl,
        toEnable.map((controller) => `+${controller}`).join(" ")
      );
      return;
    } catch (error) {
      // EBUSY: the cgroup still holds processes, such as ones started since the last move.
      if (!hasErrorCode(error, "EBUSY") || attempt >= MAX_ENABLE_ATTEMPTS) {
        throw error;
      }
      await moveProcesses(baseDir, path.join(baseDir, APP_CGROUP), host);
    }
  }
}

async function moveProcesses(fromDir: string, toDir: string, host: AgentCgroupHost): Promise<void> {
  await fs.mkdir(toDir, { recursive: true });
  for (const pid of await readWords(path.join(fromDir, "cgroup.procs"))) {
    try {
      await host.writeFile(path.join(toDir, "cgroup.procs"), pid);
    } catch (error) {
      // ESRCH: the process exited after the list was read; there is nothing left to move.
      if (!hasErrorCode(error, "ESRCH")) {
        throw error;
      }
    }
  }
}

/** Write the limits of `xum-agents`, or `max` for a limit that is not set. */
async function writeLimits(
  baseDir: string,
  limits: AgentResourceLimits,
  host: AgentCgroupHost
): Promise<void> {
  const agentsDir = path.join(baseDir, AGENTS_CGROUP);
  // A controller's files exist in xum-agents only while the controller is on in its parent.
  const enabled = await readWords(path.join(baseDir, "cgroup.subtree_control"));
  if (enabled.includes("cpu")) {
    await host.writeFile(path.join(agentsDir, "cpu.max"), cpuMaxValue(limits.cpuCores));
  }
  if (enabled.includes("memory")) {
    await host.writeFile(path.join(agentsDir, "memory.max"), memoryMaxValue(limits.memoryGiB));
  }
}

async function readWords(file: string): Promise<string[]> {
  return (await fs.readFile(file, "utf-8")).split(/\s+/).filter((word) => word.length > 0);
}

function unavailable(reason: string): AgentCgroupResult {
  return { status: { state: "unavailable", reason }, enrollmentTarget: null };
}
