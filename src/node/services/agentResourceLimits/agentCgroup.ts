import { createHash } from "crypto";
import type { Dirent } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import type { AgentResourceLimits } from "@/common/config/schemas/agentResourceLimits";
import type {
  AgentResourceLimitsStatus,
  AgentResourceLimitsSupport,
} from "@/common/orpc/schemas/agentResourceLimits";
import { getErrorMessage } from "@/common/utils/errors";
import {
  agentCgroupEnrollmentLine,
  type AgentCgroupEnrollmentTargets,
} from "@/node/runtime/agentCgroupEnrollment";
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
/**
 * While a project has a limit of its own, `xum-agents` enables controllers for its children, so it
 * cannot hold processes: the agent commands of projects without their own limit run here.
 */
const DEFAULT_CGROUP = "default";
/** The prefix of the child of `xum-agents` for one project with a limit of its own. */
const PROJECT_CGROUP_PREFIX = "p-";
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
  /** Remove an empty cgroup; the kernel fails with EBUSY while it holds processes or children. */
  removeCgroup: (cgroupDir: string) => Promise<void>;
}

/** The limits of each project that has a limit of its own, keyed by its path in config.json. */
export type ProjectAgentResourceLimits = ReadonlyMap<string, AgentResourceLimits>;

export interface AgentCgroupResult {
  status: AgentResourceLimitsStatus;
  /** Where new agent shells go, or null when no limit applies. */
  enrollment: AgentCgroupEnrollmentTargets | null;
  /** The cgroup of each project with a limit of its own, while the limits are active. */
  projectCgroups: ReadonlyMap<string, string>;
}

const NO_PROJECT_CGROUPS: ReadonlyMap<string, string> = new Map();

type PublishEnrollment = (targets: AgentCgroupEnrollmentTargets) => void;

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
  removeCgroup: (cgroupDir) => fs.rmdir(cgroupDir),
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

/**
 * The name of a project's child of `xum-agents`: the same in every xum server that reads the same
 * config, and a valid cgroup name for any project path.
 */
