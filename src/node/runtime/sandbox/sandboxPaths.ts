import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listProjectMetadataRelativePaths } from "@/common/compat/legacyMux";
import { getXumHome } from "@/common/constants/paths";

/**
 * The folders and files that the macOS agent sandbox opens or closes. Entries start with `~/`
 * (the user's home) or `<xumHome>/` (getXumHome(), which XUM_ROOT can move outside `~`), or are
 * absolute. expandSandboxPath() turns each into a real path: Seatbelt matches real paths only, so
 * a rule for /tmp (a symlink to /private/tmp) would match nothing.
 */

export const XUM_HOME_TOKEN = "<xumHome>";

export class AgentSandboxStartError extends Error {
  // dry-duplicate-ok: each named Error subclass sets its own message and name
  constructor(reason: string) {
    super(`The agent sandbox could not start: ${reason}`);
    this.name = "AgentSandboxStartError";
  }
}

/** Temp folders every sandboxed command may write. */
export function tempWritePaths(): string[] {
  return dedupe(["/private/tmp", expandWriteRoot(os.tmpdir())]);
}

// Other apps keep caches in ~/Library/Caches too, so only tool folders open.
// Not writable: ~/.bun/bin, ~/.cargo/bin, ~/go/bin, ~/.local/bin, /opt/homebrew and
// /usr/local. A file there runs in every later shell. Bun's caches stay closed too
// (cacheExecutablePaths()).
export const CACHE_WRITE_PATHS: readonly string[] = [
  "~/.npm",
  "~/.cache",
  "~/.cargo/registry",
  "~/.cargo/git",
  "~/go/pkg/mod",
  "~/.gradle/caches",
  "~/.m2/repository",
  "~/Library/pnpm/store",
  "~/.pnpm-store",
  "~/Library/Caches/go-build",
  "~/Library/Caches/pip",
  "~/Library/Caches/Yarn",
  "~/Library/Caches/ms-playwright",
  "~/Library/Caches/node-gyp",
  "~/Library/Developer/Xcode/DerivedData",
];

/**
 * Read-only in the tool caches: Xum starts MCP servers with npx, uvx and bunx outside the
 * sandbox, and these run what they keep here as it is: npx its `_npx` packages, uvx the
 * environments in the uv cache, bunx the packages in Bun's install cache and in its folders in
 * the temp folders (`bunx-<uid>-<package>` up to Bun 1.4.3, `.bunx-<uid>` after). Bun also runs
 * what its transpiler cache holds. uv and Bun check nothing they read from these caches, so all
 * of each stays read-only, also where Xum's environment moves it; uv and Bun in the sandbox get
 * caches of their own (sandboxToolEnv()). Sandboxed commands can still run what is there. An
 * entry that ends in `*` is a glob, which srt passes to Seatbelt.
 */
export function cacheExecutablePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = (name: string, ...rest: string[]) => envPath(env, name, ...rest);
  const uid = process.getuid?.();
  const bunxTempFolders =
    uid === undefined
      ? []
      : tempWritePaths().flatMap((dir) => [
          path.join(dir, `bunx-${uid}-*`),
          path.join(dir, `.bunx-${uid}`),
        ]);
  return dedupe([
    "~/.npm/_npx",
    // npm reads its config from the environment in either case.
    ...fromEnv("npm_config_cache", "_npx"),
    ...fromEnv("NPM_CONFIG_CACHE", "_npx"),
    "~/.cache/uv",
    ...fromEnv("XDG_CACHE_HOME", "uv"),
    ...fromEnv("UV_CACHE_DIR"),
    // The order in which Bun picks its install cache, then its transpiler cache.
    ...fromEnv("BUN_INSTALL_CACHE_DIR"),
    ...fromEnv("BUN_INSTALL", "install", "cache"),
    ...fromEnv("XDG_CACHE_HOME", ".bun", "install", "cache"),
    "~/.bun/install/cache",
    ...fromEnv("BUN_RUNTIME_TRANSPILER_CACHE_PATH"),
    ...fromEnv("XDG_CACHE_HOME", "bun"),
    "~/Library/Caches/bun",
    ...bunxTempFolders,
  ]);
}

/**
 * The system config of the gits that macOS users run: Apple's and Nix's in /etc, Homebrew's and
 * MacPorts' in their prefix, and the defaults that Apple's git ships with and also reads.
 */
const GIT_SYSTEM_CONFIG_FILES: readonly string[] = [
  "/etc/gitconfig",
  "/opt/homebrew/etc/gitconfig",
  "/usr/local/etc/gitconfig",
  "/opt/local/etc/gitconfig",
  "/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig",
  "/Applications/Xcode.app/Contents/Developer/usr/share/git-core/gitconfig",
];

/**
 * The config files that git reads in every repository, also where Xum's environment moves them:
 * Xum's own git runs outside the sandbox with that environment and runs what they name, and what
 * they include (Codex review).
 */
