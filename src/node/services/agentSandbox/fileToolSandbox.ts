import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { localExecEnv } from "@/node/runtime/childProcessEnv";
import type { Runtime } from "@/node/runtime/Runtime";
import { mergeSecretsOverXumEnv } from "@/node/runtime/runtimeScratchDir";
import {
  agentSandboxApplies,
  agentSandboxPolicyAllows,
} from "@/node/runtime/sandbox/agentSandboxTargets";
import { isPathAtOrUnder } from "@/node/runtime/sandbox/sandboxPaths";

/** What the file tools of one workspace add to the runtime's sandbox policy. */
export interface FileToolSandboxContext {
  /** The workspace's $XUM_SCRATCH_DIR: open like the workspace, as it is for bash. */
  scratchDir?: string;
  /** The PATH that bash starts with: its folders under ~ are open for reads, as they are for bash. */
  pathEnv?: string;
  /** The environment that bash starts with, the project's secrets included. */
  env?: NodeJS.ProcessEnv;
  /** Xum-managed paths (and what is under them) the file tools read and write outside the policy. */
  exemptPaths?: readonly string[];
  /** Xum-managed paths the file tools only read outside the policy. */
  readExemptPaths?: readonly string[];
}

export function fileToolSandboxContext(config: ToolConfiguration): FileToolSandboxContext {
  const execEnv = localExecEnv(mergeSecretsOverXumEnv(config.xumEnv, config.secrets));
  return {
    scratchDir: config.xumEnv?.XUM_SCRATCH_DIR,
    pathEnv: execEnv.path,
    env: execEnv.env,
    // Xum keeps plan files under <xumHome>/plans and bash overflow output in runtimeTempDir, both
    // outside the policy; plan mode writes the plan file and the agent reads the rest.
    exemptPaths: config.planFilePath ? [config.planFilePath] : [],
    readExemptPaths: [...(config.ancestorPlanFilePaths ?? []), config.runtimeTempDir],
  };
}

export const GLOBAL_WRITE_SANDBOX_ERROR =
  "The agent sandbox blocks changes to Xum's global skills, AGENTS.md and global memory: every " +
  "workspace loads them, also one without the sandbox. Only the user can change them while it is on.";

/**
 * Whether the agent sandbox covers this workspace while its Xum tools write Xum's home (a system
 * workspace's global scope). Every workspace loads the global skills and AGENTS.md as trusted
 * instructions, also one without the sandbox, so a sandboxed agent must not change them.
 */
export function sandboxBlocksGlobalWrites(config: ToolConfiguration): boolean {
  return config.xumScope?.type === "global" && agentSandboxCoversTools(config);
}

/**
 * Whether the agent sandbox covers this workspace's commands. The global memory scope is in the
 * tool description of every workspace, so a sandboxed agent must not change it either.
 */
export function agentSandboxCoversTools(config: ToolConfiguration): boolean {
  return agentSandboxApplies(config.runtime, {
    cwd: config.cwd,
    scratchDir: config.xumEnv?.XUM_SCRATCH_DIR,
  });
}

/** Thrown when the macOS agent sandbox closes the path a file tool asked for. */
export class AgentSandboxPathError extends Error {
  constructor(target: string, access: "read" | "write") {
    super(
      access === "write"
        ? `The agent sandbox blocks writes to ${target}. Only the workspace, temp folders and caches are writable.`
        : `The agent sandbox blocks reads of ${target}. Home folders and external disks are closed except the workspace, temp folders, caches, toolchains and skills.`
    );
    this.name = "AgentSandboxPathError";
  }
}

/** Rejects with AgentSandboxPathError unless a sandboxed command could reach `resolvedPath`. */
export type FileToolSandboxGate = (resolvedPath: string, access: "read" | "write") => Promise<void>;

const allowAll: FileToolSandboxGate = () => Promise.resolve();

/**
 * The checks of assertFileToolSandboxAllows() against one policy, built once for many paths.
 * Allows every path when no sandbox applies. Throws AgentSandboxStartError (fail closed) when
 * the sandbox applies but has no policy for `cwd`.
 */
export function fileToolSandboxGate(
  runtime: Runtime,
  cwd: string,
  context: FileToolSandboxContext = {}
): FileToolSandboxGate {
  const policy = runtime.agentSandboxPolicy?.({
    cwd,
    scratchDir: context.scratchDir,
    pathEnv: context.pathEnv,
    env: context.env,
  });
  if (policy == null) return allowAll;
  return async (resolvedPath, access) => {
    // Seatbelt checks the path a write lands on, so a link in the workspace cannot point out.
    const realPath = await realPathFollowingLinks(resolvedPath);
    if (realPath !== undefined && agentSandboxPolicyAllows(policy, realPath, access)) return;
    if (realPath !== undefined && (await isExempt(runtime, cwd, realPath, access, context))) return;
    throw new AgentSandboxPathError(resolvedPath, access);
  };
}

/**
 * Throws AgentSandboxPathError unless the runtime's sandbox policy lets a sandboxed command
 * reach `resolvedPath`, so file tools follow the same rules as the shell. No check when no
 * sandbox applies. Throws AgentSandboxStartError (fail closed) when the sandbox applies but has
 * no policy for `cwd`.
 */
export async function assertFileToolSandboxAllows(
  runtime: Runtime,
  cwd: string,
  resolvedPath: string,
  access: "read" | "write",
  context: FileToolSandboxContext = {}
): Promise<void> {
  await fileToolSandboxGate(runtime, cwd, context)(resolvedPath, access);
}

async function isExempt(
  runtime: Runtime,
  cwd: string,
  realPath: string,
  access: "read" | "write",
  context: FileToolSandboxContext
): Promise<boolean> {
  const exempt = [
    ...(context.exemptPaths ?? []),
    ...(access === "read" ? (context.readExemptPaths ?? []) : []),
  ];
  for (const entry of exempt) {
    // The entry as spelled, not where a link at it points: a plan file that links to
    // ~/.ssh/config would exempt that file (Codex review).
    const spelled = runtime.normalizePath(entry, cwd);
    const parent = await realPathFollowingLinks(path.dirname(spelled));
    if (parent === undefined) continue;
    if (isPathAtOrUnder(realPath, path.join(parent, path.basename(spelled)))) return true;
  }
  return false;
}

const MAX_LINK_HOPS = 40;

/**
 * The real path of `target`, or of its nearest existing ancestor with the rest appended. Unlike
 * realpathOfNearest it follows a dangling link (a write through one creates its target), and it
 * returns undefined for a link loop.
 */
async function realPathFollowingLinks(target: string, hops = 0): Promise<string | undefined> {
  if (hops > MAX_LINK_HOPS) return undefined;
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    const real = await realpathOrUndefined(current);
    if (real !== undefined) return path.join(real, ...missing.reverse());
    const link = await readlinkOrUndefined(current);
    if (link !== undefined) {
      const linked = path.resolve(path.dirname(current), link);
      return realPathFollowingLinks(path.join(linked, ...missing.reverse()), hops + 1);
    }
    const parent = path.dirname(current);
    if (parent === current) return path.join(current, ...missing.reverse());
    missing.push(path.basename(current));
    current = parent;
  }
}

async function realpathOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await fs.realpath(target);
  } catch {
    return undefined;
  }
}

async function readlinkOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await fs.readlink(target);
  } catch {
    return undefined;
  }
}
