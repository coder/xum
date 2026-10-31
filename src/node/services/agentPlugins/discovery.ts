import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import assert from "@/common/utils/assert";

import {
  PROJECT_METADATA_DIR_NAMES,
  listProjectMetadataRelativePaths,
} from "@/common/compat/legacyMux";
import type { AgentPluginImportedComponents } from "@/common/config/schemas/agentPluginInstalls";
import { getErrorMessage } from "@/common/utils/errors";
import { projectAutomationDisabled } from "@/node/utils/projectAutomation";
import { log } from "@/node/services/log";
import {
  ensurePathContained,
  hasErrorCode,
  SKILL_FILENAME,
} from "@/node/services/tools/skillFileUtils";
import { SkillNameSchema } from "@/common/orpc/schemas";
import { isMutationEpochUnreadable, readContainerMutationState } from "./journals";
import { PLUGIN_REGISTRY_FILE_NAME, readPluginComponentImports } from "./registry";
import { noComponentConsent, type ComponentConsent } from "./componentConsent";
import type { ApprovedCopiesSource } from "./approvedCopies";
import {
  hasGeneratedFromMarker,
  INERT_COMPONENT_PATH,
  readGeneratedFrom,
  isPlainObject,
  isValidAgentPluginName,
  validatePluginManifest,
  type AgentPluginManifest,
} from "./manifest";
import {
  normalizeCodexManifest,
  readOpenAIExtension,
  type OpenAIPluginExtension,
} from "./openaiExtension";
import { normalizeClaudeManifest, type ClaudePluginComponents } from "./claudeManifest";
import { normalizeCursorManifest, type CursorManifestResult } from "./cursorManifest";
import { convertCursorRule, cursorRuleName, type CursorRuleRefusal } from "./cursorRules";
import { loadPluginCursorHooks } from "./cursorHooks";
import type { PluginHooksLoadResult } from "./codexHooks";
import { pluginSkillFileName } from "./claudeCommands";
import { pluginAgentIdOf } from "./agentFiles";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import type { HostFiles } from "@/node/services/hostFiles/hostFiles";
import { nodeHostFiles, nodeHostPaths } from "@/node/services/hostFiles/nodeHostFiles";

/**
 * Agent Plugins 1.0.0 discovery (§4, §6).
 *
 * A plugin is an immediate child directory of a configured container directory
 * that holds a regular `plugin.json` file (or, for Codex-scaffolded packages,
 * only `.codex-plugin/plugin.json`, for Claude Code plugins only
 * `.claude-plugin/plugin.json`, or for Cursor plugins only `.cursor-plugin/plugin.json`).
 * Entries without any manifest are
 * skipped silently (containers may hold unrelated files, e.g. Codex drops
 * `marketplace.json` into `~/.agents/plugins`). Failure isolation is per §11.3:
 * one broken plugin never affects sibling plugins, and one broken component
 * (skills/ or mcp.json) never affects the plugin's other component.
 *
 * Discovery reads through a PluginFs, not a Runtime: the host filesystem
 * (nodePluginFs) by default, or a remote checkout's listing held in memory
 * (discoverAgentPluginsIn, #6426).
 */

export type AgentPluginScope = "project" | "global";

/**
 * Tilde-form universal plugins container (`~/.agents/plugins`). Shared by
 * loader default-roots computations (skills, agent definitions) that resolve
 * tilde paths through a LocalRuntime.
 */
export const UNIVERSAL_AGENT_PLUGINS_CONTAINER = "~/.agents/plugins";

/**
 * Generous ceiling for a plausible plugin.json (name/description/contributes
 * declarations). A repository can otherwise put its entire checkout quota
 * into one unbounded manifest string, and the install consent preview would
 * ship that through IPC and render it — freezing the app before consent.
 * Skill/agent markdown already has runtime size caps; this closes the same
 * hole for the manifest.
 */
export const PLUGIN_MANIFEST_RELATIVE_PATH = "plugin.json";
/** Codex compatibility manifest, read only when the root plugin.json is absent. */
export const CODEX_PLUGIN_MANIFEST_RELATIVE_PATH = path.join(".codex-plugin", "plugin.json");
/**
 * Claude Code manifest, read only when neither manifest above exists. A repository that has
 * both keeps its Agent Plugin or Codex reading.
 */
export const CLAUDE_PLUGIN_MANIFEST_RELATIVE_PATH = path.join(".claude-plugin", "plugin.json");
export const CURSOR_PLUGIN_MANIFEST_RELATIVE_PATH = path.join(".cursor-plugin", "plugin.json");
/** Codex MCP config, the default only when the root mcp.json is absent. */
export const CODEX_MCP_CONFIG_RELATIVE_PATH = ".mcp.json";

export const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024;

/**
 * Ceiling for hooks.js source. Unlike other components, the hook FILE itself
 * is read and hashed on every send and evaluated in the Electron main
 * process, so a repository devoting its checkout quota to one giant script
 * could stall the app after an accepted install. Enforced here so the
 * consent preview and runtime discovery exclude the identical component set.
 */
export const MAX_PLUGIN_HOOK_SOURCE_BYTES = 1024 * 1024;

export interface PluginFileReadResult {
  content: string;
  /** Raw bytes of `content` (for binary files such as interface images). */
  bytes: Buffer;
  /** Bytes actually returned (handle-read), for pagination/size metadata. */
  byteSize: number;
  /** Modification time from the SAME handle's fstat as the content read. */
  modifiedTime: Date;
}

/** The file kinds and size that discovery reads from a stat or lstat. */
export interface PluginFsStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}

export interface PluginFsDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * Every filesystem read that plugin discovery and the contained plugin reader make (#6426). The
 * host filesystem is `nodePluginFs`. Another implementation (a remote checkout's listing held in
 * memory) lets the unchanged discovery rules run without host files. Like node:fs/promises,
 * methods reject (never throw synchronously), with the same `code` values (ENOENT when missing).
 */
export interface PluginFs {
  realpath(filePath: string): Promise<string>;
  stat(filePath: string): Promise<PluginFsStat>;
  lstat(filePath: string): Promise<PluginFsStat>;
  readdir(dirPath: string): Promise<PluginFsDirent[]>;
  /** ensurePathContained: the realpath of `candidatePath`, which must stay inside `root`. */
  ensureContained(
    root: string,
    candidatePath: string,
    options?: { allowMissing?: boolean }
  ): Promise<string>;
  /** readPluginFileWithinRootCapped's contract: contained, identity-checked and capped. */
  readFileCapped(args: PluginFileReadArgs): Promise<PluginFileReadResult>;
}

export interface PluginFileReadArgs {
  filePath: string;
  pluginRoot: string;
  maxBytes: number;
  /** Component name used in error messages (e.g. "hooks.js"). */
  label: string;
}

const hostPluginFsByFiles = new WeakMap<HostFiles, PluginFs>();

/**
 * The PluginFs of a host filesystem: one object per HostFiles, so a read costs no wrapper per
 * call. Phase 5: the host-local scans of skills, agents and plugins read the HostFiles of their
 * RuntimeFactory, so a test graph's memory host serves them too.
 */
export function hostPluginFs(files: HostFiles): PluginFs {
  const known = hostPluginFsByFiles.get(files);
  if (known !== undefined) return known;
  const fs: PluginFs = {
    realpath: (filePath) => files.promises.realpath(filePath),
    stat: (filePath) => files.promises.stat(filePath),
    lstat: (filePath) => files.promises.lstat(filePath),
    readdir: (dirPath) => files.promises.readdir(dirPath, { withFileTypes: true }),
    ensureContained: (root, candidatePath, options) =>
      ensurePathContained(root, candidatePath, options, files),
    // The reader's own containment check (ensurePluginPathContained) reads the current PluginFs.
    readFileCapped: (args) =>
      pluginFsStorage.run(fs, () => readPluginFileWithinRootCapped(args, files)),
  };
  hostPluginFsByFiles.set(files, fs);
  return fs;
}

/** The host filesystem. */
export const nodePluginFs: PluginFs = hostPluginFs(nodeHostFiles);

/**
 * The PluginFs of the discovery that is running. AsyncLocalStorage, not a parameter, so the
 * many internal helpers keep their signatures; concurrent discoveries never share a store.
 */
const pluginFsStorage = new AsyncLocalStorage<PluginFs>();

function pluginFs(): PluginFs {
  return pluginFsStorage.getStore() ?? nodePluginFs;
}

/**
 * discoverAgentPlugins on another filesystem (#6426): every read of the discovery goes through
 * `fs`, whose paths are POSIX paths (POSIX hosts only). The exported readers
 * (readPluginFileWithinRootCapped, ensurePluginPathContained) stay host readers outside such a
 * run; a caller reads a non-host plugin's files with `fs` itself.
 */
export async function discoverAgentPluginsIn(
  fs: PluginFs,
  containers: AgentPluginContainer[]
): Promise<DiscoverAgentPluginsResult> {
  // Managed installs (registries, journals) exist only on the host.
  assert(
    containers.every((container) => container.registryPath === undefined),
    "discoverAgentPluginsIn: a non-host PluginFs cannot hold managed containers"
  );
  // Discovery joins paths with the host `node:path`. A non-host PluginFs holds POSIX paths, which
  // a Windows host would rewrite with backslashes, so a Windows host finds no plugins there
  // (fail closed; #7226 tracks Windows hosts).
  if (process.platform === "win32") {
    log.debug("discoverAgentPluginsIn: not supported on a Windows host");
    return { plugins: [], diagnostics: [] };
  }
  return await pluginFsStorage.run(fs, () => discoverAgentPlugins(containers));
}

/**
 * discoverAgentPlugins on a host filesystem (hostPluginFs of the caller's RuntimeFactory, phase
 * 5). Unlike discoverAgentPluginsIn, managed containers are allowed: their registries and
 * journals still read the Node host.
 */
export async function discoverAgentPluginsOnHost(
  fs: PluginFs,
  containers: AgentPluginContainer[],
  options?: { managedHome?: string }
): Promise<DiscoverAgentPluginsResult> {
  return await pluginFsStorage.run(fs, () => discoverAgentPlugins(containers, options));
}

/** A plugin path that resolves into the plugin root's `.git` directory (#6161). */
export class PluginGitPathError extends Error {
  constructor() {
    super("Path resolves into the plugin's .git directory.");
    this.name = "PluginGitPathError";
  }
}

/**
 * Contained resolution of a path inside a plugin root (ensurePathContained), which also refuses
 * the root's `.git` directory and anything under it. A staged clone still holds `.git` (its
 * config can carry the remote's credentials), and a committed symlink into it passes plain
 * containment, so a preview would disclose it as a hook or skill body (#6161). The one rule for
 * every plugin component read: the contained reader, component resolution and the install
 * preview's skill scan.
 */
export async function ensurePluginPathContained(
  pluginRoot: string,
  candidatePath: string,
  options?: { allowMissing?: boolean }
): Promise<string> {
  const resolved = await pluginFs().ensureContained(pluginRoot, candidatePath, options);
  const relative = path.relative(await pluginFs().realpath(pluginRoot), resolved);
  // Case-insensitive: on macOS and Windows `.GIT` is the same directory.
  if (relative.split(path.sep)[0].toLowerCase() === ".git") {
    throw new PluginGitPathError();
  }
  return resolved;
}

/**
 * Read a consented plugin component file (hooks.js, mcp.json, agents/*.md,
 * SKILL.md + referenced skill files, workflows/*.js) through a bounded
 * handle, revalidating containment and identity AFTER the open.
 *
 * Discovery's measurement and the consuming read are separated by an
 * update-sized TOCTOU window: a managed update (or a checkout flipping an
 * unmanaged project plugin) can replace the canonical path — or any ANCESTOR
 * component on it, including the plugin root itself — with a symlink to
 * existing content outside the plugin root. Staged validation only rejects
 * links into the managed container, and discovery treats the escaping link
 * as a capability REMOVAL, so the swapped tree is permitted; a stale
 * canonical path would then read (and execute/parse) attacker-chosen outside
 * content. Three post-open checks close this (a promotion is a single swap,
 * so a link the open followed is still present here):
 * 1. Root identity: `pluginRoot` is the CANONICAL root discovery resolved
 *    (legitimate committed root symlinks were already followed there), so it
 *    must still be fully physical: realpath(pluginRoot) must equal
 *    pluginRoot. Were the root — or ANY ancestor of it — now a link,
 *    realpathing root and file would resolve BOTH into the replacement tree
 *    and containment below would vacuously pass.
 * 2. Containment recheck: the fully-resolved file path must stay inside the
 *    plugin root, catching replacement links at any ancestor component.
 * 3. Leaf identity at the RESOLVED path: the opened object must BE the
 *    regular file a non-following lstat sees at the fully-resolved pathname.
 *    Consent-time validation accepts contained relative symlinks (e.g. a
 *    SKILL.md linking elsewhere inside the plugin), so a contained link is
 *    legitimate — resolution already proved it stays inside — while a
 *    concurrent replacement fails the dev/ino match.
 * The size ceiling is enforced on the same handle (fstat), and the read is
 * bounded to the fstat-reported byte count so a file growing mid-read stays
 * capped. Returned metadata comes from that same handle so callers never
 * pair post-open content with pre-open stat results. Over-blocking is safe —
 * the caller skips and re-measures on the next discovery.
 */
export async function readPluginFileWithinRootCapped(
  args: PluginFileReadArgs,
  /** The host filesystem of the read (hostPluginFs). Absent: the Node layer. */
  files: HostFiles = nodeHostFiles
): Promise<PluginFileReadResult> {
  const { filePath, pluginRoot, maxBytes, label } = args;
  // Opening a FIFO for reading blocks until a writer appears, which would hang every caller
  // (list(), preview, skill/agent/hook/MCP config loads). Refuse anything but a regular file
  // before the open; O_NONBLOCK covers a swap to a FIFO between this stat and the open (it
  // has no effect on regular files), and the identity check below still runs after the open.
  const fsPromises = files.promises;
  const target = await fsPromises.stat(filePath);
  if (!target.isFile()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
  const { O_RDONLY, O_NONBLOCK } = fsPromises.constants;
  const handle = await fsPromises.open(
    filePath,
    process.platform === "win32" ? O_RDONLY : O_RDONLY | O_NONBLOCK
  );
  try {
    const stat = await handle.stat({ bigint: true });
    const rootReal = await fsPromises.realpath(pluginRoot);
    if (rootReal !== pluginRoot) {
      throw new Error(
        `${label} cannot be read: the plugin root pathname no longer resolves to itself (replaced since discovery): ${pluginRoot}`
      );
    }
    const resolvedPath = await ensurePluginPathContained(pluginRoot, filePath);
    const linkStat = await fsPromises.lstat(resolvedPath, { bigint: true });
    if (!linkStat.isFile() || linkStat.dev !== stat.dev || linkStat.ino !== stat.ino) {
      throw new Error(
        `${label} is not the regular file discovery measured (symlinked or replaced): ${filePath}`
      );
    }
    if (stat.size > BigInt(maxBytes)) {
      throw new Error(`${label} is too large (${stat.size} bytes; max ${maxBytes})`);
    }
    const buffer = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break; // Truncated since the fstat: return what exists.
      }
      offset += bytesRead;
    }
    return {
      content: buffer.subarray(0, offset).toString("utf8"),
      bytes: buffer.subarray(0, offset),
      byteSize: offset,
      modifiedTime: stat.mtime,
    };
  } finally {
    await handle.close();
  }
}