export function projectCgroupName(projectPath: string): string {
  const hash = createHash("sha256").update(projectPath).digest("hex");
  return `${PROJECT_CGROUP_PREFIX}${hash.slice(0, 12)}`;
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
 *
 * `projects` are the limits of single projects. Each gets its own child of `xum-agents`, so the
 * kernel holds a project to its own limit and to the shared one, whichever is lower.
 *
 * `publishEnrollment` gets the targets for new agent commands before a change of the layout makes
 * the earlier targets refuse them: before a child of `xum-agents` is removed, and before
 * `xum-agents` enables controllers for its children. A command that cannot join its target runs
 * in xum's own cgroup, without even the shared limit.
 */
export async function applyAgentCgroupLimits(
  limits: AgentResourceLimits,
  host: AgentCgroupHost,
  options: {
    trySudo?: boolean;
    projects?: ProjectAgentResourceLimits;
    publishEnrollment?: PublishEnrollment;
  } = {}
): Promise<AgentCgroupResult> {
  const projects = options.projects ?? new Map<string, AgentResourceLimits>();
  const publish: PublishEnrollment = options.publishEnrollment ?? (() => undefined);
  const needed = neededControllers([limits, ...projects.values()]);
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
    return { status: { state: "off" }, enrollment: null, projectCgroups: NO_PROJECT_CGROUPS };
  }

  const plan = await planAgentCgroup(needed, host);
  if (plan.state === "unsupported" || plan.state === "unavailable") {
    return unavailable(plan.reason);
  }
  if (plan.state === "sudo") {
    const problem = await delegateBaseWithSudo(plan, options.trySudo === true, host);
    if (problem !== null) {
      return problem;
    }
  }
  const baseDir = path.join(host.cgroupRoot, plan.base);
  try {
    return await setUpAgentsCgroup(plan.base, baseDir, limits, needed, projects, host, publish);
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
  host: AgentCgroupHost,
  projects: ProjectAgentResourceLimits = new Map()
): Promise<AgentResourceLimitsSupport> {
  // A project limit can need a controller that the shared limit does not.
  const needed = neededControllers([limits, ...projects.values()]);
  try {
    const plan = await planAgentCgroup(needed.length > 0 ? needed : ["cpu", "memory"], host);
    return plan.state === "ready" || plan.state === "sudo"
      ? { state: plan.state, cgroup: plan.base }
      : plan;
  } catch (error) {
    return { state: "unavailable", reason: getErrorMessage(error) };
  }
}

/** The controllers that any of `limitSets` needs. */
function neededControllers(limitSets: readonly AgentResourceLimits[]): Controller[] {
  const needed: Controller[] = [];
  if (limitSets.some((limits) => limits.cpuCores !== undefined)) needed.push("cpu");
  if (limitSets.some((limits) => limits.memoryGiB !== undefined)) needed.push("memory");
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
  projects: ProjectAgentResourceLimits,
  host: AgentCgroupHost,
  publish: PublishEnrollment
): Promise<AgentCgroupResult> {
  await enableControllers(baseDir, needed, host, APP_CGROUP);
  const agentsDir = path.join(baseDir, AGENTS_CGROUP);
  await fs.mkdir(agentsDir, { recursive: true });
  await writeLimits(baseDir, AGENTS_CGROUP, limits, host);
  const agentsCgroup = path.posix.join(base, AGENTS_CGROUP);
  const status: AgentResourceLimitsStatus = { state: "active", cgroup: agentsCgroup };
  if (projects.size === 0) {
    // No project limit: agent commands join xum-agents itself, as before project limits.
    await unnestAgentsCgroup(agentsDir, host);
    const procsFile = path.join(agentsDir, "cgroup.procs");
    const problem = await checkEnrollment(procsFile, agentsCgroup, host);
    if (problem !== null) {
      return problem;
    }
    const enrollment = { fallback: procsFile, byProject: new Map<string, string>() };
    publish(enrollment);
    await removeEmptyChildren(agentsDir, new Set(), host);
    return { status, enrollment, projectCgroups: NO_PROJECT_CGROUPS };
  }
  return setUpProjectCgroups(agentsDir, agentsCgroup, projects, status, host, publish);
}

/**
 * Give each project with a limit its own child of `xum-agents`, and move every other agent command
 * into `default`: a cgroup that enables controllers for its children cannot hold processes.
 */
async function setUpProjectCgroups(
  agentsDir: string,
  agentsCgroup: string,
  projects: ProjectAgentResourceLimits,
  status: AgentResourceLimitsStatus,
  host: AgentCgroupHost,
  publish: PublishEnrollment
): Promise<AgentCgroupResult> {
  await fs.mkdir(path.join(agentsDir, DEFAULT_CGROUP), { recursive: true });
  const defaultProcs = path.join(agentsDir, DEFAULT_CGROUP, "cgroup.procs");
  if (!(await isNested(agentsDir))) {
    // New commands join xum-agents until now, which refuses them once it enables controllers.
    // Without project limits until now, no project target is lost.
    publish({ fallback: defaultProcs, byProject: new Map() });
  }
  await enableControllers(
    agentsDir,
    neededControllers([...projects.values()]),
    host,
    DEFAULT_CGROUP
  );
  // A controller that only the shared limit needs stays off for the children, and a controller
  // turned on for an earlier project limit stays on; writeLimits writes max for it.
  await writeLimits(agentsDir, DEFAULT_CGROUP, {}, host);
  const defaultProblem = await checkEnrollment(
    defaultProcs,
    path.posix.join(agentsCgroup, DEFAULT_CGROUP),
    host
  );
  if (defaultProblem !== null) {
    return defaultProblem;
  }
  const byProject = new Map<string, string>();
  const projectCgroups = new Map<string, string>();
  const keep = new Set([DEFAULT_CGROUP]);
  for (const [projectPath, projectLimits] of projects) {
    const name = projectCgroupName(projectPath);
    keep.add(name);
    await fs.mkdir(path.join(agentsDir, name), { recursive: true });
    await writeLimits(agentsDir, name, projectLimits, host);
    const procsFile = path.join(agentsDir, name, "cgroup.procs");
    const cgroup = path.posix.join(agentsCgroup, name);
    const problem = await checkEnrollment(procsFile, cgroup, host);
    if (problem !== null) {
      return problem;
    }
    byProject.set(projectPath, procsFile);
    projectCgroups.set(projectPath, cgroup);
  }
  const enrollment = { fallback: defaultProcs, byProject };
  publish(enrollment);
  await removeEmptyChildren(agentsDir, keep, host);
  return { status, enrollment, projectCgroups };
}

/** Whether `xum-agents` enables a controller for its children, so its commands run in them. */
async function isNested(agentsDir: string): Promise<boolean> {
  const enabled = await readSubtreeControl(agentsDir);
  return enabled.includes("cpu") || enabled.includes("memory");
}

/** Why a test command did not join `cgroup` through `procsFile`, or null when it did. */
async function checkEnrollment(
  procsFile: string,
  cgroup: string,
  host: AgentCgroupHost
): Promise<AgentCgroupResult | null> {
  const probed = parseSelfCgroup(await host.probeEnrollment(procsFile));
  return probed === cgroup
    ? null
    : unavailable(`A test command ran in cgroup ${probed ?? "unknown"}, not ${cgroup}.`);
}

/**
 * Go back to the layout without project limits: write max to the children of `xum-agents` and turn
 * their controllers off, so that the kernel accepts agent commands in `xum-agents` again. Commands
 * that still run in a child keep running there without a project limit. The caller removes the
 * children once no enrollment target names them.
 */
async function unnestAgentsCgroup(agentsDir: string, host: AgentCgroupHost): Promise<void> {
  const children = await listAgentChildren(agentsDir);
  for (const name of children) {
    await writeLimits(agentsDir, name, {}, host);
  }
  const enabled = (await readSubtreeControl(agentsDir)).filter(
    (controller) => controller === "cpu" || controller === "memory"
  );
  if (enabled.length > 0) {
    await host.writeFile(
      path.join(agentsDir, "cgroup.subtree_control"),
      enabled.map((controller) => `-${controller}`).join(" ")
    );
  }
}

/**
 * Remove the children of `xum-agents` that xum made and no longer needs, once they are empty.
 * A child that still holds processes loses its limit and stays until a later apply.
 */
async function removeEmptyChildren(
  agentsDir: string,
  keep: ReadonlySet<string>,
  host: AgentCgroupHost
): Promise<void> {
  for (const name of await listAgentChildren(agentsDir)) {
    if (keep.has(name)) {
      continue;
    }
    await writeLimits(agentsDir, name, {}, host);
    try {
      await host.removeCgroup(path.join(agentsDir, name));
    } catch (error) {
      if (!hasErrorCode(error, "EBUSY")) {
        throw error;
      }
    }
  }
}

/** The children of `xum-agents` that xum made: `default` and one for each limited project. */
async function listAgentChildren(agentsDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (entry.name === DEFAULT_CGROUP || entry.name.startsWith(PROJECT_CGROUP_PREFIX))
    )
    .map((entry) => entry.name);
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
  await writeLimits(baseDir, AGENTS_CGROUP, {}, host);
  await unnestAgentsCgroup(path.join(baseDir, AGENTS_CGROUP), host);
  // No limit applies, so a command that fails to join a removed child loses no limit.
  await removeEmptyChildren(path.join(baseDir, AGENTS_CGROUP), new Set(), host);
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
  // With project limits, the outer xum's agent commands run in a child of xum-agents.
  if (own.split("/").includes(AGENTS_CGROUP)) {
    // Setting up here would move the outer xum's agent processes and break their enrollment.
    return {
      state: "unavailable",
      reason: `xum runs in cgroup ${own}, in the agent cgroup of another xum, whose limits already apply.`,
    };
  }
  return { own, base: name === APP_CGROUP ? path.posix.dirname(own) : own };
}

