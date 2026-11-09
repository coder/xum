import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentSandboxNetwork,
  ResolvedAgentSandboxSettings,
} from "@/common/config/schemas/agentSandbox";
import { getXumHome } from "@/common/constants/paths";
import {
  AgentSandboxStartError,
  AUTOMATION_ENTRY_ROOTS,
  AUTOMATION_READ_PATHS,
  HIDDEN_AUTOMATION_PATHS,
  CACHE_WRITE_PATHS,
  DENY_READ_ROOTS,
  HOME_READ_PATHS,
  nestedDenyReadPaths,
  PROTECTED_GIT_DIR_PATHS,
  PROTECTED_LINKED_WORKTREE_PATHS,
  PROTECTED_WRITE_PATHS,
  XUM_HOME_TOKEN,
  cacheExecutablePaths,
  dedupe,
  expandSandboxPath,
  expandSandboxPathSpelling,
  expandWriteRoot,
  gitGlobalConfigFiles,
  isPathAtOrUnder,
  realpathOfNearest,
  tempWritePaths,
} from "./sandboxPaths";

export { AgentSandboxStartError };

/** The sandbox setting of each project, published by AgentSandboxService. */
export interface AgentSandboxTargets {
  /** The setting for a command of a project without an override, or of an unknown project. */
  fallback: ResolvedAgentSandboxSettings;
  /** The merged setting of each project with an override of its own, keyed by its config path. */
  byProject: ReadonlyMap<string, ResolvedAgentSandboxSettings>;
  /**
   * Files outside Xum's home folder that hold its keys and settings, hidden and read-only like
   * it: `xum run` and `xum workflow` keep a private copy in a temp folder, which commands can
   * read and write (Codex review). An entry can end in `*`.
   */
  hiddenFiles?: readonly string[];
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
    // Host names match in any case.
    allowedHosts:
      network === "allowlist"
        ? shared(hostLists.map((s) => s.allowedHosts.map((host) => host.toLowerCase())))
        : [],
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
  /** DENY_READ_ROOTS, the home folder, Xum's home folder and nestedDenyReadPaths(). */
  denyRead: string[];
  /** The write roots, gitCommonDirs, HOME_READ_PATHS, PATH folders under ~ and extraReadPaths. */
  allowRead: string[];
  network: AgentSandboxNetwork;
  /** Used only for "allowlist". */
  allowedHosts: string[];
  /** Dev servers and the bash AI proxy listen on loopback. */
  allowLocalBinding: true;
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
  /** Files and folders the command may also read, like extraReadPaths (ExecOptions.sandboxReadPaths). */
  readPaths?: readonly string[];
  /**
   * The other projects of a multi-project workspace. Only Runtime.agentSandboxPolicy() reads it,
   * to pick the setting (agentSandboxSettingsFor()).
   */
  otherProjectPaths?: readonly string[];
  /**
   * The command's environment, with the project's secrets. The credential stores and git config
   * files it moves are protected like those that Xum's own environment moves.
   */
  env?: NodeJS.ProcessEnv;
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
  const envs = policyEnvs(input);
  const nestedDenies = nestedDenyPaths(envs);
  const extraWriteRoots = outsideNestedDenies(
    settings.extraWritePaths.map(expandSandboxPath),
    nestedDenies
  );
  const extraWorkspaceRoots = (input.workspaceRoots ?? []).map((root) =>
    workspaceRootOrThrow(realpathOfNearest(root), home)
  );
  // Xum makes the scratch folder as a folder, so one that is a link fails closed (Codex review):
  // its `.git` below leads through it.
  const scratchSpellings = presentPath(input.scratchDir);
  const scratchRoots = scratchSpellings.map(expandWriteRoot);
  const workspaceRoots = dedupe([cwd, ...extraWorkspaceRoots, ...scratchRoots]);
  const writeRoots = dedupe([
    ...workspaceRoots,
    ...tempWritePaths(),
    ...CACHE_WRITE_PATHS.map(expandWriteRoot),
    ...extraWriteRoots,
  ]);
  assertNoPathThroughLink(
    [input.cwd, ...(input.workspaceRoots ?? []), ...scratchSpellings, ...settings.extraWritePaths],
    writeRoots
  );
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
  const gitGlobalConfigs = pathsFromEnvs(envs, gitGlobalConfigFiles);
  const readableSpellings = [...AUTOMATION_READ_PATHS, ...gitGlobalConfigs];
  const automationSpellings = [...readableSpellings, ...HIDDEN_AUTOMATION_PATHS];
  const cacheSpellings = pathsFromEnvs(envs, cacheExecutablePaths);
  // Xum, its git and the npx, uvx and bunx of MCP servers use these as spelled, outside the
  // sandbox, so a command could replace a link to one in a write root (Codex review): fail closed.
  assertNoPathThroughLink([getXumHome(), ...automationSpellings, ...cacheSpellings], writeRoots);
  assertNoGlobLinks(cacheSpellings);
  const linkedEntries = automationEntryLinkTargets(writeRoots);
  const readableAutomation = [...readableSpellings.map(expandSandboxPath), ...linkedEntries];
  const automationPaths = [...automationSpellings.map(expandSandboxPath), ...linkedEntries];
  assertNoWriteRootInAutomation(writeRoots, automationPaths);
  // A background command starts in a temp folder and gets its checkout in workspaceRoots.
  const gitCommonDirs = dedupe(
    [cwd, ...extraWorkspaceRoots].flatMap((root) => findGitCommonDir(root) ?? [])
  );
  const repoGitDirs = repositoryAndSubmoduleGitDirs(
    [...workspaceRoots, ...extraWriteRoots],
    gitCommonDirs
  );
  const configIncludePaths = [
    ...gitConfigIncludes(repoGitDirs, gitGlobalConfigs),
    ...sshConfigIncludes(),
  ];
  // Git and ssh open these as spelled, and git follows a `.git` link to whatever git folder a
  // command points it at (Codex review).
  assertNoPathThroughLink(
    [
      ...configIncludePaths,
      ...[...workspaceRoots, ...extraWriteRoots].map((root) => path.join(root, ".git")),
    ],
    writeRoots
  );
  const denyWrite = dedupe(
    [
      ...[...workspaceRoots, ...extraWriteRoots].flatMap(protectedPathsUnder),
      ...gitCommonDirs.flatMap(protectedGitDirPaths),
      // A credential file in a write root (~/.cache/huggingface/token) stays unwritable too, and
      // so do the npx, uv and Bun caches, a plugin or skill folder or a dotfile that links into
      // one, and the files that git and ssh config include from one.
      ...[
        ...nestedDenies,
        ...automationPaths,
        ...cacheSpellings.map(expandSandboxPath),
        ...homeLinkTargets(home, writeRoots),
        ...hookLinkTargets(repoGitDirs, writeRoots),
        ...configIncludePaths.map(realpathOfNearest),
      ].filter((denied) => isUnderAny(denied, writeRoots)),
    ].flatMap((denied) => withLinkTargets(denied, writeRoots))
  );
  // Every hidden file, also outside the write roots: a hard link to ~/.xum/config.json in the
  // workspace would write it, and Seatbelt matches names, not files (Codex review).
  assertSingleLinks([...denyWrite, ...automationPaths, ...nestedDenies]);
  const allowRead = dedupe([
    ...writeRoots,
    ...gitCommonDirs,
    // A toolchain folder can link into a write root, where a command can replace the link.
    ...HOME_READ_PATHS.map((entry) =>
      realpathOutside(expandSandboxPathSpelling(entry), writeRoots)
    ),
    ...readableAutomation,
    ...pathFoldersUnderHome(input.pathEnv, home, writeRoots),
    // A command can replace an entry in a write root with a link, so links there are not followed.
    ...outsideNestedDenies(
      [...settings.extraReadPaths, ...(input.readPaths ?? [])].map((entry) =>
        realpathOutside(expandSandboxPathSpelling(entry), writeRoots)
      ),
      nestedDenies
    ),
  ]);
  assertNothingOpenInNestedDeny(allowRead, nestedDenies);
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

/**
 * A command can replace a folder in a write root (a checkout in /tmp, or a folder in an
 * extraWritePaths entry) with a link to ~/.ssh, and the next policy would then open where the
 * link points as a workspace: fail closed when a root as spelled leads through such a link. The
 * same holds for a path that Xum uses as spelled outside the sandbox (XUM_ROOT, GIT_CONFIG_GLOBAL).
 */
function assertNoPathThroughLink(spelled: readonly string[], writeRoots: readonly string[]): void {
  for (const entry of spelled.map(expandSandboxPathSpelling)) {
    const resolved = realpathOfNearest(entry);
    // A root itself, as spelled (a cache folder that is a link) or resolved, is not inside another.
    // A workspace or scratch root that is a link still fails closed: its `.git` is checked too.
    const otherRoots = writeRoots.filter((root) => root !== resolved && root !== entry);
    if (realpathOutside(entry, otherRoots) !== resolved) {
      throw new AgentSandboxStartError(
        `${entry} leads through a link inside a folder that commands can write`
      );
    }
  }
}

function presentPath(target: string | undefined): string[] {
  return target === undefined || target.length === 0 ? [] : [target];
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

/**
 * The same holds for a workspace, scratch folder, toolchain or PATH folder: one at or inside a
 * nested deny (a workspace in <xumHome>/askpass) fails closed (Codex review).
 */
function assertNothingOpenInNestedDeny(
  openPaths: readonly string[],
  nestedDenies: readonly string[]
): void {
  for (const target of openPaths) {
    const denied = nestedDenies.find((deny) => isPathAtOrUnder(foldCase(target), foldCase(deny)));
    if (denied !== undefined) {
      throw new AgentSandboxStartError(`${target} is inside ${denied}, which the sandbox hides`);
    }
  }
}

/**
 * Xum's own environment and, when it has one, the command's. Xum's git, npx and uvx read the
 * first outside the sandbox; the command reads the second, and so does the git that Xum runs
 * outside the sandbox with the project's secrets (Codex review).
 */
function policyEnvs(input: AgentSandboxPolicyInput): NodeJS.ProcessEnv[] {
  if (input.env === undefined) return [process.env];
  // Git, npm and the MCP servers that Xum starts with the project's secrets read their settings
  // in HOME, and the policy protects them in Xum's home only (Codex review).
  const home = input.env.HOME;
  const ownHome = process.env.HOME ?? os.homedir();
  if (home !== undefined && path.resolve(home) !== path.resolve(ownHome)) {
    throw new AgentSandboxStartError(`HOME is ${home} for this command, not ${ownHome}`);
  }
  return [process.env, input.env];
}

/** The credential files that the environments name, and the hidden files of the targets. */
function nestedDenyPaths(envs: readonly NodeJS.ProcessEnv[]): string[] {
  return dedupe(
    [...pathsFromEnvs(envs, nestedDenyReadPaths), ...(sandboxTargets?.hiddenFiles ?? [])].map(
      expandSandboxPath
    )
  );
}

function pathsFromEnvs(
  envs: readonly NodeJS.ProcessEnv[],
  pathsOf: (env: NodeJS.ProcessEnv) => string[]
): string[] {
  return dedupe(envs.flatMap((env) => pathsOf(env)));
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
 * command can make or replace such a link, so the rest of the path stays as spelled. Links are
 * followed one at a time, so a chain (`~/.agents/plugins/demo` to `/repo/plugin` to `/elsewhere`)
 * stops at the one in a root.
 */
function realpathOutside(target: string, roots: readonly string[]): string {
  const pending = segmentsOf(target);
  let resolved: string = path.sep;
  let hops = 0;
  for (let segment = pending.shift(); segment !== undefined; segment = pending.shift()) {
    const next = path.join(resolved, segment);
    const link = isUnderAny(next, roots) ? undefined : linkOrFolder(next);
    if (link === "") {
      resolved = next;
      continue;
    }
    if (link === undefined || ++hops > MAX_LINK_HOPS) return path.join(next, ...pending);
    pending.unshift(...segmentsOf(path.resolve(resolved, link)));
    resolved = path.sep;
  }
  return resolved;
}

// macOS follows at most 32 links in one path (MAXSYMLINKS).
const MAX_LINK_HOPS = 32;

function segmentsOf(target: string): string[] {
  return path
    .resolve(target)
    .split(path.sep)
    .filter((segment) => segment.length > 0);
}

/** What the link `target` points to, "" when it exists and is no link, or undefined when missing. */
function linkOrFolder(target: string): string | undefined {
  try {
    // eslint-disable-next-line local/no-sync-fs-methods -- the policy is built synchronously.
    return fs.lstatSync(target).isSymbolicLink() ? fs.readlinkSync(target) : "";
  } catch {
    return undefined;
  }
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
 * write `.git` files in a temp folder, so it may not choose the folder this opens. A submodule's
 * `.git` file points elsewhere (no back pointer), so a submodule checkout gets no git folder: git
 * there cannot write.
 */
function commonDirOfWorktree(dotGitFile: string): string | undefined {
  const gitDir = linkedWorktreeGitDir(dotGitFile);
  if (gitDir === undefined) return undefined;
  const commonDir = path.dirname(path.dirname(gitDir));
  // Git takes the config and hooks of the folder that `commondir` names. The policy keeps the
  // file read-only, but one rewritten before the sandbox started would leave the folder that git
  // uses open (Codex review).
  if (namedCommonDir(gitDir) !== commonDir) {
    throw new AgentSandboxStartError(`${gitDir}/commondir does not name ${commonDir}`);
  }
  return commonDir;
}

/** The real path of `<common>/worktrees/<name>` that `dotGitFile` points at and back from. */
function linkedWorktreeGitDir(dotGitFile: string): string | undefined {
  try {
    const pointer = gitDirPointer(dotGitFile);
    if (pointer === undefined) return undefined;
    const gitDir = fs.realpathSync(pointer);
    if (path.basename(path.dirname(gitDir)) !== "worktrees") return undefined;
    if (!isFile(path.join(path.dirname(path.dirname(gitDir)), "HEAD"))) return undefined;
    const backPointer = fs.readFileSync(path.join(gitDir, "gitdir"), "utf8").trim();
    const pointsBack =
      fs.realpathSync(path.resolve(gitDir, backPointer)) === fs.realpathSync(dotGitFile);
    return pointsBack ? gitDir : undefined;
  } catch {
    return undefined;
  }
}

/** The real path of the folder that `<gitDir>/commondir` names, or undefined when unreadable. */
function namedCommonDir(gitDir: string): string | undefined {
  try {
    const named = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    return fs.realpathSync(path.resolve(gitDir, named));
  } catch {
    return undefined;
  }
}

/** The git folder that the `.git` file `dotGitFile` names, as spelled; throws when unreadable. */
function gitDirPointer(dotGitFile: string): string | undefined {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGitFile, "utf8"));
  return match ? path.resolve(path.dirname(dotGitFile), match[1]) : undefined;
}

/**
 * `target`, each link on the way, and where it leads when it or a folder above it is a symlink:
 * Seatbelt and the file tools check the path a write resolves to, so a protected `.git/config`
 * that links to `.git/config.actual` must be denied there too. A dangling link counts: a write
 * through it creates its target. Git outside the sandbox follows the chain again, so a link on the
 * way (`.git/hooks` to `/repo/hooks-alias` to `/elsewhere`) stays read-only too, and a link that
 * is reached through a link in a write root, which a command could replace, fails closed (Codex
 * review).
 */
function withLinkTargets(target: string, writeRoots: readonly string[]): string[] {
  const chain = [target];
  let current = target;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    let link: string;
    try {
      link = fs.readlinkSync(current);
    } catch {
      break; // Not a symlink, or missing.
    }
    const next = path.resolve(realpathOfNearest(path.dirname(current)), link);
    assertNoPathThroughLink([path.dirname(next)], writeRoots);
    current = path.join(realpathOfNearest(path.dirname(next)), path.basename(next));
    chain.push(current);
  }
  return dedupe([...chain, realpathOfNearest(current)]);
}

function assertSingleLinks(files: readonly string[]): void {
  for (const file of files) assertSingleLink(file, statIfExists(file));
}

/**
 * Seatbelt and the file tools check the name that a write goes through, so another hard link to
 * a protected file writes it unchecked, and no rule can name every link. A sandboxed command
 * cannot make one (Seatbelt refuses a link to a file it may not write), but one can be there.
 */
function assertSingleLink(file: string, stat: fs.Stats | undefined): void {
  if (stat?.isFile() === true && stat.nlink > 1) {
    throw new AgentSandboxStartError(
      `${file} has ${stat.nlink} hard links, and the sandbox cannot keep the others read-only`
    );
  }
}

function statIfExists(target: string): fs.Stats | undefined {
  try {
    return fs.statSync(target);
  } catch {
    return undefined;
  }
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

// Beside the home folder's own dot entries. Xum reads the global instruction files in ~/.claude
// and its home folder into the prompt (systemMessage.ts).
const HOME_LINK_FOLDERS: readonly string[] = ["~/.config", "~/.ssh", "~/.claude", XUM_HOME_TOKEN];
// ssh stops at 16 (READCONF_MAX_DEPTH), git at 10; following more only protects more.
const MAX_INCLUDE_DEPTH = 16;
const CONFIG_MAX_BYTES = 1024 * 1024;

/**
 * The link targets of the dot entries in the home folder, and of the entries of HOME_LINK_FOLDERS.
 * A dotfiles checkout links them into a workspace, and git, ssh, npx, bunx and the shell read them
 * outside the sandbox, Xum's own `git fetch` and prompt included. Not a target at or above a write
 * root (`~/.dotfiles` linking to the checkout itself): that would close the whole root.
 */
function homeLinkTargets(home: string, writeRoots: readonly string[]): string[] {
  const links = [
    ...childLinks(home).filter((link) => path.basename(link).startsWith(".")),
    ...HOME_LINK_FOLDERS.flatMap((folder) => childLinks(expandSandboxPathSpelling(folder))),
  ];
  return linkTargets(links, writeRoots).filter(
    (target) => !writeRoots.some((root) => isPathAtOrUnder(root, target))
  );
}

/**
 * Where the linked entries of the global skill and plugin folders lead. Xum loads a plugin linked
 * to its checkout (`~/.agents/plugins/demo` to `~/src/demo`) from there and starts its MCP servers
 * outside the sandbox, so that checkout is automation too: read-only inside a write root, and a
 * write root at or inside it fails closed. Links deeper inside an entry are not followed.
 */
function automationEntryLinkTargets(writeRoots: readonly string[]): string[] {
  return linkTargets(
    AUTOMATION_ENTRY_ROOTS.flatMap((root) => childLinks(expandSandboxPathSpelling(root))),
    writeRoots
  );
}

/**
 * Where each link leads, as real paths. Git, ssh, the shell and Xum follow the link outside the
 * sandbox, so another link on the way that is inside a write root, which a command could replace,
 * fails closed.
 */
function linkTargets(links: readonly string[], writeRoots: readonly string[]): string[] {
  assertNoPathThroughLink(links, writeRoots);
  return links.flatMap((link) => withLinkTargets(link, writeRoots).slice(1));
}

/**
 * Fails closed on a link that a cache entry ending in `*` matches (the `bunx-<uid>-*` folders in
 * the temp folders, which bunx makes as folders): bunx outside the sandbox runs what it leads to,
 * and Seatbelt checks a write at that path, not at the link (Codex review).
 */
function assertNoGlobLinks(spelled: readonly string[]): void {
  for (const glob of spelled.filter((entry) => entry.endsWith("*"))) {
    const prefix = path.basename(glob).slice(0, -1);
    const link = childLinks(expandSandboxPathSpelling(path.dirname(glob))).find((entry) =>
      path.basename(entry).startsWith(prefix)
    );
    if (link !== undefined) {
      throw new AgentSandboxStartError(`${link} is a link, which bunx outside the sandbox follows`);
    }
  }
}

function childLinks(folder: string): string[] {
  try {
    return fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isSymbolicLink())
      .map((entry) => path.join(folder, entry.name));
  } catch {
    return [];
  }
}

/**
 * The real paths of the files that git config includes (`include.path`, and
 * `includeIf.<condition>.path` whatever the condition), from `globalConfigs` and the config of
 * each git folder in `repoGitDirs`, recursively as git reads them. Git takes them as config, so a
 * command that writes one can set `core.hooksPath` for git outside the sandbox, Xum's own
 * `git worktree add` and `git submodule update` in a trusted project included.
 */
function gitConfigIncludes(
  repoGitDirs: readonly string[],
  globalConfigs: readonly string[]
): string[] {
  const configFiles = [
    ...globalConfigs,
    ...repoGitDirs.flatMap((gitDir) => [
      path.join(gitDir, "config"),
      ...[gitDir, ...childDirs(path.join(gitDir, "worktrees"))].map((dir) =>
        path.join(dir, "config.worktree")
      ),
    ]),
  ];
  return configIncludes(configFiles, (file) =>
    gitConfigIncludeValues(readConfigText(file), file).map((value) =>
      resolveGitInclude(value, file)
    )
  );
}

/** The git folders of the repositories that `roots` are in, `gitDirs`, and their submodules'. */
function repositoryAndSubmoduleGitDirs(
  roots: readonly string[],
  gitDirs: readonly string[]
): string[] {
  return dedupe([...roots.flatMap(repositoryGitDirs), ...gitDirs]).flatMap((gitDir) => [
    gitDir,
    ...submoduleGitDirs(path.join(gitDir, "modules"), 1),
  ]);
}

/**
 * Where the hooks in each git folder's `hooks` link to (`.git/hooks/post-checkout` to
 * `scripts/post-checkout` in the workspace): git outside the sandbox runs them, Xum's own
 * `git worktree add` and `git submodule update` in a trusted project included (Codex review).
 */
function hookLinkTargets(gitDirs: readonly string[], writeRoots: readonly string[]): string[] {
  return gitDirs
    .flatMap((gitDir) => childLinks(path.join(gitDir, "hooks")))
    .flatMap((link) => withLinkTargets(link, writeRoots).slice(1));
}

/**
 * The git folder of the repository that `root` is in, as git finds it: the nearest `.git` folder
 * at or above `root` (a workspace can be a folder of a repository), or the folder that a `.git`
 * file there names (a submodule's is in its superproject's `modules`), with the folder its
 * `commondir` names. Following a pointer only adds files to protect.
 */
function repositoryGitDirs(root: string): string[] {
  for (let current = root; ; current = path.dirname(current)) {
    const dotGit = path.join(current, ".git");
    const stat = statIfExists(dotGit);
    if (stat?.isDirectory() === true) return [dotGit];
    if (stat?.isFile() === true) return pointedGitDirs(dotGit);
    if (path.dirname(current) === current) return [];
  }
}

function pointedGitDirs(dotGitFile: string): string[] {
  try {
    const gitDir = gitDirPointer(dotGitFile);
    if (gitDir === undefined) return [];
    const commonDir = path.join(gitDir, "commondir");
    if (!isFile(commonDir)) return [gitDir];
    return [gitDir, path.resolve(gitDir, fs.readFileSync(commonDir, "utf8").trim())];
  } catch {
    return [];
  }
}

// Git nests submodules without a limit; past this depth the policy fails closed.
const MAX_SUBMODULE_DEPTH = 16;

/**
 * The git folders of the submodules in a `modules` folder, and of theirs. A submodule's name can
 * hold a `/`, so a folder without a HEAD is part of a name. `.git/modules` is read-only, so the
 * folders there are the ones git made.
 */
function submoduleGitDirs(modules: string, depth: number): string[] {
  return childDirs(modules).flatMap((dir) => {
    if (depth > MAX_SUBMODULE_DEPTH) {
      throw new AgentSandboxStartError(`${dir} nests submodules deeper than the sandbox reads`);
    }
    if (!isFile(path.join(dir, "HEAD"))) return submoduleGitDirs(dir, depth + 1);
    return [dir, ...submoduleGitDirs(path.join(dir, "modules"), depth + 1)];
  });
}

/**
 * The real paths of what `~/.ssh/config` and the system `/etc/ssh/ssh_config` include,
 * recursively: a `ProxyCommand` there runs outside the sandbox for Xum's own `git fetch`. A
 * pattern with a wildcard in its last name protects every name in its folder that starts like it.
 */
function sshConfigIncludes(): string[] {
  // ssh looks for a relative include of the user's config in ~/.ssh, of the system's in /etc/ssh.
  const configs = [expandSandboxPathSpelling("~/.ssh/config"), "/etc/ssh/ssh_config"];
  return configs.flatMap((config) =>
    configIncludes([config], (file) =>
      sshIncludePatterns(readConfigText(file), file).flatMap((pattern) =>
        resolveSshInclude(pattern, file, path.dirname(config))
      )
    )
  );
}

/**
 * Every file that `files` include, and what those include, by `includesOf`; as spelled, since git
 * and ssh open them so.
 */
function configIncludes(
  files: readonly string[],
  includesOf: (file: string) => readonly string[]
): string[] {
  const found = new Set<string>();
  const visit = (file: string, depth: number): void => {
    if (depth > MAX_INCLUDE_DEPTH) return;
    for (const included of includesOf(file)) {
      if (found.has(included)) continue;
      found.add(included);
      visit(included, depth + 1);
    }
  };
  for (const file of files) visit(file, 1);
  return [...found];
}

/**
 * A regular file's text, or "" (no FIFO or device can block the read). Git and ssh read a file of
 * any size, so one over 1 MiB fails closed, and so does one with another hard link, which can be
 * in a write root.
 */
function readConfigText(file: string): string {
  const stat = statIfExists(file);
  if (stat?.isFile() !== true) return "";
  if (stat.size > CONFIG_MAX_BYTES) {
    throw new AgentSandboxStartError(`${file} is over 1 MiB, more than the sandbox reads`);
  }
  assertSingleLink(file, stat);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Git resolves a relative include against the folder of the file as spelled, not its target. A
 * form this does not resolve (`~user/`, `%(prefix)/`) fails closed.
 */
function resolveGitInclude(value: string, file: string): string {
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (value.startsWith("~") || value.startsWith("%(")) {
    throw unreadableConfig(file, value);
  }
  return path.resolve(path.dirname(file), value);
}

/**
 * A relative pattern is in `includeDir`. A wildcard in the last name protects every name in the
 * folder that starts like the pattern and reads those files; anywhere else, or a token or
 * variable (`%d`, `${HOME}`), fails closed.
 */
function resolveSshInclude(pattern: string, file: string, includeDir: string): string[] {
  if (/[%$]/.test(pattern) || /^~[^/]/.test(pattern)) throw unreadableConfig(file, pattern);
  const resolved = pattern.startsWith("~/")
    ? path.join(os.homedir(), pattern.slice(2))
    : path.resolve(includeDir, pattern);
  if (!/[*?[]/.test(resolved)) return [resolved];
  const folder = path.dirname(resolved);
  const literal = /^[^*?[]*/.exec(path.basename(resolved))?.[0] ?? "";
  if (/[*?[]/.test(folder)) throw unreadableConfig(file, pattern);
  return [
    path.join(folder, `${literal}*`),
    ...childFiles(folder).filter((child) => path.basename(child).startsWith(literal)),
  ];
}

/** The entries that are no folder, also through a link: ssh follows a link a wildcard matches. */
function childFiles(folder: string): string[] {
  try {
    return fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => path.join(folder, entry.name))
      .filter((child) => statIfExists(child)?.isDirectory() !== true);
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

/** Also through a symlink, though the policy fails closed on a `.git` link before this. */
function isFolder(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
/* eslint-enable local/no-sync-fs-methods */

const GIT_SECTION = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\](.*)$/;
const GIT_PATH_ENTRY = /^\s*path\s*=(.*)$/i;
const GIT_QUOTED_VALUE = /^\s*"((?:[^"\\\n]|\\[\\"])*)"\s*(?:[#;].*)?$/;
const GIT_PLAIN_VALUE = /^\s*([^"\\#;]*?)\s*(?:[#;].*)?$/;
const SSH_INCLUDE = /^\s*include(?:\s*=\s*|\s+)(.*)$/i;
// Whole arguments, plain or quoted, up to a `#` that starts a comment.
const SSH_PLAIN_ARGS = /^(?:\s*(?:"[^"\\]*"|'[^'\\]*'|[^\s"'\\#][^\s"'\\]*)(?=\s|$))*\s*(?:#.*)?$/;
const SSH_ARG = /"([^"]*)"|'([^']*)'|(\S+)/g;

/**
 * The `path` values of the `[include]` and `[includeIf "..."]` sections of the git config `text`
 * of `file`. A plain or fully quoted value reads as git reads it; a partly quoted, escaped or
 * continued one fails closed.
 */
function gitConfigIncludeValues(text: string, file: string): string[] {
  const values: string[] = [];
  let inInclude = false;
  for (const line of text.split(/\r?\n/)) {
    const header = gitSectionHeader(line);
    if (header !== undefined) inInclude = header.isInclude;
    const value = inInclude ? gitPathValue(header?.rest ?? line, file) : undefined;
    if (value !== undefined && value !== "") values.push(value);
  }
  return values;
}

/** For a `[section]` line: whether it opens an include section, and the text after it. */
function gitSectionHeader(line: string): { isInclude: boolean; rest: string } | undefined {
  if (!line.trimStart().startsWith("[")) return undefined;
  const section = GIT_SECTION.exec(line);
  const name = section?.[1].toLowerCase();
  return { isInclude: name === "include" || name === "includeif", rest: section?.[2] ?? "" };
}

/** The value of a `path = ...` line, or undefined for another line. */
function gitPathValue(line: string, file: string): string | undefined {
  const raw = GIT_PATH_ENTRY.exec(line)?.[1];
  if (raw === undefined) return undefined;
  const quoted = GIT_QUOTED_VALUE.exec(raw)?.[1];
  if (quoted !== undefined) return quoted.replace(/\\(.)/g, "$1");
  const plain = GIT_PLAIN_VALUE.exec(raw)?.[1];
  if (plain !== undefined) return plain;
  throw unreadableConfig(file, raw.trim());
}

/** The arguments of each `Include` line of the ssh config `text` of `file`, unquoted. */
function sshIncludePatterns(text: string, file: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => sshArgs(SSH_INCLUDE.exec(line)?.[1] ?? "", file));
}

/**
 * The arguments in `args`, as ssh splits them. ssh also reads backslash escapes and arguments
 * quoted in part (`a" b"`): those fail closed.
 */
function sshArgs(args: string, file: string): string[] {
  if (!SSH_PLAIN_ARGS.test(args)) throw unreadableConfig(file, args.trim());
  const found: string[] = [];
  for (const [, doubleQuoted, singleQuoted, plain] of args.matchAll(SSH_ARG)) {
    if (plain?.startsWith("#") === true) break;
    found.push(doubleQuoted ?? singleQuoted ?? plain);
  }
  return found;
}

function unreadableConfig(file: string, value: string): AgentSandboxStartError {
  return new AgentSandboxStartError(
    `${file} includes "${value}" in a form the sandbox does not read; write the path plainly`
  );
}

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

/**
 * isPathAtOrUnder(), where a trailing `*` in `denied` matches the rest of its last name. Case
 * does not count: a default macOS volume opens `.XUM/MCP.JSONC` as `.xum/mcp.jsonc`, and Seatbelt
 * denies it there too. On a case-sensitive volume this only denies more.
 */
function isAtOrUnderDeny(spelledTarget: string, spelledDeny: string): boolean {
  const [target, denied] = [foldCase(spelledTarget), foldCase(spelledDeny)];
  if (!denied.endsWith("*")) return isPathAtOrUnder(target, denied);
  const folder = path.dirname(denied);
  const [name] = path.relative(folder, target).split(path.sep);
  return isPathAtOrUnder(target, folder) && name.startsWith(path.basename(denied).slice(0, -1));
}

function readAllowed(policy: AgentSandboxPolicy, target: string): boolean {
  if (!policy.denyRead.some((denied) => isAtOrUnderDeny(target, denied))) return true;
  return isUnderAny(target, policy.allowRead) && !isUnderNestedDeny(policy, target);
}

function isUnderAny(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => isPathAtOrUnder(target, root));
}

function isUnderNestedDeny(policy: AgentSandboxPolicy, target: string): boolean {
  return policy.denyRead.some(
    (denied) => isNestedDeny(denied, policy) && isAtOrUnderDeny(target, denied)
  );
}

/** As APFS compares names: also `ſ` with `s`, and the Kelvin sign with `k`. */
function foldCase(target: string): string {
  return target.toUpperCase().toLowerCase();
}

/** A deny inside an allowed path: Seatbelt applies it after the allows. */
function isNestedDeny(denied: string, policy: AgentSandboxPolicy): boolean {
  return policy.allowRead.some((allowed) => isPathAtOrUnder(denied, allowed) && denied !== allowed);
}
