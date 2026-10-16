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
 * xum cannot create a delegated cgroup, so it works only when xum's own cgroup (or its parent,
 * after xum moved into `xum-app`) is writable by the user that runs xum.
 */
export async function applyAgentCgroupLimits(
  limits: AgentResourceLimits,
  host: AgentCgroupHost
): Promise<AgentCgroupResult> {
  const needed = neededControllers(limits);
  if (needed.length === 0) {
    try {
      await clearAgentCgroupLimits(host);
    } catch (error) {
      log.warn("Failed to remove the agent resource limits from the agent cgroup", {
        error: getErrorMessage(error),
      });
    }
    return { status: { state: "off" }, enrollmentTarget: null };
  }

  const base = await findBaseCgroup(host);
  if (typeof base !== "string") {
    return base;
  }
  const baseDir = path.join(host.cgroupRoot, base);
  const problem = await findSetupProblem(base, baseDir, needed);
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

/** Why the base cgroup cannot hold the agent cgroup, or null when it can. */
async function findSetupProblem(
  base: string,
  baseDir: string,
  needed: Controller[]
): Promise<AgentCgroupResult | null> {
  for (const file of [
    baseDir,
    ...["cgroup.procs", "cgroup.subtree_control"].map((name) => path.join(baseDir, name)),
  ]) {
    try {
      await fs.access(file, fs.constants.W_OK);
    } catch (error) {
      return unavailable(
        `xum runs in cgroup ${base}, which the user running xum cannot manage (${getErrorMessage(error)}). Start xum in a cgroup delegated to that user.`
      );
    }
  }
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