/**
 * Enable `needed` for the children of the cgroup at `dir`. While `dir` holds processes the kernel
 * refuses with EBUSY, so its processes move into its child `leaf` first.
 */
async function enableControllers(
  dir: string,
  needed: Controller[],
  host: AgentCgroupHost,
  leaf: string
): Promise<void> {
  const subtreeControl = path.join(dir, "cgroup.subtree_control");
  await emptyCgroup(dir, leaf, host);
  const enabled = await readSubtreeControl(dir);
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
      await moveProcesses(dir, path.join(dir, leaf), host);
    }
  }
}

/**
 * Move every process of the cgroup at `dir` into its child `leaf` (xum-app for the base cgroup,
 * default for xum-agents) before any controller is enabled, not only after EBUSY. The kernel
 * refuses memory while the cgroup holds processes, but accepts a threaded controller such as cpu.
 * The cgroup then becomes a thread root whose domain children refuse processes (EOPNOTSUPP), so
 * with only a CPU limit no agent could join its cgroup.
 */
async function emptyCgroup(dir: string, leaf: string, host: AgentCgroupHost): Promise<void> {
  if ((await readProcs(dir)).length === 0) {
    return;
  }
  // Only threaded controllers can be on here. They keep the cgroup a thread root, which refuses
  // the moves into the leaf. Turning one off resets its settings in every child, so undo only what
  // a xum without this fix left: cpu alone, with no threaded child whose cpu limits are in use.
  const subtreeControl = path.join(dir, "cgroup.subtree_control");
  const enabled = await readSubtreeControl(dir);
  if (enabled.length > 0) {
    if (enabled.join(" ") !== "cpu" || (await hasThreadedChild(dir))) {
      throw new Error(
        `${dir} holds processes and enables ${enabled.join(" ")} for its children, so xum cannot move the processes without resetting those settings.`
      );
    }
    await host.writeFile(subtreeControl, "-cpu");
  }
  // Repeat for processes that forked during a move: one left behind makes a thread root again.
  for (let attempt = 1; ; attempt += 1) {
    await moveProcesses(dir, path.join(dir, leaf), host);
    if ((await readProcs(dir)).length === 0) {
      return;
    }
    if (attempt >= MAX_ENABLE_ATTEMPTS) {
      throw new Error(`New processes kept starting in ${dir} while xum moved them.`);
    }
  }
}

