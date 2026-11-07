import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getXumHome } from "@/common/constants/paths";

/**
 * The folders and files that the macOS agent sandbox opens or closes. Entries start with `~/`
 * (the user's home) or `<xumHome>/` (getXumHome(), which XUM_ROOT can move outside `~`), or are
 * absolute. expandSandboxPath() turns each into a real path: Seatbelt matches real paths only, so
 * a rule for /tmp (a symlink to /private/tmp) would match nothing.
 */

const XUM_HOME_TOKEN = "<xumHome>";

/** Temp folders every sandboxed command may write. */
export function tempWritePaths(): string[] {
  return dedupe(["/private/tmp", realpathOfNearest(os.tmpdir())]);
}

// Other apps keep caches in ~/Library/Caches too, so only tool folders open.
// Not writable: ~/.bun/bin, ~/.cargo/bin, ~/go/bin, ~/.local/bin, /opt/homebrew and
// /usr/local. A file there runs in every later shell.
export const CACHE_WRITE_PATHS: readonly string[] = [
  "~/.npm",
  "~/.bun/install/cache",
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
  "~/Library/Caches/bun",
  "~/Library/Developer/Xcode/DerivedData",
];

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
];

/** What git reads from a linked worktree's own folder, <git folder>/worktrees/<name>. */
export const PROTECTED_LINKED_WORKTREE_PATHS: readonly string[] = ["config.worktree", "modules"];

/**
 * Read-only under each write root. Xum, git or an editor runs these with full access, so a
 * sandboxed command that writes one escapes the sandbox later. `ifFile` entries apply only where
 * the path is a file (a worktree's `.git` pointer to its git folder).
 */
export const PROTECTED_WRITE_PATHS: ReadonlyArray<string | { path: string; ifFile: true }> = [
  ...PROTECTED_GIT_DIR_PATHS.map((name) => `.git/${name}`),
  { path: ".git", ifFile: true },
  // MCP servers start outside the sandbox.
  ".xum/mcp.jsonc",
  ".mux/mcp.jsonc",
  // Plugin hooks and MCP servers.
  ".mcp.json",
  ".xum/plugins",
  // The editor and direnv run them.
  ".vscode",
  ".idea",
  ".envrc",
  ".gitmodules",
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

// Open under ~ for each command, with the workspace, its scratch folder, the main .git of a
// worktree, all write paths and extraReadPaths.
export const HOME_READ_PATHS: readonly string[] = [
  "~/.gitconfig",
  "~/.config/git",
  "~/.bunfig.toml",
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
  ...GLOBAL_SKILL_ROOTS,
  ...PLUGIN_ROOTS,
  // Xum's own helper scripts (tool_env and the like).
  `${XUM_HOME_TOKEN}/bin`,
  // The global tool hooks (hooks.ts): Xum runs them in the sandbox, so it must read them.
  ...["tool_env", "tool_hook", "tool_pre", "tool_post"].map((name) => `${XUM_HOME_TOKEN}/${name}`),
];

// Denied after the allows, so no open folder or extraReadPaths entry exposes them.
// <xumHome> can be outside ~ (XUM_ROOT), so its files need their own denies.
// Not open either: ~/.npmrc, ~/.pypirc, ~/.gradle/gradle.properties, ~/.m2/settings.xml. They can
// hold tokens; the user can add each one to extraReadPaths.
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
];

/** `~/x`, `<xumHome>/x` or an absolute path, as the real path Seatbelt matches. */
export function expandSandboxPath(entry: string): string {
  return realpathOfNearest(expandSandboxPathSpelling(entry));
}

/** `~/x`, `<xumHome>/x` or an absolute path, without resolving symlinks. */
function expandSandboxPathSpelling(entry: string): string {
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
