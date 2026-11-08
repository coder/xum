import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentSandboxNetwork,
  ResolvedAgentSandboxSettings,
} from "@/common/config/schemas/agentSandbox";
import { getXumHome } from "@/common/constants/paths";
import {
  AUTOMATION_READ_PATHS,
  CACHE_WRITE_PATHS,
  DENY_READ_ROOTS,
  HOME_READ_PATHS,
  NESTED_DENY_READ_PATHS,
  PROTECTED_GIT_DIR_PATHS,
  PROTECTED_LINKED_WORKTREE_PATHS,
  PROTECTED_WRITE_PATHS,
  cacheExecutablePaths,
  dedupe,
  expandSandboxPath,
  expandSandboxPathSpelling,
  expandWriteRoot,
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
 * A command of a multi-project workspace can change the checkout of each of `otherProjectPaths`
 * too, so it gets the strictest of their settings: the sandbox applies when any of them has it
 * on.
 */
export function agentSandboxSettingsFor(
  projectPath: string | undefined,
  otherProjectPaths: readonly string[] = []
): ResolvedAgentSandboxSettings | null {
  const targets = sandboxTargets;
  if (targets === null) return null;
  const settingsOf = (key: string | undefined): ResolvedAgentSandboxSettings =>
    (key === undefined ? undefined : targets.byProject.get(key)) ?? targets.fallback;
  const enabled = [projectPath, ...otherProjectPaths]
    .map(settingsOf)
    .filter((settings) => settings.enabled);
  return enabled.length === 0 ? null : strictestSettings(enabled);
}

const NETWORK_STRICTNESS: Record<AgentSandboxNetwork, number> = {
  loopback: 0,
  allowlist: 1,
  open: 2,
};

/** What every one of `list` allows (a project with the sandbox off limits nothing). */
function strictestSettings(
  list: readonly ResolvedAgentSandboxSettings[]
): ResolvedAgentSandboxSettings {
  if (list.length === 1) return list[0];
  const shared = (lists: ReadonlyArray<readonly string[]>): string[] =>
    lists.reduce<string[]>(
      (kept, next) => kept.filter((entry) => next.includes(entry)),
      [...lists[0]]
    );
  const network = list
    .map((settings) => settings.network)
    .reduce((a, b) => (NETWORK_STRICTNESS[b] < NETWORK_STRICTNESS[a] ? b : a));
  // A project with the open network allows every host, so only the allow lists limit the hosts.
  const hostLists = list.filter((settings) => settings.network === "allowlist");
  return {
    enabled: true,
    network,
    allowedHosts: network === "allowlist" ? shared(hostLists.map((s) => s.allowedHosts)) : [],
    extraWritePaths: shared(list.map((settings) => settings.extraWritePaths)),
    extraReadPaths: shared(list.map((settings) => settings.extraReadPaths)),
  };
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
  /** The main .git of each worktree among the workspace roots: writable except hooks and config. */
  gitCommonDirs: string[];
  /**
   * PROTECTED_WRITE_PATHS in each root, the protected paths of each git folder, and the tool
   * caches that run outside the sandbox. An entry that ends in `*` is a glob (srt passes it to
   * Seatbelt as one).
   */
  denyWrite: string[];
  /** DENY_READ_ROOTS, the home folder, Xum's home folder and NESTED_DENY_READ_PATHS. */
  denyRead: string[];
  /** The write roots, gitCommonDirs, HOME_READ_PATHS, PATH folders under ~ and extraReadPaths. */
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

/** Whether `error` is an AgentSandboxStartError, also as the cause that Runtime.exec() wraps. */
export function isAgentSandboxStartError(error: unknown): boolean {
  return (
    error instanceof AgentSandboxStartError ||
    (error instanceof Error && error.cause instanceof AgentSandboxStartError)
  );
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
  /**
   * The other projects of a multi-project workspace. Only Runtime.agentSandboxPolicy() reads it,
   * to pick the setting (agentSandboxSettingsFor()).
   */
  otherProjectPaths?: readonly string[];
}

/**
 * Whether the agent sandbox covers the commands that `runtime` runs with `input`. True when it
 * applies but has no safe policy there: those commands fail closed.
 */
export function agentSandboxApplies(
  runtime: { agentSandboxPolicy?(input: AgentSandboxPolicyInput): AgentSandboxPolicy | null },
  input: AgentSandboxPolicyInput
): boolean {
  try {
    return runtime.agentSandboxPolicy?.(input) != null;
  } catch {
    return true;
  }
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
  const nestedDenies = NESTED_DENY_READ_PATHS.map(expandSandboxPath);
  const extraWriteRoots = outsideNestedDenies(
    settings.extraWritePaths.map(expandSandboxPath),
    nestedDenies
  );
  const extraWorkspaceRoots = (input.workspaceRoots ?? []).map((root) =>
    workspaceRootOrThrow(realpathOfNearest(root), home)
  );
  const workspaceRoots = dedupe([cwd, ...extraWorkspaceRoots, ...realpathIfSet(input.scratchDir)]);
  const writeRoots = dedupe([
    ...workspaceRoots,
    ...tempWritePaths(),
    ...CACHE_WRITE_PATHS.map(expandWriteRoot),
    ...extraWriteRoots,
  ]);
  // Xum runs code from its home folder with full access (the global mcp.jsonc, tool hooks,
  // skills, plugins), so a policy that can write it does not hold. Workspaces and scratch
  // folders can live in it; an extraWritePaths entry cannot.
  const xumHome = realpathOfNearest(getXumHome());
  if (isUnderAny(xumHome, writeRoots)) {
    throw new AgentSandboxStartError(
      `Xum's home folder ${xumHome} is inside a folder that commands can write`
    );
  }
  const extraRootInXumHome = extraWriteRoots.find((root) => isPathAtOrUnder(root, xumHome));
  if (extraRootInXumHome !== undefined) {
    throw new AgentSandboxStartError(
      `the extra write path ${extraRootInXumHome} is inside Xum's home folder ${xumHome}`
    );
  }
  const automationPaths = AUTOMATION_READ_PATHS.map(expandSandboxPath);
  assertNoWriteRootInAutomation(writeRoots, automationPaths);
  // A background command starts in a temp folder and gets its checkout in workspaceRoots.
  const gitCommonDirs = dedupe(
    [cwd, ...extraWorkspaceRoots].flatMap((root) => findGitCommonDir(root) ?? [])
  );
  const denyWrite = dedupe(
    [
      ...[...workspaceRoots, ...extraWriteRoots].flatMap(protectedPathsUnder),
      ...gitCommonDirs.flatMap(protectedGitDirPaths),
      // A credential file in a write root (~/.cache/huggingface/token) stays unwritable too, and
      // so do the npx, uv and Bun caches and a global git config, plugin or skill folder that
      // links into one.
      ...[
        ...nestedDenies,
        ...automationPaths,
        ...cacheExecutablePaths().map(expandSandboxPath),
      ].filter((denied) => isUnderAny(denied, writeRoots)),
    ].flatMap(withLinkTarget)
  );
  const allowRead = dedupe([
    ...writeRoots,
    ...gitCommonDirs,
    ...HOME_READ_PATHS.map(expandSandboxPath),
    ...pathFoldersUnderHome(input.pathEnv, home, writeRoots),
    // A command can replace an entry in a write root with a link, so links there are not followed.
    ...outsideNestedDenies(
      settings.extraReadPaths.map((entry) =>
        realpathOutside(expandSandboxPathSpelling(entry), writeRoots)
      ),
      nestedDenies
    ),
  ]);
  return {
    writeRoots,
    gitCommonDirs,
    denyWrite,
    // The home folder itself too: an account's home can live outside /Users (a network home).
    // So does Xum's home (XUM_ROOT), with chats, checkouts and the bash AI proxy's key.
    denyRead: dedupe([...DENY_READ_ROOTS.map(realpathOfNearest), home, xumHome, ...nestedDenies]),
    allowRead,
    network: settings.network,
    allowedHosts: [...settings.allowedHosts],
    allowLocalBinding: true,
  };
}

/**
 * The denies above keep an automation path in a write root read-only. A write root inside one (a
 * workspace that is a plugin checkout in ~/.agents/plugins) cannot be denied without denying the
 * workspace, and Xum starts that plugin's MCP servers outside the sandbox: fail closed.
 */
function assertNoWriteRootInAutomation(
  writeRoots: readonly string[],
  automationPaths: readonly string[]
): void {
  for (const root of writeRoots) {
    const automationPath = automationPaths.find((automation) => isPathAtOrUnder(root, automation));
    if (automationPath !== undefined) {
      throw new AgentSandboxStartError(
        `the folder ${root}, which commands can write, is inside ${automationPath}, ` +
          "which holds code that Xum runs outside the sandbox"
      );
    }
  }
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

/**
 * Seatbelt applies a deny after the allows only when it lies strictly inside an allowed path, so
 * an extra path at or inside a nested deny would open that credential file: drop it.
 */
function outsideNestedDenies(paths: readonly string[], nestedDenies: readonly string[]): string[] {
  return paths.filter((target) => !isUnderAny(target, nestedDenies));
}

function protectedPathsUnder(root: string): string[] {
  const listed = PROTECTED_WRITE_PATHS.flatMap((entry) => {
    if (typeof entry === "string") return [path.join(root, entry)];
    const target = path.join(root, entry.path);
    return isFolder(target) ? [] : [target];
  });
  return [...listed, ...linkedWorktreePaths(path.join(root, ".git"))];
}

function protectedGitDirPaths(gitDir: string): string[] {
  return [
    ...PROTECTED_GIT_DIR_PATHS.map((name) => path.join(gitDir, name)),
    ...linkedWorktreePaths(gitDir),
  ];
}

/** PROTECTED_LINKED_WORKTREE_PATHS of each linked worktree that the git folder `gitDir` has. */
function linkedWorktreePaths(gitDir: string): string[] {
  return childDirs(path.join(gitDir, "worktrees")).flatMap((dir) =>
    PROTECTED_LINKED_WORKTREE_PATHS.map((name) => path.join(dir, name))
  );
}

/**
 * Each PATH folder under ~ opens for reads, so tools installed there run, but never ~, ~/.local
 * or <xumHome>. Only the folder itself: a `bin` folder's parent can be any folder, such as
 * ~/Documents for ~/Documents/bin, so a toolchain that needs files next to it goes in
 * HOME_READ_PATHS or extraReadPaths.
 */
function pathFoldersUnderHome(
  pathEnv: string | undefined,
  home: string,
  writeRoots: readonly string[]
): string[] {
  if (pathEnv === undefined) return [];
  const tooBroad = new Set([home, path.join(home, ".local"), realpathOfNearest(getXumHome())]);
  return pathEnv.split(path.delimiter).flatMap((entry) => {
    if (!path.isAbsolute(entry)) return [];
    const folder = realpathOutside(entry, writeRoots);
    return isPathAtOrUnder(folder, home) && !tooBroad.has(folder) ? [folder] : [];
  });
}

/**
 * The real path of `target`, without following a symlink at or under one of `roots`: a sandboxed
 * command can make or replace such a link, so the rest of the path stays as spelled.
 */
function realpathOutside(target: string, roots: readonly string[]): string {
  const segments = path
    .resolve(target)
    .split(path.sep)
    .filter((segment) => segment.length > 0);
  let resolved: string = path.sep;
  for (const [index, segment] of segments.entries()) {
    const next = path.join(resolved, segment);
    if (isUnderAny(next, roots)) return path.join(next, ...segments.slice(index + 1));
    try {
      // eslint-disable-next-line local/no-sync-fs-methods -- the policy is built synchronously.
      resolved = fs.realpathSync(next);
    } catch {
      return path.join(next, ...segments.slice(index + 1));
    }
  }
  return resolved;
}

/* eslint-disable local/no-sync-fs-methods -- Runtime.agentSandboxPolicy() is synchronous, so
   the file tools can check a path before each access; these are a few small reads per command. */
/**
 * The main git folder of a linked worktree whose `.git` file points elsewhere, or undefined for
 * a repository whose `.git` folder is inside the workspace (or no repository). Read from the
 * files git itself reads, so no git process starts for each command.
 */
function findGitCommonDir(root: string): string | undefined {
  let current = root;
  for (;;) {
    const dotGit = path.join(current, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return undefined;
    if (stat?.isFile()) return commonDirOfWorktree(dotGit);
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * `<common>` (a real path) for a `.git` file that points at `<common>/worktrees/<name>`, when
 * that folder points back at the `.git` file and `<common>` holds a HEAD. A sandboxed command can
 * rewrite the `commondir` file in an open git folder and write `.git` files in a temp folder, so
 * neither may choose the folder this opens. A submodule's `.git` file points elsewhere (no
 * back pointer), so a submodule checkout gets no git folder: git there cannot write.
 */
function commonDirOfWorktree(dotGitFile: string): string | undefined {
  try {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGitFile, "utf8"));
    if (!match) return undefined;
    const gitDir = fs.realpathSync(path.resolve(path.dirname(dotGitFile), match[1]));
    const commonDir = path.dirname(path.dirname(gitDir));
    if (path.basename(path.dirname(gitDir)) !== "worktrees") return undefined;
    if (!isFile(path.join(commonDir, "HEAD"))) return undefined;
    const backPointer = fs.readFileSync(path.join(gitDir, "gitdir"), "utf8").trim();
    const pointsBack =
      fs.realpathSync(path.resolve(gitDir, backPointer)) === fs.realpathSync(dotGitFile);
    return pointsBack ? commonDir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `target`, and where it leads when it or a folder above it is a symlink: Seatbelt and the file
 * tools check the path a write resolves to, so a protected `.git/config` that links to
 * `.git/config.actual` must be denied there too. A dangling link counts: a write through it
 * creates its target.
 */
function withLinkTarget(target: string): string[] {
  let destination = target;
  try {
    destination = path.resolve(realpathOfNearest(path.dirname(target)), fs.readlinkSync(target));
  } catch {
    // Not a symlink, or missing.
  }
  const resolved = realpathOfNearest(destination);
  return resolved === target ? [target] : [target, resolved];
}

function childDirs(folder: string): string[] {
  try {
    return fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(folder, entry.name));
  } catch {
    return [];
  }
}

function isFile(target: string): boolean {
  try {
    return fs.lstatSync(target).isFile();
  } catch {
    return false;
  }
}

/** Also through a symlink: a `.git` link to a git folder is a git folder for git. */
function isFolder(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
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
  const roots = [...policy.writeRoots, ...policy.gitCommonDirs];
  return (
    isUnderAny(target, roots) &&
    !policy.denyWrite.some((denied) => isAtOrUnderDeny(target, denied)) &&
    !isUnderNestedDeny(policy, target)
  );
}

/** isPathAtOrUnder(), where a trailing `*` in `denied` matches the rest of its last name. */
function isAtOrUnderDeny(target: string, denied: string): boolean {
  if (!denied.endsWith("*")) return isPathAtOrUnder(target, denied);
  const folder = path.dirname(denied);
  const [name] = path.relative(folder, target).split(path.sep);
  return isPathAtOrUnder(target, folder) && name.startsWith(path.basename(denied).slice(0, -1));
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