/** The processes of the cgroup at `dir`; none for a directory that is not a cgroup yet. */
async function readProcs(dir: string): Promise<string[]> {
  try {
    return await readWords(path.join(dir, "cgroup.procs"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

/** Whether a child of the cgroup is threaded, so its processes count as the cgroup's own. */
async function hasThreadedChild(baseDir: string): Promise<boolean> {
  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  for (const entry of entries.filter((child) => child.isDirectory())) {
    const typeFile = path.join(baseDir, entry.name, "cgroup.type");
    // The kernel always has this file. A missing one, as in a test tree, is a domain cgroup.
    const type = await fs.readFile(typeFile, "utf-8").catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) return "domain";
      throw error;
    });
    if (type.trim() === "threaded") {
      return true;
    }
  }
  return false;
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

/** Write the limits of the child `name` of `parentDir`, or `max` for a limit that is not set. */
async function writeLimits(
  parentDir: string,
  name: string,
  limits: AgentResourceLimits,
  host: AgentCgroupHost
): Promise<void> {
  const dir = path.join(parentDir, name);
  // A controller's files exist in a child only while the controller is on in its parent.
  const enabled = await readSubtreeControl(parentDir);
  if (enabled.includes("cpu")) {
    await host.writeFile(path.join(dir, "cpu.max"), cpuMaxValue(limits.cpuCores));
  }
  if (enabled.includes("memory")) {
    await host.writeFile(path.join(dir, "memory.max"), memoryMaxValue(limits.memoryGiB));
  }
}

/**
 * The controllers that the cgroup at `dir` enables for its children. The kernel gives every cgroup
 * this file. A directory without it is not a cgroup that xum set up yet, so it enables none.
 */
async function readSubtreeControl(dir: string): Promise<string[]> {
  try {
    return await readWords(path.join(dir, "cgroup.subtree_control"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

async function readWords(file: string): Promise<string[]> {
  return (await fs.readFile(file, "utf-8")).split(/\s+/).filter((word) => word.length > 0);
}

function unavailable(reason: string): AgentCgroupResult {
  return {
    status: { state: "unavailable", reason },
    enrollment: null,
    projectCgroups: NO_PROJECT_CGROUPS,
  };
}