export function gitGlobalConfigFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...GIT_SYSTEM_CONFIG_FILES,
    ...["~/.gitconfig", "~/.config/git/config"].map(expandSandboxPathSpelling),
    ...envPath(env, "XDG_CONFIG_HOME", "git", "config"),
    ...envPath(env, "GIT_CONFIG_GLOBAL"),
    ...envPath(env, "GIT_CONFIG_SYSTEM"),
  ];
}

/**
 * `env[name]` joined with `rest`, when it is set. Git, npm, uv and Bun resolve a relative value
 * from the folder they run in, and Xum runs its own git in the workspace, which commands can
 * write (Codex review): fail closed.
 */
function envPath(env: NodeJS.ProcessEnv, name: string, ...rest: string[]): string[] {
  const dir = env[name];
  if (dir === undefined || dir.length === 0) return [];
  if (!path.isAbsolute(dir)) {
    throw new AgentSandboxStartError(`${name} is the relative path ${dir}`);
  }
  return [path.join(dir, ...rest)];
}

/** Environment for sandboxed commands, under the keys srt adds. */
export function sandboxToolEnv(): Record<string, string> {
  // In the temp folder, a write root, so uv and Bun work in the sandbox without the read-only
  // caches. Bun 1.4.4 and later keep what bunx runs in the install cache, so bunx works too.
  const ownCache = (name: string) => path.join(expandWriteRoot(os.tmpdir()), `xum-sandbox-${name}`);
  return {
    // A caller (a project secret) can set another TMPDIR, which the policy does not open.
    TMPDIR: os.tmpdir(),
    UV_CACHE_DIR: ownCache("uv-cache"),
    BUN_INSTALL_CACHE_DIR: ownCache("bun-cache"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: ownCache("bun-transpiler-cache"),
  };
}

/**
 * Read-only in every git folder the sandbox opens: Xum runs git with the user's full access
 * (gitNoHooksEnv.ts), and git runs hooks and reads config from these, also the config.worktree
 * of a repository with extensions.worktreeConfig and the git folders of its submodules.
 */
export const PROTECTED_GIT_DIR_PATHS: readonly string[] = [
  "hooks",
  "config",
  "config.worktree",
  "modules",
  // Git takes the config and hooks of the folder that a `commondir` file names, in any git folder.
  "commondir",
];

/**
 * What git reads from a linked worktree's own folder, <git folder>/worktrees/<name>. `commondir`
 * names the git folder whose config and hooks git uses there.
 */
export const PROTECTED_LINKED_WORKTREE_PATHS: readonly string[] = [
  "config.worktree",
  "modules",
  "commondir",
];

/**
 * Read-only under each write root. Xum, git or an editor runs these with full access, so a
 * sandboxed command that writes one escapes the sandbox later. `unlessFolder` entries apply
 * where the path is not a folder: a `.git` file (a worktree's pointer to its git folder) or a
 * missing `.git`, where a new pointer file would hand git a config of the command's choosing.
 */
export const PROTECTED_WRITE_PATHS: ReadonlyArray<string | { path: string; unlessFolder: true }> = [
  ...PROTECTED_GIT_DIR_PATHS.map((name) => `.git/${name}`),
  { path: ".git", unlessFolder: true },
  // MCP servers start outside the sandbox, and the workspace overrides
  // (workspaceMcpOverridesService.ts) choose which of them start.
  ...["mcp.jsonc", "mcp.local.jsonc", "mcp.local.json"].flatMap(listProjectMetadataRelativePaths),
  // Bash sources it before the script, also for a call the user let run outside the sandbox.
  ...listProjectMetadataRelativePaths("tool_env"),
  // Plugin hooks and MCP servers: every plugin container (projectPluginContainerPaths).
  ".mcp.json",
  ...listProjectMetadataRelativePaths("plugins"),
  ".agents/plugins",
  // The editor and direnv run them.
  ".vscode",
  ".idea",
  ".envrc",
  ".gitmodules",
  // `devcontainer up` (Xum's Dev Container runtime, an editor) runs initializeCommand on the host.
  ".devcontainer.json",
  ".devcontainer",
];

// Every home folder and every external disk. System files stay readable.
export const DENY_READ_ROOTS: readonly string[] = ["/Users", "/Volumes"];

/** Global skill and plugin roots (agentSkillsService.ts): skill scripts run from them. */
const GLOBAL_SKILL_ROOTS: readonly string[] = [
  `${XUM_HOME_TOKEN}/skills`,
  "~/.agents/skills",
  "~/.claude/skills",
  "~/.mux/skills",
];
const PLUGIN_ROOTS: readonly string[] = [`${XUM_HOME_TOKEN}/plugins`, "~/.agents/plugins"];
/** Folders whose entries Xum loads as skills and plugins; an entry can be a link to a checkout. */
export const AUTOMATION_ENTRY_ROOTS: readonly string[] = [...GLOBAL_SKILL_ROOTS, ...PLUGIN_ROOTS];

/**
 * Read paths with code that Xum runs in every workspace, also in one without the sandbox, and
 * plugin MCP servers start outside it. Any of them can be a link into a write root (a dotfiles
 * setup), where it must stay read-only.
 */
export const AUTOMATION_READ_PATHS: readonly string[] = [
  // Git that Xum runs outside the sandbox runs what they name (credential.helper,
  // core.sshCommand).
  "~/.gitconfig",
  "~/.config/git",
  ...GLOBAL_SKILL_ROOTS,
  ...PLUGIN_ROOTS,
  // Xum's own helper scripts (tool_env and the like).
  `${XUM_HOME_TOKEN}/bin`,
  // The global tool hooks (hooks.ts): Xum runs them in the sandbox, so it must read them.
  ...["tool_env", "tool_hook", "tool_pre", "tool_post"].map((name) => `${XUM_HOME_TOKEN}/${name}`),
];

/**
 * Automation that stays closed for reads: bunx for MCP servers runs the preload that
 * ~/.bunfig.toml names, which can hold a registry token as ~/.npmrc can, and Xum's own `git fetch`
 * runs a ProxyCommand from ~/.ssh/config, whose folder stays closed. Every workspace, also one
 * without the sandbox, gets the global instruction files in its prompt (readInstructionSet() and
 * readClaudeCompatGlobalInstructionSet() in instructionFiles.ts). extraReadPaths can open them.
 */
export const HIDDEN_AUTOMATION_PATHS: readonly string[] = [
  "~/.bunfig.toml",
  "~/.ssh/config",
  "~/.claude/CLAUDE.md",
  ...["AGENTS.md", "AGENT.md", "CLAUDE.md", "AGENTS.local.md"].map(
    (name) => `${XUM_HOME_TOKEN}/${name}`
  ),
];

// Open under ~ for each command, with the workspace, its scratch folder, the main .git of a
// worktree, all write paths and extraReadPaths.
export const HOME_READ_PATHS: readonly string[] = [
  "~/.bun",
  "~/.cargo",
  "~/.rustup",
  "~/go",
  // Go reads its env file here (measured on macOS 27.2).
  "~/Library/Application Support/go",
  "~/.nvm",
  "~/.volta",
  "~/.pyenv",
  "~/.asdf",
  "~/.local/share/mise",
  "~/.local/share/uv",
  "~/.sdkman",
  ...AUTOMATION_READ_PATHS,
];

// Denied after the allows, so no open folder or extraReadPaths entry exposes them.
// <xumHome> can be outside ~ (XUM_ROOT), so its files need their own denies.
// Not open either: ~/.npmrc, ~/.bunfig.toml, ~/.pypirc, ~/.gradle/gradle.properties,
// ~/.m2/settings.xml. They can hold tokens; the user can add each one to extraReadPaths.
export const NESTED_DENY_READ_PATHS: readonly string[] = [
  "~/.cargo/credentials.toml",
  "~/.cargo/credentials",
  "~/.config/git/credentials",
  "~/.cache/huggingface/token",
  `${XUM_HOME_TOKEN}/server.lock`,
  `${XUM_HOME_TOKEN}/providers.jsonc`,
  `${XUM_HOME_TOKEN}/secrets.json`,
  `${XUM_HOME_TOKEN}/mcp-oauth.json`,
  `${XUM_HOME_TOKEN}/config.json`,
  // SSH prompts and their answers, passwords too (askpassSessionsRoot() in sshAskpass.ts).
  `${XUM_HOME_TOKEN}/askpass`,
];

/** `~/x`, `<xumHome>/x` or an absolute path, as the real path Seatbelt matches. */
export function expandSandboxPath(entry: string): string {
  return realpathOfNearest(expandSandboxPathSpelling(entry));
}

/**
 * A write root as Seatbelt matches it, except that a symlink at the root itself is not followed:
 * a sandboxed command may replace the root (it may write that entry) with a link, and a later
 * policy that followed it would open wherever the link points.
 */
export function expandWriteRoot(entry: string): string {
  const spelled = expandSandboxPathSpelling(entry);
  return path.join(realpathOfNearest(path.dirname(spelled)), path.basename(spelled));
}

/** `~/x`, `<xumHome>/x` or an absolute path, without resolving symlinks. */
export function expandSandboxPathSpelling(entry: string): string {
  if (entry === "~") return os.homedir();
  if (entry.startsWith("~/")) return path.join(os.homedir(), entry.slice(2));
  if (entry === XUM_HOME_TOKEN) return getXumHome();
  if (entry.startsWith(`${XUM_HOME_TOKEN}/`)) {
    return path.join(getXumHome(), entry.slice(XUM_HOME_TOKEN.length + 1));
  }
  return path.resolve(entry);
}

/**
 * The real path of `target`, or of its nearest existing ancestor with the rest appended, so a
 * path that does not exist yet still gets the spelling Seatbelt will see once it does.
 */
export function realpathOfNearest(target: string): string {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      // eslint-disable-next-line local/no-sync-fs-methods -- the policy is built synchronously (agentSandboxPolicy).
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Whether `child` is `parent` or lies beneath it, by path segment. */
export function isPathAtOrUnder(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === "") return true;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function dedupe(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}