export interface AgentPluginContainer {
  /** Absolute host path of the container directory (e.g. `<projectRoot>/.xum/plugins`). */
  path: string;
  scope: AgentPluginScope;
  /** Only Xum's managed container owns an install registry; other global roots do not. */
  registryPath?: string;
}

export interface AgentPluginNotApplied {
  part: "field" | "rule" | "agent" | "hook" | "mcp" | "command";
  name: string;
  reason: string;
}

export interface AgentPluginInfo {
  /** Managed global imports; absent means legacy/unmanaged import-all. */
  importedComponents?: AgentPluginImportedComponents;
  componentPolicy?: { registryPath: string; name: string };
  /**
   * Managed plugins only: the reviewed fingerprints (#6498). Set together with componentPolicy;
   * an install without records gets empty ones, so nothing of it loads until reviewed.
   */
  componentConsent?: ComponentConsent;
  /**
   * Managed plugins only: where the install keeps the approved copies a changed skill or workflow
   * script falls back to (approvedCopies.ts). Set with componentConsent.
   */
  approvedCopies?: ApprovedCopiesSource;
  name: string;
  scope: AgentPluginScope;
  /** Canonical (realpath) plugin root directory. */
  rootPath: string;
  /** Lexical container directory this plugin was discovered in (as configured). */
  containerPath: string;
  /** Directory entry name under the container (lexical, pre-realpath). */
  dirName: string;
  manifest: AgentPluginManifest;
  /**
   * Found through `.codex-plugin/plugin.json`: only skills, MCP and the
   * com.openai fields are honored (no hooks, agents, workflows, slash
   * commands or `extensions.mux`).
   */
  codexFallback?: true;
  /**
   * A Claude Code package: found through `.claude-plugin/plugin.json`, or a plugin.json that Xum
   * generated from a Claude marketplace entry (the `claude-marketplace` marker). Skills, agents
   * and MCP are honored, hooks are listed but never run, and there is no hooks.js, workflows/,
   * slash command or `extensions.mux` (see normalizeClaudeManifest's SECURITY AUDIT).
   */
  claudeFallback?: true;
  /** Claude components without a `contributes` member (claudeFallback only; a marketplace
   * package carries its commands paths in the marker). */
  claude?: ClaudePluginComponents;
  /**
   * Found through `.cursor-plugin/plugin.json`: skills, rules (as skills), agents/ and its Cursor
   * hooks (`cursorHooks`) load. Like a Claude package it gets no hooks.js, workflows/, skill
   * workflow scripts, slash commands or `extensions`. Its MCP servers do not run yet; they are
   * listed in `notApplied`.
   */
  cursorFallback?: true;
  /**
   * A Cursor package's hooks, parsed when discovery read the package (cursorHooks.ts), so every
   * reader (the per-call trust gate included) sees the hooks of that one read.
   */
  cursorHooks?: PluginHooksLoadResult;
  notApplied: AgentPluginNotApplied[];
  /**
   * The plugin.json carries an `extensions.mux.generatedFrom` marker other than a well-formed
   * `claude-marketplace` one (Xum wrote it for a skills repository, or the repository claims
   * so): only skills load. No hooks.js, hooks.json, agents, workflows,
   * MCP, slash commands or com.openai (see discoverPluginAt).
   */
  skillsOnly?: true;
  /** Validated `extensions["com.openai"]` (parsed and exposed only; nothing consumes it yet). */
  openai?: OpenAIPluginExtension;
  /**
   * Root-relative manifest that supplied `openai`: `plugin.json`, or `.codex-plugin/plugin.json`
   * (a Codex-only package or the overlay). Codex hooks label their inline entries with it.
   */
  openaiManifestPath?: string;
  /**
   * Canonical skills roots in declared order (`skills/` by default, or `contributes.skills`),
   * then a Claude package's command roots or a Cursor package's rule roots. Each one exists, is a directory, and stays inside
   * the root (§6.2). Absent when none does.
   */
  skillsDirs?: PluginSkillsRoot[];
  /** Canonical `mcp.json` path; present only when it exists, is a regular file, and stays inside the root (§6.2). */
  mcpConfigPath?: string;
  /**
   * "codex": the MCP file is in the Codex `.mcp.json` dialect. "claude": the Codex dialect plus
   * the `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` names (see loadPluginMcpServers).
   */
  mcpConfigDialect?: "codex" | "claude";
  /** Canonical `hooks.js` path (Tier-1 sandboxed plugin hooks); present only
   * when it exists, is a regular file, and stays inside the root. Resolved
   * with the same §6.2 component rules as mcp.json. */
  hooksPath?: string;
  /** Canonical `agents/` directory (Mux contributes extension: agents/*.md
   * agent definitions). Same §6.2 component rules as skills/. */
  agentsDir?: string;
  /** Canonical `workflows/` directory (Mux contributes extension: workflows/*.js
   * scripts resolvable as `plugin://<name>/...`). Same §6.2 component rules as skills/. */
  workflowsDir?: string;
}

/**
 * One resolved skills root of a plugin. Claude Code rule: a skills path that holds SKILL.md
 * itself is ONE skill, so plugins that point `skills` at a single skill folder (or at the
 * plugin root) load as they do in Claude Code. Every scan site branches on `single`.
 */
export type PluginSkillsRoot =
  /** Holds `<name>/SKILL.md` skill folders. */
  | { dir: string; single?: undefined; name?: undefined; command?: undefined; rule?: undefined }
  /**
   * Holds SKILL.md itself. `name` is the skill name of the folder as declared
   * (pluginSkillNameOfFolder), or the plugin name when the path is the plugin root. It is not validated here: scan sites reject an invalid skill name.
   * `command`: a Claude command instead, the file `<dir>/<name>.md` (claudeCommands.ts). Its
   * `dir` is the commands folder and its name is valid. Command roots follow every skills root,
   * so a skill of the same name wins; discovery drops such a command with a warning.
   * `rule`: a Cursor rule instead, the file `<dir>/<rule>` (cursorRules.ts), for example
   * `prefer-const.mdc`. Rule roots follow the same rules as command roots.
   */
  | { dir: string; single: true; name: string; command?: true; rule?: undefined }
  | { dir: string; single: true; name: string; command?: undefined; rule: string };

/**
 * The skill name of a plugin skill folder. Claude Code and Codex name a skill by its SKILL.md
 * `name`, not its folder, so plugins ship snake_case folders: google/elephant-goldfish-model
 * has `skills/egm_bootstrap/SKILL.md` with `name: egm-bootstrap`. A folder with `_` and no `-`
 * loads under the kebab-case name. The mapping is 1:1 (pluginSkillFolderAlias inverts it), so a
 * lookup finds the folder without listing the root. Other names come back unchanged: scan sites
 * reject an invalid one, and the SKILL.md `name` must still match the result.
 */
export function pluginSkillNameOfFolder(folder: string): string {
  if (!folder.includes("_") || folder.includes("-")) return folder;
  return folder.replaceAll("_", "-");
}

/** The snake_case folder that can also hold plugin skill `name` (pluginSkillNameOfFolder). */
export function pluginSkillFolderAlias(name: string): string | undefined {
  return name.includes("-") ? name.replaceAll("-", "_") : undefined;
}

