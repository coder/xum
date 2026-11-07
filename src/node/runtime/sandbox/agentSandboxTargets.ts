import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentSandboxNetwork,
  ResolvedAgentSandboxSettings,
} from "@/common/config/schemas/agentSandbox";
import { getXumHome } from "@/common/constants/paths";
import {
  CACHE_WRITE_PATHS,
  DENY_READ_ROOTS,
  HOME_READ_PATHS,
  NESTED_DENY_READ_PATHS,
  PROTECTED_GIT_COMMON_DIR_PATHS,
  PROTECTED_WRITE_PATHS,
  dedupe,
  expandSandboxPath,
  isPathAtOrUnder,
  realpathOfNearest,
  tempWritePaths,
} from "./sandboxPaths";

/** The sandbox setting of each project, published by AgentSandboxService. */
export interface AgentSandboxTargets {
  /** The setting for a command of a project without an override, or of an unknown project. */
  fallback: ResolvedAgentSandboxSettings;
  /** The merged setting of each project with an override of its own, keyed by its config path. */
  byProject: ReadonlyMap<string, ResolvedAgentSandboxSettings>;
}

let sandboxTargets: AgentSandboxTargets | null = null;

/** Set by AgentSandboxService: null before the first apply, which means off. */
export function setAgentSandboxTargets(targets: AgentSandboxTargets | null): void {
  sandboxTargets = targets;
}

/**
 * The sandbox setting for a command of the project at `projectPath` (the same key the agent
 * cgroup uses), or null when no sandbox applies. An unknown project gets the global setting.
 */
export function agentSandboxSettingsFor(
  projectPath: string | undefined
): ResolvedAgentSandboxSettings | null {
  if (sandboxTargets === null) return null;
  const settings =
    (projectPath === undefined ? undefined : sandboxTargets.byProject.get(projectPath)) ??
    sandboxTargets.fallback;
  return settings.enabled ? settings : null;
}

/** True when the sandbox could apply to some command, so the srt session should be ready. */
export function anyAgentSandboxEnabled(): boolean {
  if (sandboxTargets === null) return false;
  if (sandboxTargets.fallback.enabled) return true;
  return [...sandboxTargets.byProject.values()].some((settings) => settings.enabled);
}

/** One command's sandbox: every path is a real path. */
export interface AgentSandboxPolicy {
  /** The workspace, its scratch folder, temp folders, caches and extraWritePaths. */
  writeRoots: string[];
  /** The main .git of a worktree: writable except hooks and config. */
  gitCommonDir?: string;
  /** PROTECTED_WRITE_PATHS in each root. */
  denyWrite: string[];
  /** DENY_READ_ROOTS and NESTED_DENY_READ_PATHS. */
  denyRead: string[];
  /** The write roots, gitCommonDir, HOME_READ_PATHS, PATH folders under ~ and extraReadPaths. */
  allowRead: string[];
  network: AgentSandboxNetwork;
  /** Used only for "allowlist". */
  allowedHosts: string[];
  /** Dev servers and the bash AI proxy listen on loopback. */
  allowLocalBinding: true;
}

export class AgentSandboxStartError extends Error {
  // dry-duplicate-ok: each named Error subclass sets its own message and name
  constructor(reason: string) {
    super(`The agent sandbox could not start: ${reason}`);
    this.name = "AgentSandboxStartError";
  }
}

export interface AgentSandboxPolicyInput {
  /** The command's working directory: the workspace. */
  cwd: string;
  /** Workspace folders opened like cwd (ExecOptions.sandboxRoots). */
  workspaceRoots?: readonly string[];
  /** The workspace's $XUM_SCRATCH_DIR, when it has one. */
  scratchDir?: string;
  /** The command's PATH: folders on it under ~ open for reads. */
  pathEnv?: string;
}

/**
 * The sandbox policy of one command. Throws AgentSandboxStartError for a working directory that
 * would open the whole home folder (`/`, `~` or a parent of it): the caller must then run
 * nothing.
 */
export function buildAgentSandboxPolicy(
  settings: ResolvedAgentSandboxSettings,
  input: AgentSandboxPolicyInput
): AgentSandboxPolicy {
  const home = realpathOfNearest(os.homedir());
  const cwd = workspaceRootOrThrow(realpathOfNearest(input.cwd), home);
  const extraWriteRoots = settings.extraWritePaths.map(expandSandboxPath);
  const extraWorkspaceRoots = (input.workspaceRoots ?? []).map((root) =>
    workspaceRootOrThrow(realpathOfNearest(root), home)
  );
  const workspaceRoots = dedupe([cwd, ...extraWorkspaceRoots, ...realpathIfSet(input.scratchDir)]);
  const writeRoots = dedupe([
    ...workspaceRoots,
    ...tempWritePaths(),
    ...CACHE_WRITE_PATHS.map(expandSandboxPath),
    ...extraWriteRoots,
  ]);
  // Zero or one folder: the main git folder of a worktree.
  const gitCommonDirs = realpathIfSet(findGitCommonDir(cwd));
  const denyWrite = dedupe([
    ...[...workspaceRoots, ...extraWriteRoots].flatMap(protectedPathsUnder),
    ...gitCommonDirs.flatMap((dir) =>
      PROTECTED_GIT_COMMON_DIR_PATHS.map((name) => path.join(dir, name))
    ),
  ]);
  const allowRead = dedupe([
    ...writeRoots,
    ...gitCommonDirs,
    ...HOME_READ_PATHS.map(expandSandboxPath),
    ...pathFoldersUnderHome(input.pathEnv, home),
    ...settings.extraReadPaths.map(expandSandboxPath),
  ]);
  return {
    writeRoots,
    ...(gitCommonDirs.length > 0 ? { gitCommonDir: gitCommonDirs[0] } : {}),
    denyWrite,
    denyRead: dedupe([
      ...DENY_READ_ROOTS.map(realpathOfNearest),
      ...NESTED_DENY_READ_PATHS.map(expandSandboxPath),
    ]),
    allowRead,
    network: settings.network,
    allowedHosts: [...settings.allowedHosts],
    allowLocalBinding: true,
  };
}

