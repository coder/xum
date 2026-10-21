import * as fs from "fs/promises";
import * as path from "path";
import type { AgentResourceLimits } from "@/common/config/schemas/agentResourceLimits";
import type {
  AgentResourceLimitsStatus,
  AgentResourceLimitsSupport,
} from "@/common/orpc/schemas/agentResourceLimits";
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
/** The files that delegate a cgroup to a user, besides its directory (see the kernel's cgroup-v2.rst). */
const DELEGATION_FILES = ["cgroup.procs", "cgroup.subtree_control", "cgroup.threads"];
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
  /** With `sudo -n`, give the cgroup at `cgroupDir` to xum's user, as the docs' sudo step does. */
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
    // The abort sends SIGTERM to sudo, which relays it to chown. No tree kill: a user cannot
    // signal root's processes, and a SIGKILL that sudo cannot relay would leave chown running, so
    // it could still give the cgroup away after the status reported a failure.
    using sudo = execFileAsync(
      "sudo",
      [
        "-n",
        "chown",
        String(linuxAgentCgroupHost.uid),
        cgroupDir,
        ...DELEGATION_FILES.map((name) => path.join(cgroupDir, name)),
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
 * Apply `limits` to the `xum-agents` cgroup under the base cgroup, creating it when needed. The
 * base cgroup is xum's own cgroup, or its parent once xum moved into `xum-app`, and the user that
 * runs xum must be able to manage it, or xum must be able to give it to that user with sudo.
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

  const plan = await planAgentCgroup(needed, host);
  if (plan.state === "unsupported" || plan.state === "unavailable") {
    return unavailable(plan.reason);
  }
  if (plan.state === "sudo") {
    const problem = await delegateBaseWithSudo(plan, options.trySudo, host);
    if (problem !== null) {
      return problem;
    }
  }
  const baseDir = path.join(host.cgroupRoot, plan.base);
  try {
    return await setUpAgentsCgroup(plan.base, baseDir, limits, needed, host);
  } catch (error) {
    return unavailable(
      `Could not set up cgroup ${plan.base}/${AGENTS_CGROUP}: ${getErrorMessage(error)}`
    );
  }
}

/**
 * What applying `limits` takes where xum runs now. It changes nothing and runs no sudo, so
 * Settings can show it before the limits are turned on. With no limit set, it checks both
 * controllers, as for the limits a user would set.
 */
export async function checkAgentCgroupSupport(
  limits: AgentResourceLimits,
  host: AgentCgroupHost
): Promise<AgentResourceLimitsSupport> {
  const needed = neededControllers(limits);
  try {
    const plan = await planAgentCgroup(needed.length > 0 ? needed : ["cpu", "memory"], host);
    return plan.state === "ready" || plan.state === "sudo"
      ? { state: plan.state, cgroup: plan.base }
      : plan;
  } catch (error) {
    return { state: "unavailable", reason: getErrorMessage(error) };
  }
}

function neededControllers(limits: AgentResourceLimits): Controller[] {
  const needed: Controller[] = [];
  if (limits.cpuCores !== undefined) needed.push("cpu");
  if (limits.memoryGiB !== undefined) needed.push("memory");
  return needed;
}

type AgentCgroupFailure = Extract<
  AgentResourceLimitsSupport,
  { state: "unsupported" | "unavailable" }
>;

/** The base cgroup, and whether the user running xum must get it with sudo first. */
type AgentCgroupPlan =
  | AgentCgroupFailure
  | { state: "ready"; base: string }
  /** `reason` says why the user running xum cannot manage `base` until sudo gives it to them. */
  | { state: "sudo"; base: string; reason: string };

async function planAgentCgroup(
  needed: Controller[],
  host: AgentCgroupHost
): Promise<AgentCgroupPlan> {
  const found = await findBaseCgroup(host);
  if ("state" in found) {
    return found;
  }
  const baseDir = path.join(host.cgroupRoot, found.base);
  const accessError = await findAccessError(baseDir);
  let plan: AgentCgroupPlan = { state: "ready", base: found.base };
  if (accessError !== null) {
    const reason = cannotManageReason(found.base, accessError);
    if (!(await mayDelegateWithSudo(found.own, found.base, host))) {
      return { state: "unavailable", reason };
    }
    plan = { state: "sudo", base: found.base, reason };
  }
  // Checked before sudo, which would not help a cgroup that lacks a controller.
  const missing = await findMissingControllers(found.base, baseDir, needed);
  return missing === null ? plan : { state: "unavailable", reason: missing };
}

/**
 * Whether xum may give its cgroup `base` to its user with sudo. Xum and its agents stay inside
 * `base` then, so the limits that apply to `base` keep applying to them.
 */
async function mayDelegateWithSudo(
  own: string,
  base: string,
  host: AgentCgroupHost
): Promise<boolean> {
  // xum must run in `base` itself: a base that already holds xum-app was set up by the user that
  // owns it. A nested cgroup, such as /docker/<id> in a container without a cgroup namespace,
  // belongs to the container manager outside.
  if (host.uid === undefined || own !== base || path.posix.dirname(base) !== "/") {
    return false;
  }
  // systemd owns the tree on its hosts; delegation there goes through systemd-run instead.
  return !(await host.isSystemdBooted());
}

/**
 * Give the base cgroup to the user running xum with sudo. Returns why that did not work, or null
 * once the user can manage the base cgroup. Applies that may not run sudo report the last sudo
 * error instead.
 */
async function delegateBaseWithSudo(
  plan: { base: string; reason: string },
  trySudo: boolean,
  host: AgentCgroupHost
): Promise<AgentCgroupResult | null> {
  if (!trySudo) {
    const failed = failedSudoDelegations.get(host);
    return unavailable(failed === undefined ? plan.reason : sudoFailedReason(plan, failed));
  }
  const baseDir = path.join(host.cgroupRoot, plan.base);
  try {
    await host.delegateWithSudo(baseDir);
  } catch (error) {
    const sudoError = getErrorMessage(error);
    failedSudoDelegations.set(host, sudoError);
    return unavailable(sudoFailedReason(plan, sudoError));
  }
  failedSudoDelegations.delete(host);
  log.info("Gave xum's cgroup to its user with sudo", { cgroup: plan.base });
  const accessError = await findAccessError(baseDir);
  return accessError === null ? null : unavailable(cannotManageReason(plan.base, accessError));
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

function sudoFailedReason(plan: { base: string; reason: string }, sudoError: string): string {
  return `${plan.reason} Delegating ${plan.base} with sudo failed: ${sudoError}`;
}

/** Why the base cgroup lacks a controller that the limits need, or null when it has them. */
async function findMissingControllers(
  base: string,
  baseDir: string,
  needed: Controller[]
): Promise<string | null> {
  const controllers = await readWords(path.join(baseDir, "cgroup.controllers"));
  const missing = needed.filter((controller) => !controllers.includes(controller));
  return missing.length === 0
    ? null
    : `The ${missing.join(" and ")} controller is not available in cgroup ${base}. Enable it in the parent cgroup's cgroup.subtree_control.`;
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
  const found = await findBaseCgroup(host);
  if ("state" in found) {
    return;
  }
  const baseDir = path.join(host.cgroupRoot, found.base);
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

/** xum's own cgroup, and the base cgroup: the same, or its parent once xum moved into `xum-app`. */
async function findBaseCgroup(
  host: AgentCgroupHost
): Promise<{ own: string; base: string } | AgentCgroupFailure> {
  if (host.platform !== "linux") {
    return { state: "unsupported", reason: "Agent resource limits need Linux with cgroup v2." };
  }
  const own = parseSelfCgroup(await host.readSelfCgroup());
  try {
    await fs.access(path.join(host.cgroupRoot, "cgroup.controllers"));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
    return {
      state: "unsupported",
      reason: `No cgroup v2 hierarchy is mounted at ${host.cgroupRoot}.`,
    };
  }
  if (own === null) {
    return { state: "unsupported", reason: "xum does not run in a cgroup v2 hierarchy." };
  }
  if (own === "/") {
    // Setting up here would move every process of the host or container into xum-app.
    return {
      state: "unavailable",
      reason: "xum runs in the root cgroup. Start xum in a cgroup of its own.",
    };
  }
  const name = path.posix.basename(own);
  if (name === AGENTS_CGROUP) {
    // Setting up here would move the outer xum's agent processes and break their enrollment.
    return {
      state: "unavailable",
      reason: `xum runs in cgroup ${own}, the agent cgroup of another xum, whose limits already apply.`,
    };
  }
  return { own, base: name === APP_CGROUP ? path.posix.dirname(own) : own };
}

async function enableControllers(
  baseDir: string,
  needed: Controller[],
  host: AgentCgroupHost
): Promise<void> {
  const subtreeControl = path.join(baseDir, "cgroup.subtree_control");
  await emptyBaseCgroup(baseDir, host);
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

/**
 * Move every process of the base cgroup into xum-app before any controller is enabled, not only
 * after EBUSY. The kernel refuses memory while the cgroup holds processes, but accepts a threaded
 * controller such as cpu. The cgroup then becomes a thread root whose domain children refuse
 * processes (EOPNOTSUPP), so with only a CPU limit no agent could join xum-agents.
 */
async function emptyBaseCgroup(baseDir: string, host: AgentCgroupHost): Promise<void> {
  const procsFile = path.join(baseDir, "cgroup.procs");
  if ((await readWords(procsFile)).length === 0) {
    return;
  }
  // Only threaded controllers can be on here: cpu from a xum without this fix, or ones such as
  // pids that an admin enabled. They keep the cgroup a thread root, which refuses the moves into
  // xum-app, so turn them off for the move and back on once the cgroup is empty.
  const subtreeControl = path.join(baseDir, "cgroup.subtree_control");
  const threaded = await readWords(subtreeControl);
  if (threaded.length > 0) {
    await host.writeFile(subtreeControl, threaded.map((controller) => `-${controller}`).join(" "));
  }
  try {
    // Repeat for processes that forked during a move: one left behind makes a thread root again.
    for (let attempt = 1; ; attempt += 1) {
      await moveProcesses(baseDir, path.join(baseDir, APP_CGROUP), host);
      if ((await readWords(procsFile)).length === 0) {
        return;
      }
      if (attempt >= MAX_ENABLE_ATTEMPTS) {
        throw new Error(`New processes kept starting in ${baseDir} while xum moved them.`);
      }
    }
  } finally {
    // The kernel accepts threaded controllers with or without processes, so this also restores
    // them when the move failed.
    if (threaded.length > 0) {
      await host.writeFile(
        subtreeControl,
        threaded.map((controller) => `+${controller}`).join(" ")
      );
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