/**
 * The skill name of each plugin skill folder. A snake_case folder is dropped when the kebab-case
 * path is a directory (`isDirectory` follows symlinks): lookups try that path first and fall
 * back only when it is not a directory, so the two always agree. The path is stat'ed even when
 * the listing has no entry of that exact name: on a case-insensitive filesystem a `Foo-Bar`
 * folder answers the lookup of `foo-bar`.
 */
export async function pluginSkillFolderNames(
  folders: readonly string[],
  isDirectory: (folder: string) => Promise<boolean>
): Promise<Array<{ folder: string; name: string }>> {
  const entries: Array<{ folder: string; name: string }> = [];
  for (const folder of folders) {
    const name = pluginSkillNameOfFolder(folder);
    if (name !== folder && (await isDirectory(name))) continue;
    entries.push({ folder, name });
  }
  return entries;
}

/**
 * Whether the kebab-case twin of a snake_case plugin skill folder is a directory
 * (pluginSkillFolderNames). An entry Xum cannot stat for a reason other than absence (a symlink
 * loop, a permission error) counts as present: a lookup refuses such a folder instead of falling
 * back (#4438), so its snake_case twin must not load in its place anywhere.
 */
export function isPluginSkillDirectory(
  stat: Promise<{ isDirectory(): boolean }>
): Promise<boolean> {
  return stat.then(
    (result) => result.isDirectory(),
    (error: unknown) => !(hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR"))
  );
}

/**
 * The skill folders of one skills root, sorted: the root itself when it is a single skill, else
 * its subfolders, symlinks included (runtime discovery follows them, so consent must list them).
 * `name` is the skill name (pluginSkillNameOfFolder). `folder` is the folder's own name in a
 * container root, and `name` for a single root (whose review label is the root's path).
 * `file` is the skill's Markdown file (SKILL.md, or a command's `<name>.md`). Names are not
 * validated: callers report an invalid one.
 */
export async function listPluginSkillFolders(
  root: PluginSkillsRoot
): Promise<Array<{ name: string; folder: string; dir: string; file: string }>> {
  if (root.single) {
    const file = path.join(root.dir, pluginSkillFileName(root.name, root));
    return [{ name: root.name, folder: root.name, dir: root.dir, file }];
  }
  try {
    const entries = await pluginFs().readdir(root.dir);
    const folders = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    const isDirectory = (folder: string) =>
      isPluginSkillDirectory(pluginFs().stat(path.join(root.dir, folder)));
    return (await pluginSkillFolderNames(folders, isDirectory)).map(({ folder, name }) => ({
      name,
      folder,
      dir: path.join(root.dir, folder),
      file: path.join(root.dir, folder, SKILL_FILENAME),
    }));
  } catch {
    return [];
  }
}

export interface AgentPluginDiagnostic {
  /** Path of the plugin directory (or offending component path) the diagnostic refers to. */
  path: string;
  scope: AgentPluginScope;
  severity: "warning" | "error";
  message: string;
}

export interface DiscoverAgentPluginsResult {
  /** Baseline ordered logical registrations; aliases share physical reads and import policy. */
  plugins: AgentPluginInfo[];
  diagnostics: AgentPluginDiagnostic[];
}

async function listChildDirectories(containerPath: string): Promise<string[]> {
  try {
    const entries = await pluginFs().readdir(containerPath);
    // Include symlinks: a symlinked plugin directory is fine because its
    // realpath becomes the plugin root for all containment checks.
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // Missing/unreadable containers are not errors (§6.1).
    return [];
  }
}

/**
 * Resolve a component location inside the plugin root (§6.2):
 * - missing → absent (not an error)
 * - wrong filesystem kind or realpath escape → invalid (diagnostic), but only
 *   for that component
 * - otherwise → canonical path
 */
async function resolveComponentPath(args: {
  rootReal: string;
  relativePath: string;
  expectKind: "file" | "directory";
  componentLabel: string;
  scope: AgentPluginScope;
  diagnostics: AgentPluginDiagnostic[];
  /** For file components whose whole source gets loaded: exclude oversized files. */
  maxBytes?: number;
}): Promise<string | undefined> {
  const candidate = path.join(args.rootReal, args.relativePath);

  let canonical: string;
  try {
    canonical = await ensurePluginPathContained(args.rootReal, candidate);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    const message = `${args.componentLabel} resolves outside the plugin root; ignoring this component: ${getErrorMessage(error)}`;
    log.warn(`Agent plugin ${args.rootReal}: ${message}`);
    args.diagnostics.push({
      path: candidate,
      scope: args.scope,
      severity: "error",
      message,
    });
    return undefined;
  }

  let stat;
  try {
    stat = await pluginFs().stat(canonical);
  } catch {
    return undefined;
  }

  const kindOk = args.expectKind === "file" ? stat.isFile() : stat.isDirectory();
  if (!kindOk) {
    const message = `${args.componentLabel} must be a ${args.expectKind === "file" ? "regular file" : "directory"}; ignoring this component`;
    log.warn(`Agent plugin ${args.rootReal}: ${message}`);
    args.diagnostics.push({
      path: candidate,
      scope: args.scope,
      severity: "error",
      message,
    });
    return undefined;
  }

  if (args.maxBytes !== undefined && stat.size > args.maxBytes) {
    const message = `${args.componentLabel} is too large (${stat.size} bytes; max ${args.maxBytes}); ignoring this component`;
    log.warn(`Agent plugin ${args.rootReal}: ${message}`);
    args.diagnostics.push({
      path: candidate,
      scope: args.scope,
      severity: "error",
      message,
    });
    return undefined;
  }

  return canonical;
}

type ManifestCandidate =
  | { status: "missing" }
  | { status: "invalid"; message: string }
  | { status: "ok"; raw: unknown };

/**
 * Read one manifest location with the shared containment and size caps. `shown`: the path that
 * error messages name (shownManifestPath), default `relative`.
 */
async function readManifestCandidate(
  rootReal: string,
  relative: string,
  shown = relative
): Promise<ManifestCandidate> {
  let manifestReal: string;
  try {
    // #6161: neither manifest candidate may resolve into the plugin's .git.
    manifestReal = await ensurePluginPathContained(rootReal, path.join(rootReal, relative));
  } catch (error) {
    // ENOTDIR: a `.codex-plugin` file is not a manifest directory either.
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return { status: "missing" };
    }
    return {
      status: "invalid",
      message:
        error instanceof PluginGitPathError
          ? `${shown} resolves into the plugin's .git directory`
          : `${shown} resolves outside the plugin root: ${getErrorMessage(error)}`,
    };
  }
  const stat = await pluginFs()
    .stat(manifestReal)
    .catch(() => null);
  // A manifest of the wrong filesystem kind: not a plugin candidate.
  if (!stat?.isFile()) return { status: "missing" };
  if (stat.size > MAX_PLUGIN_MANIFEST_BYTES) {
    return {
      status: "invalid",
      message: `${shown} is too large (${stat.size} bytes; max ${MAX_PLUGIN_MANIFEST_BYTES})`,
    };
  }
  try {
    // The checks above only classify the candidate. The bytes come from one handle that is
    // identity-checked, contained and capped, so a local replacement after the size check
    // cannot redirect or grow the read (Codex PRRT_kwDOPxxmWM6rvwzc, #6297).
    const { content } = await pluginFs().readFileCapped({
      filePath: manifestReal,
      pluginRoot: rootReal,
      maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
      label: shown,
    });
    return { status: "ok", raw: JSON.parse(content) };
  } catch (error) {
    return { status: "invalid", message: `Failed to read ${shown}: ${getErrorMessage(error)}` };
  }
}

/** Resolve each declared skills root (default `skills/`), dropping missing, invalid and repeated ones. */
async function resolveSkillsRoots(args: {
  declared: string | string[] | undefined;
  rootReal: string;
  pluginName: string;
  resolveComponent: (relativePath: string, expectKind: "directory") => Promise<string | undefined>;
}): Promise<PluginSkillsRoot[]> {
  const roots: PluginSkillsRoot[] = [];
  const declared = args.declared;
  for (const relative of typeof declared === "string" ? [declared] : (declared ?? ["skills"])) {
    const canonical = await args.resolveComponent(relative, "directory");
    // Two spellings (or a symlink) can name one directory: scan it once.
    if (canonical === undefined || roots.some((root) => root.dir === canonical)) continue;
    // Only a declared path can name one skill folder (the Claude Code rule). The implicit
    // default skills/ always holds skill folders, even when it has a SKILL.md of its own.
    roots.push(
      declared === undefined
        ? { dir: canonical }
        : await classifySkillsRoot({ ...args, relative, canonical })
    );
  }
  return roots;
}

/**
 * The skills roots that a manifest `skills` value names in `pluginDir`, resolved as discovery
 * resolves them (containment, and a path that holds SKILL.md is one skill). For callers that
 * count skills without a plugin manifest on disk (the Skills CLI names, marketplace entries).
 */
export async function resolveDeclaredSkillsRoots(args: {
  pluginDir: string;
  declared: string | string[] | undefined;
  pluginName: string;
}): Promise<PluginSkillsRoot[]> {
  const rootReal = await pluginFs().realpath(args.pluginDir);
  const diagnostics: AgentPluginDiagnostic[] = [];
  return resolveSkillsRoots({
    declared: args.declared,
    rootReal,
    pluginName: args.pluginName,
    resolveComponent: (relativePath, expectKind) =>
      resolveComponentPath({
        rootReal,
        relativePath,
        expectKind,
        componentLabel: `${relativePath}/`,
        scope: "global",
        diagnostics,
      }),
  });
}

/** A declared skills root is one skill when it holds SKILL.md itself (PluginSkillsRoot). */
async function classifySkillsRoot(args: {
  relative: string;
  canonical: string;
  rootReal: string;
  pluginName: string;
}): Promise<PluginSkillsRoot> {
  // lstat: a SKILL.md symlink still marks the folder as one skill, so the scan sites'
  // containment checks refuse an escaping link instead of this folder being read as a
  // container of skill folders.
  const skillFile = await pluginFs()
    .lstat(path.join(args.canonical, "SKILL.md"))
    .catch(() => null);
  if (skillFile?.isFile() !== true && skillFile?.isSymbolicLink() !== true) {
    return { dir: args.canonical };
  }
  // The declared folder name, not the canonical one: a contained symlink keeps the name the
  // author wrote. The plugin root has no folder name of its own, so it takes the plugin's.
  // Decide "root" from the declared path, not the canonical one: `alias -> .` is still
  // the folder the author named `alias`.
  const declaredPath = path.resolve(args.rootReal, args.relative);
  const name =
    declaredPath === args.rootReal
      ? args.pluginName
      : pluginSkillNameOfFolder(path.basename(declaredPath));
  return { dir: args.canonical, single: true, name };
}

/** Commands read per plugin: each one is a skills root that every scan site visits. */
export const MAX_PLUGIN_COMMANDS = 256;

/** The `<name>.md` command files a `commands` path names: one file, or a folder's flat files. */
async function listCommandFiles(
  relative: string,
  resolveComponent: (
    relativePath: string,
    expectKind: "file" | "directory"
  ) => Promise<string | undefined>
): Promise<Array<{ dir: string; file: string }>> {
  if (relative.endsWith(".md")) {
    // The declared file name is the command name, also when the file is a contained symlink
    // (as for a folder's entries): resolve the file for containment, then read it through
    // its declared parent folder.
    if ((await resolveComponent(relative, "file")) === undefined) return [];
    const dir = await resolveComponent(path.posix.dirname(relative), "directory");
    return dir === undefined ? [] : [{ dir, file: path.posix.basename(relative) }];
  }
  const dir = await resolveComponent(relative, "directory");
  if (dir === undefined) return [];
  const entries = await pluginFs()
    .readdir(dir)
    .catch(() => []);
  // Symlinks too: every scan site reads them through the contained reader.
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map((file) => ({ dir, file }));
}