function realpathIfSet(target: string | undefined): string[] {
  return target === undefined || target.length === 0 ? [] : [realpathOfNearest(target)];
}

/** `root`, unless it is `/`, `~` or a parent of `~`: the sandbox would open the whole home. */
function workspaceRootOrThrow(root: string, home: string): string {
  if (isPathAtOrUnder(home, root)) {
    throw new AgentSandboxStartError(
      `the working directory ${root} contains the home folder, so the sandbox would open all of it`
    );
  }
  return root;
}

function protectedPathsUnder(root: string): string[] {
  return PROTECTED_WRITE_PATHS.flatMap((entry) => {
    if (typeof entry === "string") return [path.join(root, entry)];
    const target = path.join(root, entry.path);
    return isFile(target) ? [target] : [];
  });
}

/**
 * Each PATH folder under ~ opens for reads, so tools installed there run. A `bin` folder also
 * opens its parent (a toolchain's lib folder sits next to it), but never ~, ~/.local or
 * <xumHome>.
 */
function pathFoldersUnderHome(pathEnv: string | undefined, home: string): string[] {
  if (pathEnv === undefined) return [];
  const tooBroad = new Set([home, path.join(home, ".local"), realpathOfNearest(getXumHome())]);
  const opens = (folder: string) => isPathAtOrUnder(folder, home) && !tooBroad.has(folder);
  return pathEnv.split(path.delimiter).flatMap((entry) => {
    if (!path.isAbsolute(entry)) return [];
    const folder = realpathOfNearest(entry);
    if (!opens(folder)) return [];
    const parent = path.dirname(folder);
    return path.basename(folder) === "bin" && opens(parent) ? [folder, parent] : [folder];
  });
}

/* eslint-disable local/no-sync-fs-methods -- Runtime.agentSandboxPolicy() is synchronous, so
   the file tools can check a path before each access; these are a few small reads per command. */
/**
 * The main git folder of a worktree whose `.git` file points elsewhere, or undefined for a
 * repository whose `.git` folder is inside the workspace (or no repository). Read from the
 * files git itself reads, so no git process starts for each command.
 */
export function findGitCommonDir(cwd: string): string | undefined {
  let current = cwd;
  for (;;) {
    const dotGit = path.join(current, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return undefined;
    if (stat?.isFile()) return commonDirOfGitFile(dotGit);
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function commonDirOfGitFile(dotGitFile: string): string | undefined {
  try {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGitFile, "utf8"));
    if (!match) return undefined;
    const gitDir = path.resolve(path.dirname(dotGitFile), match[1]);
    const commonDirFile = path.join(gitDir, "commondir");
    const commonDir = fs.existsSync(commonDirFile)
      ? path.resolve(gitDir, fs.readFileSync(commonDirFile, "utf8").trim())
      : gitDir;
    return commonDir;
  } catch {
    return undefined;
  }
}

function isFile(target: string): boolean {
  try {
    return fs.lstatSync(target).isFile();
  } catch {
    return false;
  }
}
/* eslint-enable local/no-sync-fs-methods */

/**
 * Whether `policy` lets a sandboxed command read or write the real path `target`, by the same
 * order Seatbelt applies the rules: for reads, a denied root closes unless an allow reopens it,
 * and a nested deny closes it again; for writes, only the write roots and the git folder open,
 * minus the protected paths.
 */
export function agentSandboxPolicyAllows(
  policy: AgentSandboxPolicy,
  target: string,
  access: "read" | "write"
): boolean {
  return access === "write" ? writeAllowed(policy, target) : readAllowed(policy, target);
}

function writeAllowed(policy: AgentSandboxPolicy, target: string): boolean {
  const roots =
    policy.gitCommonDir === undefined
      ? policy.writeRoots
      : [...policy.writeRoots, policy.gitCommonDir];
  return (
    isUnderAny(target, roots) &&
    !isUnderAny(target, policy.denyWrite) &&
    !isUnderNestedDeny(policy, target)
  );
}

function readAllowed(policy: AgentSandboxPolicy, target: string): boolean {
  if (!isUnderAny(target, policy.denyRead)) return true;
  return isUnderAny(target, policy.allowRead) && !isUnderNestedDeny(policy, target);
}

function isUnderAny(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => isPathAtOrUnder(target, root));
}

function isUnderNestedDeny(policy: AgentSandboxPolicy, target: string): boolean {
  return policy.denyRead.some(
    (denied) => isNestedDeny(denied, policy) && isPathAtOrUnder(target, denied)
  );
}

/** A deny inside an allowed path: Seatbelt applies it after the allows. */
function isNestedDeny(denied: string, policy: AgentSandboxPolicy): boolean {
  return policy.allowRead.some((allowed) => isPathAtOrUnder(denied, allowed) && denied !== allowed);
}