/**
 * The names of the skills that load from some skills roots: a valid folder name and a contained,
 * regular SKILL.md that parses. An empty or broken skill folder does not hide a command.
 */
async function listSkillNames(roots: PluginSkillsRoot[], rootReal: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (const root of roots) {
    for (const { name, file } of await listPluginSkillFolders(root)) {
      if (await isLoadableSkill(name, file, rootReal)) names.add(name);
    }
  }
  return names;
}

async function isLoadableSkill(name: string, file: string, rootReal: string): Promise<boolean> {
  const skillName = SkillNameSchema.safeParse(name);
  if (!skillName.success) return false;
  try {
    // The hardened reader checks containment, file type and size on the opened handle, so a file
    // swapped (for a link out of the root, a FIFO or a bigger file) after a check is not read.
    const { content, byteSize } = await pluginFs().readFileCapped({
      filePath: file,
      pluginRoot: rootReal,
      maxBytes: MAX_FILE_SIZE,
      label: SKILL_FILENAME,
    });
    parseSkillMarkdown({
      content,
      byteSize,
      directoryName: skillName.data,
      allowDisplayName: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Claude's and Cursor's single-skill layout: a plugin with SKILL.md at its root, no skills/ and no
 * `skills` key loads as one skill (the caller passes "." as the declared skills path).
 */
async function isClaudeRootSkill(rootReal: string): Promise<boolean> {
  if (
    (await pluginFs()
      .lstat(path.join(rootReal, "skills"))
      .catch(() => null)) !== null
  ) {
    return false;
  }
  const skillFile = await pluginFs()
    .lstat(path.join(rootReal, SKILL_FILENAME))
    .catch(() => null);
  return skillFile?.isFile() === true || skillFile?.isSymbolicLink() === true;
}

/**
 * Claude `agents` lists single files, but every agent scan site reads the whole folder. So a
 * folder that holds an agent file the list does not name loads no agents at all (with a
 * warning naming those files): Xum never loads an agent the manifest left out.
 */
async function keepDeclaredAgentsOnly(args: {
  agentsDir: string | undefined;
  declaredFiles: string[] | undefined;
  warn: (message: string) => void;
}): Promise<string | undefined> {
  if (args.agentsDir === undefined || args.declaredFiles === undefined) return args.agentsDir;
  // An empty list declares no agents (normalizeClaudeManifest warned when it was unmappable).
  if (args.declaredFiles.length === 0) return undefined;
  const entries = await pluginFs()
    .readdir(args.agentsDir)
    .catch(() => []);
  const declared = new Set(args.declaredFiles);
  const undeclared = entries
    .filter((entry) => entry.isFile() && pluginAgentIdOf(entry.name) !== null)
    .map((entry) => entry.name)
    .filter((name) => !declared.has(name))
    .sort((a, b) => a.localeCompare(b));
  if (undeclared.length === 0) return args.agentsDir;
  args.warn(
    `'agents' does not list ${undeclared.join(", ")} in its folder; Xum reads whole agent folders, so it loads no agents from this plugin`
  );
  return undefined;
}

/**
 * A Claude package's commands as single command roots (PluginSkillsRoot `command`), from the
 * manifest's `commands` paths or the default `commands/`. An invalid name, a repeated name and
 * a name that a skill folder already has are dropped with a warning: in Claude Code a skill wins
 * over a command of the same name.
 */
async function resolveCommandRoots(args: {
  declared: string[] | undefined;
  skillsDirs: PluginSkillsRoot[];
  resolveComponent: (
    relativePath: string,
    expectKind: "file" | "directory"
  ) => Promise<string | undefined>;
  rootReal: string;
  warn: (message: string) => void;
}): Promise<PluginSkillsRoot[]> {
  const taken = await listSkillNames(args.skillsDirs, args.rootReal);
  const roots: PluginSkillsRoot[] = [];
  for (const relative of args.declared ?? ["commands"]) {
    for (const { dir, file } of await listCommandFiles(relative, args.resolveComponent)) {
      const name = file.slice(0, -".md".length);
      if (!SkillNameSchema.safeParse(name).success) {
        args.warn(`Command '${file}' has no valid skill name (kebab-case); ignoring it`);
      } else if (taken.has(name)) {
        args.warn(`Command '${file}' is ignored: a skill or command named '${name}' comes first`);
      } else if (roots.length >= MAX_PLUGIN_COMMANDS) {
        args.warn(`More than ${MAX_PLUGIN_COMMANDS} commands; ignoring the rest`);
        return roots;
      } else {
        taken.add(name);
        roots.push({ dir, single: true, name, command: true });
      }
    }
  }
  return roots;
}

async function listRuleFiles(dir: string): Promise<Array<{ file: string; name: string }>> {
  const entries = await pluginFs()
    .readdir(dir)
    .catch(() => []);
  // Symlinks too: every scan site reads them through the contained reader.
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .flatMap((file) => {
      const name = cursorRuleName(file);
      return name === undefined ? [] : [{ file, name }];
    });
}

/**
 * The rule is read and converted here, as the scan sites do, so a refused rule is listed in
 * `notApplied` and no scan site sees it.
 */
async function ruleRefusal(args: {
  dir: string;
  file: string;
  name: string;
  rootReal: string;
}): Promise<CursorRuleRefusal | undefined> {
  let content: string;
  try {
    ({ content } = await pluginFs().readFileCapped({
      filePath: path.join(args.dir, args.file),
      pluginRoot: args.rootReal,
      maxBytes: MAX_FILE_SIZE,
      label: args.file,
    }));
  } catch (error) {
    return {
      reason: "the file cannot be read",
      warning: `Rule '${args.file}' cannot be read; ignoring it: ${getErrorMessage(error)}`,
    };
  }
  const converted = convertCursorRule({ name: args.name, file: args.file }, content);
  return "warning" in converted ? converted : undefined;
}

/**
 * Why one rule file does not load, or undefined when it does. A file that an earlier rule of the
 * plugin already read (through a link) is not read again, so links to one large file cost one read.
 */
async function ruleFileRefusal(args: {
  dir: string;
  file: string;
  name: string;
  rootReal: string;
  taken: ReadonlySet<string>;
  readFiles: Set<string>;
}): Promise<CursorRuleRefusal | undefined> {
  const { file, name } = args;
  if (!SkillNameSchema.safeParse(name).success) {
    return {
      reason: "not a valid skill name",
      warning: `Rule '${file}' has no valid skill name (kebab-case); ignoring it`,
    };
  }
  if (args.taken.has(name)) {
    return {
      reason: "a skill or rule of the same name comes first",
      warning: `Rule '${file}' is ignored: a skill or rule named '${name}' comes first`,
    };
  }
  const canonical = await pluginFs()
    .realpath(path.join(args.dir, file))
    .catch(() => undefined);
  if (canonical !== undefined && args.readFiles.has(canonical)) {
    return {
      reason: "the same file as an earlier rule",
      warning: `Rule '${file}' is the same file as an earlier rule; ignoring it`,
    };
  }
  if (canonical !== undefined) args.readFiles.add(canonical);
  return ruleRefusal(args);
}

/**
 * Every rule file counts toward MAX_PLUGIN_COMMANDS, a refused one too: discovery reads and parses
 * each one before any consent, so a repository must not get past the cap with files that fail.
 */
async function resolveRuleRoots(args: {
  ruleDirs: string[];
  skillsDirs: PluginSkillsRoot[];
  resolveComponent: (relativePath: string, expectKind: "directory") => Promise<string | undefined>;
  rootReal: string;
  warn: (message: string) => void;
}): Promise<{ roots: PluginSkillsRoot[]; notApplied: AgentPluginNotApplied[] }> {
  const taken = await listSkillNames(args.skillsDirs, args.rootReal);
  const readFiles = new Set<string>();
  const roots: PluginSkillsRoot[] = [];
  const notApplied: AgentPluginNotApplied[] = [];
  let examined = 0;
  for (const relative of args.ruleDirs) {
    const dir = await args.resolveComponent(relative, "directory");
    if (dir === undefined) continue;
    for (const { file, name } of await listRuleFiles(dir)) {
      if (examined >= MAX_PLUGIN_COMMANDS) {
        args.warn(`More than ${MAX_PLUGIN_COMMANDS} rules; ignoring the rest`);
        return { roots, notApplied };
      }
      examined++;
      const refusal = await ruleFileRefusal({
        dir,
        file,
        name,
        rootReal: args.rootReal,
        taken,
        readFiles,
      });
      if (refusal !== undefined) {
        args.warn(refusal.warning);
        notApplied.push({ part: "rule", name: file, reason: refusal.reason });
        continue;
      }
      taken.add(name);
      roots.push({ dir, single: true, name, rule: file });
    }
  }
  return { roots, notApplied };
}

async function firstExisting(rootReal: string, candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const entry = await pluginFs()
      .lstat(path.join(rootReal, candidate))
      .catch(() => null);
    if (entry !== null) return candidate;
  }
  return undefined;
}

/**
 * A declared `commands` field lists itself, the normalizer lists inline MCP servers, and the
 * hooks loader lists each hook that does not run.
 */
async function cursorPackageNotApplied(args: {
  rootReal: string;
  declaredMcp: string | undefined;
  declaresCommands: boolean;
}): Promise<AgentPluginNotApplied[]> {
  const checks: Array<{
    part: AgentPluginNotApplied["part"];
    candidates: string[];
    reason: string;
  }> = [
    {
      part: "mcp",
      candidates: args.declaredMcp !== undefined ? [args.declaredMcp] : ["mcp.json", ".mcp.json"],
      reason: "MCP servers of Cursor plugins load in a later Xum build",
    },
    {
      part: "command",
      candidates: args.declaresCommands ? [] : ["commands"],
      reason: "not applied in Xum",
    },
  ];
  const entries: AgentPluginNotApplied[] = [];
  for (const { part, candidates, reason } of checks) {
    const found = await firstExisting(args.rootReal, candidates);
    if (found !== undefined)
      entries.push({ part, name: part === "command" ? `${found}/` : found, reason });
  }
  return entries;
}

async function resolveCursorParts(args: {
  cursor: CursorManifestResult | undefined;
  rawManifest: unknown;
  skillsDirs: PluginSkillsRoot[];
  resolveComponent: (relativePath: string, expectKind: "directory") => Promise<string | undefined>;
  rootReal: string;
  warn: (message: string) => void;
}): Promise<{
  ruleRoots: PluginSkillsRoot[];
  notApplied: AgentPluginNotApplied[];
  hooks?: PluginHooksLoadResult;
}> {
  const { cursor } = args;
  if (cursor === undefined) return { ruleRoots: [], notApplied: [] };
  const rules = await resolveRuleRoots({
    ruleDirs: cursor.ruleDirs,
    skillsDirs: args.skillsDirs,
    resolveComponent: args.resolveComponent,
    rootReal: args.rootReal,
    warn: args.warn,
  });
  const onDisk = await cursorPackageNotApplied({
    rootReal: args.rootReal,
    declaredMcp: cursor.mcpConfigPath,
    declaresCommands: isPlainObject(args.rawManifest) && args.rawManifest.commands !== undefined,
  });
  const { notApplied: hooksNotApplied, ...hooks } = await loadPluginCursorHooks({
    rootPath: args.rootReal,
    source: cursor.hooks,
    fs: pluginFs(),
  });
  return {
    ruleRoots: rules.roots,
    notApplied: [...cursor.notApplied, ...rules.notApplied, ...onDisk, ...hooksNotApplied],
    hooks,
  };
}

/**
 * OpenAI settings: root `extensions["com.openai"]` when it is an object; otherwise (`overlay`) a
 * `.codex-plugin/plugin.json` next to it supplies them (the two are never merged). The overlay
 * contributes nothing else.
 */
async function selectOpenAISource(args: {
  rootReal: string;
  manifest: AgentPluginManifest;
  manifestRelative: string;
  overlay: boolean;
  scope: AgentPluginScope;
  diagnostics: AgentPluginDiagnostic[];
}): Promise<{
  openaiSource: Pick<AgentPluginManifest, "extensions">;
  openaiPath: string;
  openaiManifestPath: string;
}> {
  const { rootReal, scope, diagnostics } = args;
  const own = {
    openaiSource: args.manifest,
    openaiPath: path.join(rootReal, args.manifestRelative),
    openaiManifestPath: args.manifestRelative,
  };
  if (!args.overlay) return own;
  const overlayPath = path.join(rootReal, CODEX_PLUGIN_MANIFEST_RELATIVE_PATH);
  const overlay = await readManifestCandidate(rootReal, CODEX_PLUGIN_MANIFEST_RELATIVE_PATH);
  if (overlay.status === "invalid") {
    diagnostics.push({ path: overlayPath, scope, severity: "warning", message: overlay.message });
    return own;
  }
  if (overlay.status !== "ok") return own;
  const overlayManifest = normalizeCodexManifest(overlay.raw).manifest;
  const extensions = isPlainObject(overlayManifest) ? overlayManifest.extensions : undefined;
  if (!isPlainObject(extensions) || extensions["com.openai"] === undefined) return own;
  return {
    openaiSource: { extensions: { "com.openai": extensions["com.openai"] } },
    openaiPath: overlayPath,
    openaiManifestPath: CODEX_PLUGIN_MANIFEST_RELATIVE_PATH,
  };
}

/**
 * The plugin's MCP file and its dialect. Codex packages ship `.mcp.json`; it is the default only
 * when `mcp.json` is absent (an invalid `mcp.json` still reports its own diagnostic). Claude Code
 * reads only `.mcp.json`, so a Claude package never falls back to `mcp.json`.
 */
async function resolvePluginMcpConfig(args: {
  rootReal: string;
  declared: string | undefined;
  /** The MCP dialect of a Codex or Claude manifest; undefined for a root plugin.json. */
  manifestDialect: AgentPluginInfo["mcpConfigDialect"];
  resolveComponent: (relativePath: string, expectKind: "file") => Promise<string | undefined>;
}): Promise<Pick<AgentPluginInfo, "mcpConfigPath" | "mcpConfigDialect">> {
  const rootMcpJson =
    args.manifestDialect !== "claude" &&
    (await pluginFs()
      .lstat(path.join(args.rootReal, "mcp.json"))
      .catch(() => null)) !== null;
  const defaultMcpPath = rootMcpJson ? "mcp.json" : CODEX_MCP_CONFIG_RELATIVE_PATH;
  const mcpConfigPath = await args.resolveComponent(args.declared ?? defaultMcpPath, "file");
  if (mcpConfigPath === undefined) return {};
  // Lexical, before canonicalization: a Codex or Claude package's MCP file is in its
  // manifest's dialect, and the `.mcp.json` default of a root manifest is in the Codex dialect.
  if (args.manifestDialect !== undefined) {
    return { mcpConfigPath, mcpConfigDialect: args.manifestDialect };
  }
  return args.declared === undefined && !rootMcpJson
    ? { mcpConfigPath, mcpConfigDialect: "codex" }
    : { mcpConfigPath };
}

/**
 * Cursor reads `.mdc` and `.markdown` agents too, but every plugin agent scan site reads `.md`
 * files only (pluginAgentIdOf), so a Cursor package lists the others instead of dropping them
 * without a word.
 */
async function cursorAgentFilesNotApplied(
  cursor: CursorManifestResult | undefined,
  agentsDir: string | undefined
): Promise<AgentPluginNotApplied[]> {
  if (cursor === undefined || agentsDir === undefined) return [];
  const entries = await pluginFs()
    .readdir(agentsDir)
    .catch(() => []);
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => /\.(mdc|markdown)$/i.test(name))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((name) => ({ part: "agent", name, reason: "only .md agent files are applied in Xum" }));
}

/** The MCP servers of a Cursor package load in a later Xum build (Cursor plugin RFC PR 3). */
async function resolvePackageMcpConfig(args: {
  packageKind: {
    skillsOnly: boolean;
    claudePackage: boolean;
    codexFallback: boolean;
    cursorFallback: boolean;
  };
  rootReal: string;
  declared: string | undefined;
  resolveComponent: (relativePath: string, expectKind: "file") => Promise<string | undefined>;
}): Promise<Pick<AgentPluginInfo, "mcpConfigPath" | "mcpConfigDialect">> {
  const { skillsOnly, claudePackage, codexFallback, cursorFallback } = args.packageKind;
  if (skillsOnly || cursorFallback) return {};
  return resolvePluginMcpConfig({
    rootReal: args.rootReal,
    declared: args.declared,
    manifestDialect: claudePackage ? "claude" : codexFallback ? "codex" : undefined,
    resolveComponent: args.resolveComponent,
  });
}

/**
 * The manifest of a skills-only package: its metadata, `contributes.skills` and the marker. No
 * slash commands, component paths, hook tool grants or com.openai survive.
 */
function skillsOnlyManifest(manifest: AgentPluginManifest): AgentPluginManifest {
  const { contributes, extensions, ...metadata } = manifest;
  const mux = extensions?.mux;
  return {
    ...metadata,
    ...(contributes?.skills !== undefined ? { contributes: { skills: contributes.skills } } : {}),
    extensions: { mux: { generatedFrom: isPlainObject(mux) ? mux.generatedFrom : undefined } },
  };
}

/**
 * The manifest of a package generated from a Claude marketplace entry: metadata, the Claude
 * component paths (skills, agents, MCP file) and the marker. No slash commands, hooks.js or
 * workflows paths, hook tool grants or com.openai survive.
 */
function claudeMarketplaceManifest(manifest: AgentPluginManifest): AgentPluginManifest {
  const { contributes, extensions, ...metadata } = manifest;
  // Absent members stay undefined, which every reader treats as "not declared". The generator
  // writes the inert path for an agents or MCP path the entry did not declare (downgrade
  // safety, inertGeneratedComponents), so it reads as "not declared" too: the Claude defaults.
  const { skills, agents, mcp } = contributes ?? {};
  const declared = (value: string | undefined) =>
    value === INERT_COMPONENT_PATH ? undefined : value;
  const mux = extensions?.mux;
  return {
    ...metadata,
    contributes: { skills, agents: declared(agents), mcp: declared(mcp) },
    extensions: { mux: { generatedFrom: isPlainObject(mux) ? mux.generatedFrom : undefined } },
  };
}

/**
 * What a package loads, by its manifest file and its generatedFrom marker.
 *
 * SECURITY AUDIT: `extensions.mux.generatedFrom` marks a plugin.json that Xum generated
 * (installMethods.ts). A repository can write the marker itself, so it may only REMOVE
 * capabilities relative to a plain plugin.json. A well-formed `claude-marketplace` marker gets
 * the Claude package set: skills, commands as user-only skills (prompt files that a plain
 * plugin.json can ship as skills already), agents/ and MCP, but no hooks.js, workflows/, slash
 * commands, extensions.mux grants or com.openai, and its hooks.json never runs. Every other
 * marker, also a malformed or unknown one, is skills-only.
 */
function packageRules(args: {
  manifest: AgentPluginManifest;
  /** The manifest is the root plugin.json (the only file Xum generates). */
  rootManifest: boolean;
  claudeFallback: boolean;
  claude: ClaudePluginComponents | undefined;
}): {
  manifest: AgentPluginManifest;
  skillsOnly: boolean;
  /** A .claude-plugin/plugin.json package, or one generated from a marketplace entry. */
  claudePackage: boolean;
  claudeComponents: ClaudePluginComponents | undefined;
} {
  const generatedFrom = args.rootManifest ? readGeneratedFrom(args.manifest) : undefined;
  if (generatedFrom?.kind === "claude-marketplace") {
    return {
      manifest: claudeMarketplaceManifest(args.manifest),
      skillsOnly: false,
      claudePackage: true,
      claudeComponents: {
        ...(generatedFrom.commands !== undefined ? { commands: generatedFrom.commands } : {}),
        ...(generatedFrom.agentFiles !== undefined ? { agentFiles: generatedFrom.agentFiles } : {}),
      },
    };
  }
  const skillsOnly = hasGeneratedFromMarker(args.manifest);
  return {
    manifest: skillsOnly ? skillsOnlyManifest(args.manifest) : args.manifest,
    skillsOnly,
    claudePackage: args.claudeFallback,
    claudeComponents: args.claudeFallback ? args.claude : undefined,
  };
}

type XumComponent = "hooks" | "agents" | "workflows";

/** Where each Xum component lives by default and the AgentPluginInfo field that names it. */
const XUM_COMPONENTS: Record<
  XumComponent,
  {
    field: "hooksPath" | "agentsDir" | "workflowsDir";
    defaultPath: string;
    kind: "file" | "directory";
    options?: { maxBytes: number };
  }
> = {
  hooks: {
    field: "hooksPath",
    defaultPath: "hooks.js",
    kind: "file",
    options: { maxBytes: MAX_PLUGIN_HOOK_SOURCE_BYTES },
  },
  agents: { field: "agentsDir", defaultPath: "agents", kind: "directory" },
  workflows: { field: "workflowsDir", defaultPath: "workflows", kind: "directory" },
};

/**
 * Which Xum components a package kind may load. A package that was not written for Xum
 * ("foreign": a Claude or Cursor package, or a plugin.json with the generatedFrom marker) gets no Xum
 * executable code: no hooks.js and no workflows/. A Codex-fallback package gets skills, MCP and
 * com.openai only: no agents/ either (see normalizeCodexManifest's SECURITY AUDIT). A Claude
 * package keeps agents/ (Claude-format agents, reviewed as usual); a skills-only package does not.
 */
function xumComponentGate(args: {
  codexFallback: boolean;
  foreign: boolean;
  skillsOnly: boolean;
}): Record<XumComponent, boolean> {
  const xumCode = !args.codexFallback && !args.foreign;
  return { hooks: xumCode, agents: !args.codexFallback && !args.skillsOnly, workflows: xumCode };
}

/** hooks.js, agents/ and workflows/: each one the gate allows and the tree has. */
async function resolveXumComponents(args: {
  allowed: Record<XumComponent, boolean>;
  contributes: AgentPluginManifest["contributes"];
  resolveComponent: (
    relativePath: string,
    expectKind: "file" | "directory",
    options?: { maxBytes?: number }
  ) => Promise<string | undefined>;
}): Promise<Pick<AgentPluginInfo, "hooksPath" | "agentsDir" | "workflowsDir">> {
  const resolved: Pick<AgentPluginInfo, "hooksPath" | "agentsDir" | "workflowsDir"> = {};
  for (const component of ["hooks", "agents", "workflows"] as const) {
    if (!args.allowed[component]) continue;
    const spec = XUM_COMPONENTS[component];
    const canonical = await args.resolveComponent(
      args.contributes?.[component] ?? spec.defaultPath,
      spec.kind,
      spec.options
    );
    if (canonical !== undefined) resolved[spec.field] = canonical;
  }
  return resolved;
}

/**
 * A root plugin.json that other harnesses use (no `$schema` member): it yields to a Codex, a
 * Claude or a Cursor manifest (selectManifest).
 */
function isSchemaLessManifest(raw: unknown): boolean {
  return isPlainObject(raw) && raw.$schema === undefined;
}

/**
 * True when the root plugin.json of `rootReal` reads, through the manifest containment and size
 * caps, as a schema-less one. installMethods uses it so the method it offers is the manifest
 * discovery loads.
 */
export async function isSchemaLessRootManifest(rootReal: string): Promise<boolean> {
  const read = await readManifestCandidate(rootReal, PLUGIN_MANIFEST_RELATIVE_PATH);
  return read.status === "ok" && isSchemaLessManifest(read.raw);
}

/**
 * Pick the manifest of a plugin folder. Root plugin.json wins, then the Codex, the Claude Code and
 * the Cursor manifests. Each one goes through the same caps and containment. Null when none exists.
 *
 * A root plugin.json with no `$schema` is not an Agent Plugins manifest: other harnesses use the
 * same file name (DietrichGebert/ponytail ships `{"name":"ponytail"}` next to its Codex and Claude
 * manifests). It yields to a later candidate, and is returned (so validation reports it) only
 * when no other manifest exists. The fallback gets the narrower Codex, Claude or Cursor component
 * set.
 */
async function selectManifest(
  rootReal: string,
  /** See discoverAgentPluginAt: read errors name the file from here, like validation errors. */
  shownRoot: string | undefined
): Promise<{ relative: string; raw: unknown } | { relative: string; error: string } | null> {
  let schemaLessRoot: { relative: string; raw: unknown } | null = null;
  for (const relative of [
    PLUGIN_MANIFEST_RELATIVE_PATH,
    CODEX_PLUGIN_MANIFEST_RELATIVE_PATH,
    CLAUDE_PLUGIN_MANIFEST_RELATIVE_PATH,
    CURSOR_PLUGIN_MANIFEST_RELATIVE_PATH,
  ]) {
    const read = await readManifestCandidate(
      rootReal,
      relative,
      shownManifestPath(shownRoot, relative)
    );
    if (read.status === "missing") continue;
    if (read.status === "invalid") return { relative, error: read.message };
    if (relative === PLUGIN_MANIFEST_RELATIVE_PATH && isSchemaLessManifest(read.raw)) {
      schemaLessRoot = { relative, raw: read.raw };
      continue;
    }
    return { relative, raw: read.raw };
  }
  return schemaLessRoot;
}

function normalizeSelectedManifest(
  manifestRelative: string,
  raw: unknown
): {
  manifest: unknown;
  warnings: string[];
  claude: ClaudePluginComponents | undefined;
  cursor?: CursorManifestResult;
} {
  switch (manifestRelative) {
    case CODEX_PLUGIN_MANIFEST_RELATIVE_PATH:
      return { ...normalizeCodexManifest(raw), claude: undefined };
    case CLAUDE_PLUGIN_MANIFEST_RELATIVE_PATH:
      return normalizeClaudeManifest(raw);
    case CURSOR_PLUGIN_MANIFEST_RELATIVE_PATH: {
      const cursor = normalizeCursorManifest(raw);
      return { manifest: cursor.manifest, warnings: cursor.warnings, claude: undefined, cursor };
    }
    default:
      return { manifest: raw, warnings: [], claude: undefined };
  }
}

/** The manifest path an error shows: from `shownRoot` (default the plugin root), `/` on every OS. */
function shownManifestPath(shownRoot: string | undefined, manifestRelative: string): string {
  return path.posix.join(shownRoot ?? ".", manifestRelative.split(path.sep).join("/"));
}

async function discoverPluginAt(args: {
  pluginDir: string;
  containerPath: string;
  dirName: string;
  scope: AgentPluginScope;
  diagnostics: AgentPluginDiagnostic[];
  /** See discoverAgentPluginAt. */
  shownRoot?: string;
}): Promise<AgentPluginInfo | null> {
  const { pluginDir, scope, diagnostics } = args;

  const pushError = (targetPath: string, message: string): void => {
    log.warn(`Agent plugin ${pluginDir}: ${message}`);
    diagnostics.push({ path: targetPath, scope, severity: "error", message });
  };

  // The canonical plugin root anchors every §4.1 containment check.
  let rootReal: string;
  try {
    rootReal = await pluginFs().realpath(pluginDir);
  } catch {
    // Broken symlink / vanished entry: not a plugin.
    return null;
  }

  const selected = await selectManifest(rootReal, args.shownRoot);
  if (selected === null) {
    // No manifest → not a plugin (silent skip, e.g. Codex marketplace.json entries).
    return null;
  }
  const manifestRelative = selected.relative;
  const manifestPath = path.join(rootReal, manifestRelative);
  if ("error" in selected) {
    pushError(manifestPath, selected.error);
    return null;
  }
  const rawManifest = selected.raw;

  const codexFallback = manifestRelative === CODEX_PLUGIN_MANIFEST_RELATIVE_PATH;
  const claudeFallback = manifestRelative === CLAUDE_PLUGIN_MANIFEST_RELATIVE_PATH;
  const { cursor, ...normalized } = normalizeSelectedManifest(manifestRelative, rawManifest);
  const cursorFallback = cursor !== undefined;
  const validation = validatePluginManifest(normalized.manifest);
  if (!validation.ok) {
    const label =
      validation.reason === "unsupported-version"
        ? "Unsupported Agent Plugins version"
        : "Invalid plugin manifest";
    // Name the manifest: a plugin can carry plugin.json, .codex-plugin/plugin.json and
    // .claude-plugin/plugin.json, and the user must see which one failed. Forward slashes on
    // every OS, because the path is shown, not opened.
    const shownManifest = shownManifestPath(args.shownRoot, manifestRelative);
    pushError(manifestPath, `${label} (${shownManifest}): ${validation.errors.join("; ")}`);
    return null;
  }

  for (const warning of [...normalized.warnings, ...validation.warnings]) {
    log.debug(`Agent plugin ${pluginDir}: ${warning}`);
    diagnostics.push({ path: manifestPath, scope, severity: "warning", message: warning });
  }

  const { manifest, skillsOnly, claudePackage, claudeComponents } = packageRules({
    manifest: validation.manifest,
    rootManifest: manifestRelative === PLUGIN_MANIFEST_RELATIVE_PATH,
    claudeFallback,
    claude: normalized.claude,
  });

  const foreign = claudePackage || cursorFallback || skillsOnly;
  const { openaiSource, openaiPath, openaiManifestPath } = await selectOpenAISource({
    rootReal,
    manifest,
    manifestRelative,
    // A Claude or Cursor package has no extensions (its normalizer drops them), so it gets no
    // overlay either. Nor does a skills-only package: com.openai can point at hooks.
    overlay: !codexFallback && !foreign && !isPlainObject(manifest.extensions?.["com.openai"]),
    scope,
    diagnostics,
  });
  const openai = readOpenAIExtension(openaiSource);
  for (const warning of openai.warnings) {
    log.debug(`Agent plugin ${pluginDir}: ${warning}`);
    diagnostics.push({ path: openaiPath, scope, severity: "warning", message: warning });
  }

  // Defensive: the validator guarantees a spec-valid name.
  if (!isValidAgentPluginName(manifest.name)) {
    throw new Error(
      `discoverPluginAt: validated manifest has spec-invalid name '${manifest.name}'`
    );
  }

  // Manifest `contributes` path members override the conventional component
  // locations; the manifest validator already restricted them to safe relative
  // paths, and resolveComponentPath re-enforces realpath containment.
  const contributes = manifest.contributes;
  const resolveComponent = (
    relativePath: string,
    expectKind: "file" | "directory",
    options?: { maxBytes?: number }
  ): Promise<string | undefined> =>
    resolveComponentPath({
      rootReal,
      relativePath,
      expectKind,
      componentLabel: expectKind === "directory" ? `${relativePath}/` : relativePath,
      scope,
      diagnostics,
      ...(options?.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    });

  const skillsDirs = await resolveSkillsRoots({
    declared:
      contributes?.skills ??
      ((claudePackage || cursorFallback) && (await isClaudeRootSkill(rootReal))
        ? ["."]
        : undefined),
    rootReal,
    pluginName: manifest.name,
    resolveComponent,
  });
  // Claude commands load as user-only skills, after every skills root (a skill wins).
  const commandRoots = claudePackage
    ? await resolveCommandRoots({
        declared: claudeComponents?.commands,
        skillsDirs,
        resolveComponent,
        rootReal,
        warn: (message) => {
          log.debug(`Agent plugin ${pluginDir}: ${message}`);
          diagnostics.push({ path: rootReal, scope, severity: "warning", message });
        },
      })
    : [];
  const cursorParts = await resolveCursorParts({
    cursor,
    rawManifest,
    skillsDirs,
    resolveComponent,
    rootReal,
    warn: (message) => {
      log.debug(`Agent plugin ${pluginDir}: ${message}`);
      diagnostics.push({ path: rootReal, scope, severity: "warning", message });
    },
  });
  const allSkillsRoots = [...skillsDirs, ...commandRoots, ...cursorParts.ruleRoots];
  const mcp = await resolvePackageMcpConfig({
    packageKind: { skillsOnly, claudePackage, codexFallback, cursorFallback },
    rootReal,
    declared: contributes?.mcp,
    resolveComponent,
  });
  const { agentsDir: resolvedAgentsDir, ...xumComponents } = await resolveXumComponents({
    allowed: xumComponentGate({ codexFallback, foreign, skillsOnly }),
    contributes,
    resolveComponent,
  });
  const agentsDir = await keepDeclaredAgentsOnly({
    agentsDir: resolvedAgentsDir,
    declaredFiles: claudePackage ? claudeComponents?.agentFiles : undefined,
    warn: (message) => {
      log.debug(`Agent plugin ${pluginDir}: ${message}`);
      diagnostics.push({ path: rootReal, scope, severity: "warning", message });
    },
  });

  return {
    name: manifest.name,
    scope,
    rootPath: rootReal,
    containerPath: args.containerPath,
    dirName: args.dirName,
    manifest,
    ...(codexFallback ? { codexFallback: true } : {}),
    ...(skillsOnly ? { skillsOnly: true } : {}),
    ...(claudePackage ? { claudeFallback: true, claude: claudeComponents ?? {} } : {}),
    ...(cursorFallback ? { cursorFallback: true } : {}),
    ...(cursorParts.hooks !== undefined ? { cursorHooks: cursorParts.hooks } : {}),
    notApplied: [
      ...cursorParts.notApplied,
      ...(await cursorAgentFilesNotApplied(cursor, agentsDir)),
    ],
    ...(openai.extension !== undefined ? { openai: openai.extension, openaiManifestPath } : {}),
    ...(allSkillsRoots.length > 0 ? { skillsDirs: allSkillsRoots } : {}),
    ...mcp,
    ...xumComponents,
    ...(agentsDir !== undefined ? { agentsDir } : {}),
  };
}

/** Ordered plugin containers shared by hooks, MCP, skills, and agents. */
export function computeAgentPluginContainers(args: {
  xumHome: string;
  projectRoot?: string;
  projectTrusted: boolean;
  /** The home of ~/.agents/plugins (phase 5: the caller's HostPaths). Absent: the Node home. */
  userHome?: string;
}): AgentPluginContainer[] {
  const containers: AgentPluginContainer[] = [];
  // projectAutomationDisabled: benchmark harness kill-switch: dataset repos
  // must not contribute plugin containers (hooks.js tool middleware, plugin
  // MCP, slash commands) even when trusted for delegation; global containers
  // below stay active. Mirrors the init/tool_env/project-MCP gating.
  const projectTrusted = args.projectTrusted && !projectAutomationDisabled();
  if (args.projectRoot !== undefined && projectTrusted && path.isAbsolute(args.projectRoot)) {
    containers.push(
      ...listProjectMetadataRelativePaths("plugins").map((relativePath) => ({
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
        path: path.join(args.projectRoot!, relativePath),
        scope: "project" as const,
      })),
      { path: path.join(args.projectRoot, ".agents", "plugins"), scope: "project" }
    );
  }
  containers.push({
    path: path.join(args.xumHome, "plugins"),
    scope: "global",
    registryPath: path.join(args.xumHome, PLUGIN_REGISTRY_FILE_NAME),
  });
  containers.push({
    // mutation-equivalent: userHome is a string or undefined, and an empty home is no path
    path: path.join(args.userHome ?? nodeHostPaths.userHome(), ".agents", "plugins"),
    scope: "global",
  });
  return containers;
}

/**
 * Workspace-level plugin discovery for host-local consumers (contributed slash
 * commands, composition inspector): canonical containers with Project Trust
 * gating, plus the repo-symlink posture check on project plugin roots (a
 * committed .xum/plugins/<name> symlink must not resolve outside the checkout).
 */
export async function discoverWorkspaceAgentPlugins(args: {
  workspacePath: string;
  xumHome: string;
  projectTrusted: boolean;
}): Promise<DiscoverAgentPluginsResult> {
  const containers = computeAgentPluginContainers({
    xumHome: args.xumHome,
    projectRoot: args.workspacePath,
    projectTrusted: args.projectTrusted,
  });
  const { plugins, diagnostics } = await discoverAgentPlugins(containers);

  const contained: AgentPluginInfo[] = [];
  for (const plugin of plugins) {
    if (plugin.scope === "project") {
      try {
        await ensurePathContained(args.workspacePath, plugin.rootPath);
      } catch (error) {
        diagnostics.push({
          path: plugin.rootPath,
          scope: plugin.scope,
          severity: "error",
          message: `Plugin root escapes the project checkout; skipping: ${getErrorMessage(error)}`,
        });
        continue;
      }
    }
    contained.push(plugin);
  }

  return { plugins: contained, diagnostics };
}

/**
 * Discover a single Agent Plugin at an arbitrary root directory.
 *
 * Public wrapper around the per-entry discovery used by container scans, so
 * callers (e.g. the install service validating a staged temp clone) can run
 * the exact same manifest + component validation against a directory that is
 * not (yet) inside a configured container. Returns `plugin: null` when the
 * directory is not a valid plugin; diagnostics carry the reasons.
 */
export async function discoverAgentPluginAt(args: {
  pluginDir: string;
  scope: AgentPluginScope;
  /**
   * The plugin folder's path inside its repository (an install's "Plugin folder"), so a manifest
   * error names the file the way the user sees the repository: `.codex-plugin/plugin.json`, not
   * a bare `plugin.json`. Display only.
   */
  shownRoot?: string;
}): Promise<{ plugin: AgentPluginInfo | null; diagnostics: AgentPluginDiagnostic[] }> {
  if (!path.isAbsolute(args.pluginDir)) {
    throw new Error(`discoverAgentPluginAt: pluginDir must be absolute: ${args.pluginDir}`);
  }

  const diagnostics: AgentPluginDiagnostic[] = [];
  const plugin = await discoverPluginAt({
    pluginDir: args.pluginDir,
    containerPath: path.dirname(args.pluginDir),
    dirName: path.basename(args.pluginDir),
    scope: args.scope,
    diagnostics,
    shownRoot: args.shownRoot,
  });
  return { plugin, diagnostics };
}

/**
 * One gated scan: `suppressed` containers must not be scanned at all, and
 * `confirm()` — called AFTER the scan — returns containers whose scan results
 * must be DISCARDED because a mutation may have overlapped the scan.
 */
export interface AgentPluginDiscoveryGateSession {
  suppressed: readonly string[];
  confirm(): Promise<readonly string[]>;
}

export type AgentPluginDiscoveryGate = (
  containerPaths: readonly string[]
) => Promise<AgentPluginDiscoveryGateSession>;

/**
 * Crash-recovery gate for container scans, so no discovery path (MCP config,
 * hooks, skills, workflows, agents — they all funnel through
 * discoverAgentPlugins) can scan the managed container while install-mutation
 * journal recovery is pending or failed: an agent request arriving right
 * after a crash would otherwise load an orphaned promotion — hook included —
 * before cleanup ran. The gate receives the container paths being scanned,
 * resolves the session up front, and must never reject.
 *
 * The DEFAULT gate derives suppression directly from surviving journal files
 * in each container's sibling staging root: processes that never construct
 * AgentPluginInstallService (headless `mux workflow` resolving plugin://
 * scripts) must not execute an unreconciled managed tree either. They never
 * RUN recovery, so a journal keeps the managed container suppressed until a
 * desktop/server session reconciles it. AgentPluginInstallService replaces
 * this with a gate that ADDS health-tracked suppression at construction:
 * when recovery FAILED (unreadable registry, failed restore/quarantine),
 * merely waiting would release discovery over the unreconciled tree, so the
 * managed container stays omitted until a later recovery attempt succeeds.
 *
 * A single pre-scan journal check is not enough across processes: a desktop
 * install/update in ANOTHER process can write its journal and promote a tree
 * after the check but before (or during) the scan, and can even complete its
 * whole journal lifetime inside that window. The session therefore re-reads
 * each container's mutation state in `confirm()` and discards containers
 * whose journals appeared or whose mutation EPOCH changed (the install
 * service bumps the epoch before every journal deletion, so a fully
 * completed transaction cannot hide).
 */
export async function journalDerivedDiscoveryGate(
  containerPaths: readonly string[]
): Promise<AgentPluginDiscoveryGateSession> {
  const pre = new Map(
    await Promise.all(
      containerPaths.map(
        async (containerPath) =>
          [containerPath, await readContainerMutationState(containerPath)] as const
      )
    )
  );
  return {
    suppressed: containerPaths.filter((containerPath) => {
      const state = pre.get(containerPath);
      return state?.hasJournals === true || isMutationEpochUnreadable(state?.epoch);
    }),
    confirm: async () => {
      const flagged = await Promise.all(
        containerPaths.map(async (containerPath) => {
          const post = await readContainerMutationState(containerPath);
          const preEpoch = pre.get(containerPath)?.epoch;
          const changed =
            post.hasJournals ||
            isMutationEpochUnreadable(preEpoch) ||
            isMutationEpochUnreadable(post.epoch) ||
            post.epoch !== preEpoch;
          return changed ? [containerPath] : [];
        })
      );
      return flagged.flat();
    },
  };
}

let discoveryGate: AgentPluginDiscoveryGate = journalDerivedDiscoveryGate;

const noDiscoveryGate: AgentPluginDiscoveryGate = () =>
  Promise.resolve({ suppressed: [], confirm: () => Promise.resolve([]) });

/** The crash-recovery gate reads host journals; a non-host PluginFs has no managed containers. */
function activeDiscoveryGate(): AgentPluginDiscoveryGate {
  return pluginFs() === nodePluginFs ? discoveryGate : noDiscoveryGate;
}

export function setAgentPluginDiscoveryGate(gate: AgentPluginDiscoveryGate): void {
  discoveryGate = gate;
}

/** Missing containers stay optional; other identity failures must never become unmanaged scans. */
async function resolveAgentPluginContainerPath(containerPath: string): Promise<string | undefined> {
  try {
    return await pluginFs().realpath(containerPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

/** Canonical project plugins shadow same-named legacy copies during ordered scans. */
/**
 * The install-owned fields of one discovered plugin, from its container's registry read. A
 * corrupt registry, or an unidentified row that can own the directory, imports nothing. Managed
 * plugins also get their reviewed fingerprints (#6498): an install without records gets empty
 * ones, so nothing of it loads until reviewed.
 */
function managedPluginFields(
  entryName: string,
  imports: Awaited<ReturnType<typeof readPluginComponentImports>> | undefined,
  registryPath: string | undefined,
  /** The lexical `<container>/<entryName>` of the reading view (logicalPluginView renames it). */
  instancePath: string
): Pick<
  AgentPluginInfo,
  "componentPolicy" | "componentConsent" | "approvedCopies" | "importedComponents"
> {
  // A corrupt registry, or an unidentified row that can own the directory: nothing loads, also
  // nothing the picker does not select (workflows, #6629).
  const nothing = {
    importedComponents: { skills: [], mcpServers: [] },
    componentConsent: noComponentConsent(),
  };
  if (imports === null) return nothing;
  if (imports === undefined) return {};
  if (!imports.byName.has(entryName)) return imports.hasUnidentifiedEntries ? nothing : {};
  return {
    importedComponents: imports.byName.get(entryName),
    ...(registryPath !== undefined
      ? {
          componentPolicy: { registryPath, name: entryName },
          componentConsent: imports.consentByName.get(entryName) ?? noComponentConsent(),
          ...approvedCopiesField(
            registryPath,
            instancePath,
            imports.installedAtByName.get(entryName)
          ),
        }
      : {}),
  };
}

/**
 * One container's view of a physical plugin (read once, then shared by its views). Its approved
 * copies are named by the view's lexical `<container>/<entryName>`, like the MCP server keys and
 * hook trust: the install service names the install by the configured home, which can be a
 * symlink to the registry's realpath, and another alias of the directory gets its own identity
 * (without copies, so a changed component stays blocked there).
 */
function logicalPluginView(
  plugin: AgentPluginInfo,
  container: AgentPluginContainer,
  instancePath: string
): AgentPluginInfo {
  const view = { ...plugin, containerPath: container.path, scope: container.scope };
  if (plugin.approvedCopies !== undefined) {
    view.approvedCopies = { ...plugin.approvedCopies, instancePath };
  }
  return view;
}

/** The copies location of a managed install; none for a row without a readable install time. */
function approvedCopiesField(
  registryPath: string,
  instancePath: string,
  installedAt: string | undefined
): Pick<AgentPluginInfo, "approvedCopies"> {
  return installedAt !== undefined
    ? { approvedCopies: { xumHome: path.dirname(registryPath), instancePath, installedAt } }
    : {};
}

export async function discoverAgentPlugins(
  containers: AgentPluginContainer[],
  options?: {
    /** Ownership and recovery authority only; never scanned or registered as MCP views. */
    managedHome?: string;
  }
): Promise<DiscoverAgentPluginsResult> {
  let plugins: AgentPluginInfo[] = [];
  let diagnostics: AgentPluginDiagnostic[] = [];
  // Consent and recovery belong to the physical container, not its spelling.
  // Keep baseline lexical registrations for precedence and stable identities,
  // but collect ownership and gate paths from every alias before reading plugins.
  const groups = new Map<
    string,
    {
      container: AgentPluginContainer;
      paths: Set<string>;
      registryPath?: string;
      blocked?: boolean;
      hasScanCandidate: boolean;
    }
  >();
  const canonicalPaths = new Map<string, string | undefined>();
  const resolveCachedPath = async (input: string) => {
    if (!canonicalPaths.has(input)) {
      canonicalPaths.set(input, await resolveAgentPluginContainerPath(input));
    }
    return canonicalPaths.get(input);
  };
  const groupFor = (canonicalPath: string, container: AgentPluginContainer) => {
    let group = groups.get(canonicalPath);
    if (group === undefined) {
      // A physical target's parent is not registry/journal authority.
      group = { container, paths: new Set<string>(), hasScanCandidate: false };
      groups.set(canonicalPath, group);
    }
    return group;
  };
  const owners = new Map<
    string,
    {
      container: AgentPluginContainer;
      canonicalPath?: string;
      ownerHome?: string;
    }
  >();
  let unresolvedOwner = false;

  // Establish ownership BEFORE classifying candidates. Otherwise an owner alias
  // retargeting between caller-side realpaths can turn a managed tree into import-all.
  const ownerDescriptors: AgentPluginContainer[] = [...containers];
  if (options?.managedHome !== undefined) {
    ownerDescriptors.unshift({
      path: path.join(options.managedHome, "plugins"),
      scope: "global",
      registryPath: path.join(options.managedHome, PLUGIN_REGISTRY_FILE_NAME),
    });
  }
  for (const descriptor of ownerDescriptors) {
    if (descriptor.registryPath === undefined || owners.has(descriptor.registryPath)) continue;
    if (!path.isAbsolute(descriptor.path) || !path.isAbsolute(descriptor.registryPath)) {
      throw new Error(
        `discoverAgentPlugins: registry owner paths must be absolute: ${descriptor.path}`
      );
    }
    const logicalHome = path.dirname(descriptor.registryPath);
    const owner = { ...descriptor, path: path.join(logicalHome, "plugins") };
    const binding: { container: AgentPluginContainer; canonicalPath?: string; ownerHome?: string } =
      { container: owner };
    owners.set(descriptor.registryPath, binding);
    try {
      binding.canonicalPath = await resolveCachedPath(owner.path);
      binding.ownerHome = await resolveCachedPath(logicalHome);
      if (
        (binding.ownerHome === undefined && binding.canonicalPath !== undefined) ||
        (binding.ownerHome !== undefined &&
          (await resolveCachedPath(path.join(binding.ownerHome, "plugins"))) !==
            binding.canonicalPath)
      ) {
        throw new Error("Managed plugin owner changed during container resolution.");
      }
      if (binding.canonicalPath !== undefined && binding.ownerHome !== undefined) {
        const group = groupFor(binding.canonicalPath, owner);
        group.registryPath = path.join(binding.ownerHome, path.basename(descriptor.registryPath));
        group.paths.add(owner.path);
        group.paths.add(path.join(binding.ownerHome, "plugins"));
      }
    } catch (error) {
      unresolvedOwner = true;
      if (binding.canonicalPath !== undefined)
        groupFor(binding.canonicalPath, owner).blocked = true;
      diagnostics.push({
        path: owner.path,
        scope: owner.scope,
        severity: "error",
        message: getErrorMessage(error),
      });
    }
  }

  for (const container of containers) {
    if (!path.isAbsolute(container.path)) {
      throw new Error(`discoverAgentPlugins: container path must be absolute: ${container.path}`);
    }
    let canonicalPath: string | undefined;
    try {
      canonicalPath = await resolveCachedPath(container.path);
    } catch (error) {
      diagnostics.push({
        path: container.path,
        scope: container.scope,
        severity: "error",
        message: `Plugin container identity could not be resolved: ${getErrorMessage(error)}`,
      });
      continue;
    }
    if (canonicalPath === undefined) continue;
    const group = groupFor(canonicalPath, container);
    if (!group.hasScanCandidate) group.container = container;
    group.hasScanCandidate = true;
    group.paths.add(container.path);
    if (
      container.registryPath !== undefined &&
      owners.get(container.registryPath)?.canonicalPath !== canonicalPath
    ) {
      unresolvedOwner = true;
      group.blocked = true;
      diagnostics.push({
        path: container.path,
        scope: container.scope,
        severity: "error",
        message: "Managed plugin owner changed during container resolution.",
      });
    }
  }

  const revalidateOwners = async () => {
    for (const [registryPath, binding] of owners) {
      try {
        // Bypass the operation cache: newly resolved candidates must not inherit
        // an unmanaged classification from an owner that moved (or disappeared).
        const canonicalPath = await resolveAgentPluginContainerPath(binding.container.path);
        const ownerHome = await resolveAgentPluginContainerPath(path.dirname(registryPath));
        if (
          canonicalPath !== binding.canonicalPath ||
          ownerHome !== binding.ownerHome ||
          (ownerHome !== undefined &&
            (await resolveAgentPluginContainerPath(path.join(ownerHome, "plugins"))) !==
              canonicalPath)
        ) {
          throw new Error("Managed plugin owner changed during discovery.");
        }
      } catch {
        // An established pinned owner still governs its old tree; uncertainty
        // must deny otherwise-unowned targets, not drop the old policy or unrelated owners.
        // Affected scan groups report the ownership failure below.
        unresolvedOwner = true;
      }
      if (binding.canonicalPath !== undefined && binding.ownerHome !== undefined) {
        try {
          if (
            (await resolveAgentPluginContainerPath(binding.ownerHome)) !== binding.ownerHome ||
            (await resolveAgentPluginContainerPath(path.join(binding.ownerHome, "plugins"))) !==
              binding.canonicalPath
          ) {
            throw new Error("Pinned plugin owner no longer identifies the scanned tree.");
          }
        } catch {
          // A missing pinned home would make its registry read look like a legacy
          // import-all directory even when the separately stored plugin tree survives.
          unresolvedOwner = true;
          const group = groups.get(binding.canonicalPath);
          if (group !== undefined) group.blocked = true;
        }
      }
    }
  };
  const gateSession = await activeDiscoveryGate()([
    ...new Set([...groups.values()].flatMap((group) => [...group.paths])),
  ]);
  const suppressedContainers = new Set(gateSession.suppressed);
  await revalidateOwners();
  const unownedSuppressedBeforeScan = unresolvedOwner;

  const snapshots = new Map<
    string,
    {
      entryNames: string[];
      imports: Awaited<ReturnType<typeof readPluginComponentImports>> | undefined;
      plugins: Map<string, AgentPluginInfo | null>;
    }
  >();
  for (const [
    canonicalPath,
    { container, paths, registryPath, blocked, hasScanCandidate },
  ] of groups) {
    if (blocked || !hasScanCandidate) continue;
    if (unresolvedOwner && registryPath === undefined) {
      // If an owner's identity is unknown, no unmarked alias can safely be
      // classified as unmanaged. Other established owners remain isolated.
      diagnostics.push({
        path: container.path,
        scope: container.scope,
        severity: "error",
        message: "Plugin container skipped: managed registry ownership could not be resolved.",
      });
      continue;
    }
    if ([...paths].some((candidate) => suppressedContainers.has(candidate))) {
      diagnostics.push({
        path: container.path,
        scope: container.scope,
        severity: "warning",
        message:
          "Managed plugin container skipped: crash recovery has not completed (see logs); its plugins are unavailable until it succeeds.",
      });
      continue;
    }

    snapshots.set(canonicalPath, {
      entryNames: await listChildDirectories(canonicalPath),
      imports:
        registryPath !== undefined ? await readPluginComponentImports(registryPath) : undefined,
      plugins: new Map(),
    });
  }

  // Every consumer needs logical views: an escaped project view must not hide
  // a valid global fallback. Replay baseline raw deduplication and shadowing,
  // while only the first eligible view reads each physical plugin.
  const seenContainers = new Set<string>();
  const canonicalProjectPluginNames = new Set<string>();
  for (const container of containers) {
    if (seenContainers.has(container.path)) continue;
    seenContainers.add(container.path);
    const canonicalPath = canonicalPaths.get(container.path);
    const snapshot = canonicalPath !== undefined ? snapshots.get(canonicalPath) : undefined;
    if (snapshot === undefined || canonicalPath === undefined) continue;
    const projectMetadataIndex =
      container.scope === "project"
        ? PROJECT_METADATA_DIR_NAMES.findIndex(
            (dirName) => dirName === path.basename(path.dirname(container.path))
          )
        : -1;
    for (const entryName of snapshot.entryNames) {
      if (projectMetadataIndex === 0) canonicalProjectPluginNames.add(entryName);
      else if (projectMetadataIndex === 1 && canonicalProjectPluginNames.has(entryName)) continue;
      const instancePath = path.join(container.path, entryName);
      let plugin = snapshot.plugins.get(entryName);
      if (plugin === undefined) {
        plugin = await discoverPluginAt({
          pluginDir: path.join(canonicalPath, entryName),
          containerPath: container.path,
          dirName: entryName,
          scope: container.scope,
          diagnostics,
        });
        snapshot.plugins.set(entryName, plugin);
        if (plugin) {
          Object.assign(
            plugin,
            managedPluginFields(
              entryName,
              snapshot.imports,
              groups.get(canonicalPath)?.registryPath,
              instancePath
            )
          );
        }
      }
      if (plugin) plugins.push(logicalPluginView(plugin, container, instancePath));
    }
  }

  // Post-scan confirmation: a mutation in ANOTHER process (or a concurrent
  // in-process one) may have started or finished while the scan read the
  // container, so the trees just read can be transient (an orphaned promotion
  // that recovery will quarantine, or a mixed old/new update read). Discard
  // those containers' results rather than hand callers plugin content that
  // may already be rolled back.
  const overlapped = new Set(await gateSession.confirm());
  await revalidateOwners();
  for (const [canonicalPath, { container, paths, registryPath, blocked }] of groups) {
    const lostOwnership =
      blocked === true ||
      (!unownedSuppressedBeforeScan && unresolvedOwner && registryPath === undefined);
    if (
      !snapshots.has(canonicalPath) ||
      (!lostOwnership && ![...paths].some((candidate) => overlapped.has(candidate))) ||
      [...paths].some((candidate) => suppressedContainers.has(candidate))
    ) {
      continue;
    }
    plugins = plugins.filter(
      (plugin) => canonicalPaths.get(plugin.containerPath) !== canonicalPath
    );
    diagnostics = diagnostics.filter(
      (diagnostic) =>
        diagnostic.path !== container.path && !diagnostic.path.startsWith(container.path + path.sep)
    );
    diagnostics.push({
      path: container.path,
      scope: container.scope,
      severity: "warning",
      message: lostOwnership
        ? "Plugin container skipped: managed registry ownership changed during this scan."
        : "Managed plugin container skipped: a plugin install/update/uninstall overlapped this scan; its plugins are unavailable until the next scan.",
    });
    suppressedContainers.add(container.path);
  }

  return { plugins, diagnostics };
}
