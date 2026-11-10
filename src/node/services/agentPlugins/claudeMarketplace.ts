/**
 * Claude Code marketplace (`.claude-plugin/marketplace.json`) reader. The Cursor marketplace
 * (`.cursor-plugin/marketplace.json`) and the Agent Plugins (Codex) marketplace
 * (`.agents/plugins/marketplace.json`) use the same format with a few differences
 * (MARKETPLACE_FILE_RULES), so this reader parses all three, and a repository with several files
 * lists one merged list (mergeMarketplaces).
 *
 * Source: https://code.claude.com/docs/en/plugin-marketplaces.md and the marketplace reference.
 * Xum lists the entries of a marketplace and installs ONE entry per install. Each entry source
 * becomes a normal git source: a relative path is a folder of the marketplace repository, and
 * `github`, `git-subdir` and `url` name another git repository. `npm`, `archive` and `command`
 * entries are listed but not installable: Xum does not fetch packages or archives, and a
 * `command` source runs a command on this machine.
 *
 * The parse never throws for one bad entry: it is listed with the reason it cannot install. Only
 * a file that is not JSON, or has no `plugins` list, fails the whole preview.
 */

import type { AgentPluginGitSource } from "@/common/config/schemas/agentPluginInstalls";
import {
  AgentPluginMarketplaceBuildSchema,
  type AgentPluginInstallMethod,
  type AgentPluginMarketplaceBuild,
  type AgentPluginMarketplaceEntry,
  type AgentPluginMarketplaceListing,
} from "@/common/orpc/schemas/agentPlugins";
import {
  isValidAgentPluginName,
  isValidMarketplaceEntryName,
} from "@/common/utils/agentPluginName";
import { displayRepoUrl, pointsAtThisMachine } from "@/common/utils/agentPluginSource";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { GITHUB_SHORTHAND_PATTERN } from "@/node/utils/gitUrls";
import { isPlainObject } from "./manifest";
import {
  isFullCommitSha,
  normalizeAgentPluginSubpath,
  parseAgentPluginSourceInput,
} from "./sourceInput";

export const CLAUDE_MARKETPLACE_RELATIVE_PATH = ".claude-plugin/marketplace.json";
export const CURSOR_MARKETPLACE_RELATIVE_PATH = ".cursor-plugin/marketplace.json";
export const AGENTS_MARKETPLACE_RELATIVE_PATH = ".agents/plugins/marketplace.json";

export type MarketplaceFile = AgentPluginMarketplaceBuild["file"];

/**
 * The marketplace files in the order a listing merges them: Cursor first, so the rows of a
 * repository that has only the Cursor and Claude files do not change when another file joins.
 */
export const MARKETPLACE_FILES: readonly MarketplaceFile[] =
  AgentPluginMarketplaceBuildSchema.shape.file.options;

/** The repository-relative path of each marketplace file ("/"-separated, as git names it). */
export const MARKETPLACE_RELATIVE_PATHS: Record<MarketplaceFile, string> = {
  cursor: CURSOR_MARKETPLACE_RELATIVE_PATH,
  claude: CLAUDE_MARKETPLACE_RELATIVE_PATH,
  agents: AGENTS_MARKETPLACE_RELATIVE_PATH,
};

/** One marketplace file's entry: what a preview, install or update reads again at a commit. */
export interface MarketplaceEntryRef {
  file: MarketplaceFile;
  entry: string;
}

/**
 * Marketplaces list many entries, so the cap is far above plugin.json's: anthropics/
 * claude-plugins-community's marketplace.json is about 1.49 MB. The read stays bounded. Each
 * marketplace file has its own cap.
 */
export const MAX_CLAUDE_MARKETPLACE_BYTES = 8 * 1024 * 1024;
/**
 * Entries past this many are not listed (one warning names the count). Per file, so a merged
 * list has at most as many times this many rows as there are marketplace files.
 */
export const MAX_CLAUDE_MARKETPLACE_ENTRIES = 500;

export type MarketplaceSourceKind = AgentPluginMarketplaceBuild["sourceKind"];

/** Source kinds that Xum refuses, with the reason the listing shows. */
const REFUSED_SOURCE_REASONS: Partial<Record<MarketplaceSourceKind, string>> = {
  npm: "Xum does not install npm packages. Only git sources install.",
  archive: "Xum does not download archives. Only git sources install.",
  command: "Xum does not run the command of a 'command' source: it runs on this machine.",
};

export interface ClaudeMarketplaceEntry {
  /** The entry `name`, or "(entry N)" when it has none. */
  name: string;
  description?: string;
  /** The entry object (an empty object when the entry is not one). */
  raw: Record<string, unknown>;
  /** Claude default: true. */
  strict: boolean;
  sourceKind: MarketplaceSourceKind;
  /** The number of entry `skills` paths; undefined when the entry lists none. */
  skillCount?: number;
  /** A shape problem that makes the entry not installable (before source resolution). */
  problem?: string;
}

export interface ClaudeMarketplace {
  /** The file it was parsed from: a path source resolves by that file's rule. */
  file: MarketplaceFile;
  name: string;
  description?: string;
  owner?: string;
  /** `metadata.pluginRoot`: the folder that relative sources start from ("" = the root). */
  pluginRoot: string;
  /** Set when `metadata.pluginRoot` is not a safe relative path: relative entries refuse. */
  pluginRootProblem?: string;
  entries: ClaudeMarketplaceEntry[];
  warnings: string[];
}

/** Where an entry's plugin lives, before its ref is resolved. */
export type ResolvedEntrySource =
  /** A folder of the marketplace repository at the same commit. */
  | { kind: "relative"; subpath: string | undefined }
  /** Another git repository. `ref` is the pinned `sha` when the entry has one. */
  | { kind: "remote"; url: string; ref: string | undefined; subpath: string | undefined };

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * A repository-relative folder from a marketplace path ("./", "./plugins/x", "plugins/x/"):
 * "" for the root. `..`, absolute and home paths are refused before anything is joined, so
 * normalizing can never climb out of the repository.
 */
export function marketplaceRelativePath(raw: string): string {
  const trimmed = raw.trim().replaceAll("\\", "/");
  if (/^(?:[/~]|[a-zA-Z]:)/.test(trimmed)) {
    throw new Error(`'${raw}' is an absolute path. A marketplace path must be relative.`);
  }
  const segments = trimmed.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new Error(`'${raw}' contains '..'. A marketplace path must stay inside the repository.`);
  }
  // The same checks as a typed subpath: no .git, globs or control characters.
  return segments.length === 0 ? "" : normalizeAgentPluginSubpath(segments.join("/"));
}

/** The `source.source` values of a Claude or Cursor source object (installable or refused). */
const OBJECT_SOURCE_KINDS: readonly MarketplaceSourceKind[] = [
  "github",
  "git-subdir",
  "url",
  "npm",
  "archive",
  "command",
];

/**
 * What differs between the marketplace files. One row per file, so a new file cannot be added
 * without deciding each of these (a `Record<MarketplaceFile, ...>`).
 */
interface MarketplaceFileRules {
  /** The preview selector method for one entry of this file (never persisted or installed). */
  selector: Extract<AgentPluginInstallMethod, { entry: string }>["kind"];
  /**
   * The Claude rule: an entry whose folder has no plugin manifest is the manifest, and Xum writes
   * a plugin.json from it. In the other files an entry installs only through its folder's own
   * manifest (Cursor plugin RFC, D23).
   */
  entryIsManifest: boolean;
  /** The entry name must be the plugin name its folder's manifest declares (Codex's rule). */
  entryNamesPlugin: boolean;
  /** An object `{source: "local", path}` names a folder of the marketplace, as a plain path does. */
  localSource: boolean;
  /** The entry-name grammar, and how a refusal describes it. */
  entryName: { valid: (name: string) => boolean; grammar: string };
  /** The other `source.source` values the file defines; any other value is "unknown". */
  objectSources: readonly MarketplaceSourceKind[];
  /** A `url` source may name a folder of its repository with `path`, as `git-subdir` does. */
  urlPath: boolean;
  /** The folder a path source names (undefined: the marketplace root). Throws why it is refused. */
  folderOf: (
    source: string,
    marketplace: Pick<ClaudeMarketplace, "pluginRoot" | "pluginRootProblem">
  ) => string | undefined;
  /** Why this entry cannot install whatever its source is. */
  refusal?: (entry: ClaudeMarketplaceEntry) => string | undefined;
  /** The marketplace title, for a file that has a field for it besides `name`. */
  title?: (raw: Record<string, unknown>) => string | undefined;
}

function rootRelative(folder: string): string | undefined {
  return folder === "" ? undefined : folder;
}

/**
 * The Claude rule: ".", "./" and "./..." start at the marketplace root; only a bare folder name
 * (no "/") starts at metadata.pluginRoot, and any other path needs the "./" prefix.
 */
function claudeFolder(
  source: string,
  marketplace: Pick<ClaudeMarketplace, "pluginRoot" | "pluginRootProblem">
): string | undefined {
  if (marketplace.pluginRootProblem !== undefined) throw new Error(marketplace.pluginRootProblem);
  // Each part is checked on its own before the join, so `..` cannot cancel a pluginRoot folder.
  const folder = marketplaceRelativePath(source);
  const trimmed = source.trim();
  const explicit = trimmed === "." || trimmed.startsWith("./");
  if (!explicit && (folder === "" || folder.includes("/"))) {
    throw new Error(
      `The source '${source}' must start with './'. Only a single folder name resolves under metadata.pluginRoot.`
    );
  }
  const joined = explicit
    ? folder
    : [marketplace.pluginRoot, folder].filter((part) => part !== "").join("/");
  return rootRelative(joined);
}

/**
 * The Cursor rule: a path starts at the marketplace root, with or without "./", and Cursor has no
 * metadata.pluginRoot (cursor/plugins lists `third_party/attio`). The containment checks of
 * marketplaceRelativePath still apply.
 */
function cursorFolder(source: string): string | undefined {
  return rootRelative(marketplaceRelativePath(source));
}

/**
 * The Agent Plugins rule (Codex "Marketplace metadata"): a path is relative to the marketplace
 * root, not to `.agents/plugins/`, and must start with "./"; "." and "./" are the root itself, as
 * in Codex's resolve_local_plugin_source_path. There is no metadata.pluginRoot.
 */
function agentsFolder(source: string): string | undefined {
  const trimmed = source.trim();
  if (trimmed === ".") return undefined;
  if (!trimmed.startsWith("./")) {
    throw new Error(`The path '${source}' must start with './'.`);
  }
  return rootRelative(marketplaceRelativePath(source));
}

/**
 * Codex's installability check (find_installable_marketplace_plugin): NOT_AVAILABLE refuses, and
 * a `policy.products` list allows only the products it names, so an empty list allows none. Xum
 * reads this file as the Codex host does, so it refuses what Codex refuses.
 */
function agentsPolicyRefusal(entry: ClaudeMarketplaceEntry): string | undefined {
  const policy = entry.raw.policy;
  if (!isPlainObject(policy)) return undefined;
  if (policy.installation === "NOT_AVAILABLE") {
    return "The marketplace marks this plugin policy.installation NOT_AVAILABLE, so Xum does not install it.";
  }
  const products = policy.products;
  if (
    Array.isArray(products) &&
    !products.some((product) => typeof product === "string" && product.toLowerCase() === "codex")
  ) {
    return "The marketplace's policy.products does not list Codex, so Xum does not install it.";
  }
  return undefined;
}

function agentsTitle(raw: Record<string, unknown>): string | undefined {
  return isPlainObject(raw.interface) ? optionalString(raw.interface.displayName) : undefined;
}

const MARKETPLACE_ENTRY_NAME: MarketplaceFileRules["entryName"] = {
  valid: isValidMarketplaceEntryName,
  grammar: "letters, digits, '.', '_' and '-'",
};

export const MARKETPLACE_FILE_RULES: Record<MarketplaceFile, MarketplaceFileRules> = {
  cursor: {
    selector: "cursor-marketplace",
    entryIsManifest: false,
    entryNamesPlugin: false,
    localSource: false,
    entryName: MARKETPLACE_ENTRY_NAME,
    objectSources: OBJECT_SOURCE_KINDS,
    urlPath: false,
    folderOf: cursorFolder,
  },
  claude: {
    selector: "claude-marketplace",
    entryIsManifest: true,
    entryNamesPlugin: false,
    localSource: false,
    entryName: MARKETPLACE_ENTRY_NAME,
    objectSources: OBJECT_SOURCE_KINDS,
    urlPath: false,
    folderOf: claudeFolder,
  },
  agents: {
    selector: "agents-marketplace",
    entryIsManifest: false,
    entryNamesPlugin: true,
    localSource: true,
    // Codex checks an entry name with the plugin-name grammar (PluginId::new), not Claude's.
    entryName: {
      valid: isValidAgentPluginName,
      grammar: "lowercase letters, digits, '.' and '-', at most 64 characters",
    },
    // Codex's reader (RawMarketplaceManifestPluginSourceObject) has no github, archive or command.
    objectSources: ["url", "git-subdir", "npm"],
    urlPath: true,
    folderOf: agentsFolder,
    refusal: agentsPolicyRefusal,
    title: agentsTitle,
  },
};

/** The marketplace entry that a preview selector (`{kind, entry}`) names, undefined for another method. */
export function marketplaceEntryRefOf(
  method: AgentPluginInstallMethod | null | undefined
): MarketplaceEntryRef | undefined {
  if (method == null || !("entry" in method)) return undefined;
  const file = MARKETPLACE_FILES.find((candidate) => {
    return MARKETPLACE_FILE_RULES[candidate].selector === method.kind;
  });
  return file === undefined ? undefined : { file, entry: method.entry };
}

/** An object source that names a folder of the marketplace (only where `localSource` is set). */
function isLocalSource(
  rules: MarketplaceFileRules,
  source: unknown
): source is Record<string, unknown> {
  return rules.localSource && isPlainObject(source) && source.source === "local";
}

function sourceKindOf(rules: MarketplaceFileRules, source: unknown): MarketplaceSourceKind {
  if (typeof source === "string" || isLocalSource(rules, source)) return "relative";
  if (!isPlainObject(source)) return "unknown";
  return rules.objectSources.find((kind) => kind === source.source) ?? "unknown";
}

/** Number of `skills` paths an entry lists (a string is one path). */
function entrySkillCount(skills: unknown): number | undefined {
  if (typeof skills === "string") return 1;
  return Array.isArray(skills)
    ? skills.filter((item) => typeof item === "string").length
    : undefined;
}

function readEntry(
  value: unknown,
  index: number,
  seen: Set<string>,
  rules: MarketplaceFileRules
): ClaudeMarketplaceEntry {
  const label = `(entry ${index + 1})`;
  if (!isPlainObject(value)) {
    return {
      name: label,
      raw: {},
      strict: true,
      sourceKind: "unknown",
      problem: "The entry is not an object.",
    };
  }
  const name = optionalString(value.name);
  const description = optionalString(value.description);
  const skillCount = entrySkillCount(value.skills);
  const entry: ClaudeMarketplaceEntry = {
    name: name ?? label,
    ...(description !== undefined ? { description } : {}),
    raw: value,
    strict: value.strict !== false,
    sourceKind: sourceKindOf(rules, value.source),
    ...(skillCount !== undefined ? { skillCount } : {}),
  };
  if (name === undefined) return { ...entry, problem: "The entry has no name." };
  if (!rules.entryName.valid(name)) {
    return {
      ...entry,
      problem: `'${name}' is not a valid plugin name (${rules.entryName.grammar}).`,
    };
  }
  if (seen.has(name)) return { ...entry, problem: `'${name}' is listed more than once.` };
  seen.add(name);
  return entry;
}

function readPluginRoot(
  metadata: unknown
): Pick<ClaudeMarketplace, "pluginRoot" | "pluginRootProblem"> {
  const raw = isPlainObject(metadata) ? metadata.pluginRoot : undefined;
  if (raw === undefined) return { pluginRoot: "" };
  if (typeof raw !== "string") {
    return { pluginRoot: "", pluginRootProblem: "metadata.pluginRoot is not a path." };
  }
  try {
    return { pluginRoot: marketplaceRelativePath(raw) };
  } catch (error) {
    return { pluginRoot: "", pluginRootProblem: `metadata.pluginRoot: ${getErrorMessage(error)}` };
  }
}

/**
 * Parse a marketplace file; the diagnostics name its path. Throws only when the file is not JSON
 * or has no `plugins` list.
 */
export function parseClaudeMarketplace(
  content: string,
  file: MarketplaceFile = "claude"
): ClaudeMarketplace {
  const relativePath = MARKETPLACE_RELATIVE_PATHS[file];
  const rules = MARKETPLACE_FILE_RULES[file];
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${getErrorMessage(error)}`);
  }
  if (!isPlainObject(raw) || !Array.isArray(raw.plugins)) {
    throw new Error(`${relativePath} has no 'plugins' list.`);
  }
  const warnings: string[] = [];
  if (raw.plugins.length > MAX_CLAUDE_MARKETPLACE_ENTRIES) {
    warnings.push(
      `${relativePath} lists ${raw.plugins.length} plugins; Xum shows the first ${MAX_CLAUDE_MARKETPLACE_ENTRIES}.`
    );
  }
  const seen = new Set<string>();
  const entries = raw.plugins
    .slice(0, MAX_CLAUDE_MARKETPLACE_ENTRIES)
    .map((value, index) => readEntry(value, index, seen, rules));
  return {
    file,
    ...readMarketplaceHeader(raw, warnings, relativePath, rules),
    ...readPluginRoot(raw.metadata),
    entries,
    warnings,
  };
}

/**
 * The display fields: the title (the file's own title field, else `name`, which warns when
 * absent), the description and the owner's name.
 */
function readMarketplaceHeader(
  raw: Record<string, unknown>,
  warnings: string[],
  relativePath: string,
  rules: MarketplaceFileRules
): Pick<ClaudeMarketplace, "name" | "description" | "owner"> {
  const name = optionalString(raw.name);
  if (name === undefined) warnings.push(`${relativePath} has no 'name'.`);
  const metadata = isPlainObject(raw.metadata) ? raw.metadata : {};
  const description = optionalString(raw.description) ?? optionalString(metadata.description);
  const owner = isPlainObject(raw.owner) ? optionalString(raw.owner.name) : undefined;
  return {
    name: rules.title?.(raw) ?? name ?? "marketplace",
    ...(description !== undefined ? { description } : {}),
    ...(owner !== undefined ? { owner } : {}),
  };
}

/**
 * The `ref`/`sha` pair of a git source as one ref: a pinned `sha` wins (the install is then
 * pinned to that commit). Throws for a short or malformed sha.
 */
function sourceRef(source: Record<string, unknown>): string | undefined {
  // A null `sha` or `ref` is absent, as Codex's reader treats its optional fields.
  if (source.sha != null) {
    if (typeof source.sha !== "string" || !isFullCommitSha(source.sha)) {
      throw new Error("'sha' must be a full 40-character commit SHA.");
    }
    return source.sha.toLowerCase();
  }
  if (source.ref == null) return undefined;
  const ref = optionalString(source.ref);
  if (ref === undefined) throw new Error("'ref' must be a branch or tag name.");
  return ref;
}

/** Throws when a marketplace at `marketplaceUrl` may not name the git source `url` (`value` as written). */
function assertMarketplaceMayName(value: string, url: string, marketplaceUrl: string): void {
  // SECURITY: a marketplace fetched from the network must not point Xum at a repository on this
  // machine (a private checkout the user never chose), by path or by a loopback host such as
  // `ssh://localhost/...`. A marketplace on this machine may.
  if (pointsAtThisMachine(url) && !pointsAtThisMachine(marketplaceUrl)) {
    throw new Error(
      `'${value}' is a path on this machine; a remote marketplace cannot install it.`
    );
  }
  // SECURITY: an ssh or scp source from a network marketplace makes git sign in with the user's
  // SSH agent to whatever host the catalog names, also a DNS alias of this machine or of a private
  // host. Git resolves the name itself, so Xum cannot check the address first (DNS rebinding).
  // Such a marketplace may name only https sources; a marketplace on this machine may name any.
  if (!pointsAtThisMachine(marketplaceUrl) && !url.startsWith("https://")) {
    throw new Error(
      `'${value}' is not an https URL; a remote marketplace can name only https git sources.`
    );
  }
}

/** A git URL from an entry (`git-subdir` also takes owner/repo), without a ref or folder in it. */
function entryGitUrl(raw: unknown, marketplaceUrl: string): string {
  const value = optionalString(raw);
  if (value === undefined) throw new Error("The source has no 'url'.");
  if (GITHUB_SHORTHAND_PATTERN.test(value)) return `https://github.com/${value}.git`;
  // Refuses embedded credentials and remote-helper syntax, as for a typed source.
  const parsed = parseAgentPluginSourceInput(value);
  if (parsed.ref !== undefined || parsed.subpath !== undefined) {
    throw new Error(
      `'${value}' must be a git URL or owner/repo; put the ref and folder in 'ref' and 'path'.`
    );
  }
  assertMarketplaceMayName(value, parsed.url, marketplaceUrl);
  return parsed.url;
}

/**
 * Where an entry's plugin lives. A path source is a folder of the marketplace repository (the
 * file's `folderOf` rule); the others name a git repository. Throws a user-facing reason when
 * the entry cannot install.
 */
export function resolveEntrySource(
  marketplace: Pick<ClaudeMarketplace, "file" | "pluginRoot" | "pluginRootProblem">,
  marketplaceUrl: string,
  entry: ClaudeMarketplaceEntry
): ResolvedEntrySource {
  const rules = MARKETPLACE_FILE_RULES[marketplace.file];
  assertEntryMayInstall(rules, entry);
  const source = entry.raw.source;
  if (typeof source === "string" || isLocalSource(rules, source)) {
    return { kind: "relative", subpath: rules.folderOf(localSourcePath(source), marketplace) };
  }
  if (!isPlainObject(source)) throw new Error("The entry has no source.");
  if (!rules.objectSources.includes(entry.sourceKind)) {
    throw new Error(`Marketplace source '${String(source.source)}' is not supported.`);
  }
  return remoteEntrySource(source, marketplaceUrl, rules);
}

/** Throws why an entry cannot install whatever its source resolves to. */
function assertEntryMayInstall(rules: MarketplaceFileRules, entry: ClaudeMarketplaceEntry): void {
  if (entry.problem !== undefined) throw new Error(entry.problem);
  const reason = rules.refusal?.(entry) ?? REFUSED_SOURCE_REASONS[entry.sourceKind];
  if (reason !== undefined) throw new Error(reason);
}

/** The path of a plain path source or of a `{source: "local", path}` object. */
function localSourcePath(source: string | Record<string, unknown>): string {
  const folder = typeof source === "string" ? source : source.path;
  if (typeof folder !== "string") throw new Error("A 'local' source needs 'path' as a folder.");
  return folder;
}

/** The clone URL of a `github` source `repo` (owner/repo). */
function githubUrl(raw: unknown): string {
  const repo = optionalString(raw);
  if (repo === undefined || !GITHUB_SHORTHAND_PATTERN.test(repo)) {
    throw new Error("A 'github' source needs 'repo' as owner/repo.");
  }
  return `https://github.com/${repo}.git`;
}

/** A `github`, `git-subdir` or `url` source object as a git repository. */
function remoteEntrySource(
  source: Record<string, unknown>,
  marketplaceUrl: string,
  rules: MarketplaceFileRules
): ResolvedEntrySource {
  switch (source.source) {
    case "github":
      return {
        kind: "remote",
        url: githubUrl(source.repo),
        ref: sourceRef(source),
        subpath: undefined,
      };
    case "git-subdir": {
      const folder = typeof source.path === "string" ? marketplaceRelativePath(source.path) : "";
      if (folder === "") throw new Error("A 'git-subdir' source needs 'path' to a folder.");
      const url = entryGitUrl(source.url, marketplaceUrl);
      return { kind: "remote", url, ref: sourceRef(source), subpath: folder };
    }
    case "url": {
      const url = entryGitUrl(source.url, marketplaceUrl);
      return {
        kind: "remote",
        url,
        ref: sourceRef(source),
        subpath: urlSourceFolder(rules, source),
      };
    }
    default:
      throw new Error(`Marketplace source '${String(source.source)}' is not supported.`);
  }
}

/** The folder a `url` source names with `path` (Codex keeps it); undefined: the repository root. */
function urlSourceFolder(
  rules: MarketplaceFileRules,
  source: Record<string, unknown>
): string | undefined {
  // Codex reads a null `path` as absent.
  if (!rules.urlPath || source.path == null) return undefined;
  const folder = typeof source.path === "string" ? marketplaceRelativePath(source.path) : "";
  if (folder === "") throw new Error("A 'url' source 'path' must name a folder.");
  return folder;
}

/** Display text of an entry source in the listing. */
function sourceLabel(
  entry: ClaudeMarketplaceEntry,
  resolved: ResolvedEntrySource | undefined
): string {
  if (resolved?.kind === "relative") return resolved.subpath ?? "./";
  if (resolved?.kind === "remote") {
    const folder = resolved.subpath !== undefined ? `/${resolved.subpath}` : "";
    return `${displayRepoUrl(resolved.url)}${folder}`;
  }
  return entry.sourceKind;
}

function describeMarketplaceBuild(
  marketplace: ClaudeMarketplace,
  marketplaceUrl: string,
  file: MarketplaceFile,
  entry: ClaudeMarketplaceEntry
): AgentPluginMarketplaceBuild {
  let resolved: ResolvedEntrySource | undefined;
  let reason: string | undefined;
  try {
    resolved = resolveEntrySource(marketplace, marketplaceUrl, entry);
  } catch (error) {
    reason = getErrorMessage(error);
  }
  // A listing exists only when the repository root has no plugin manifest of its own (a root
  // with one previews as that plugin instead). So an entry that names the root installs only
  // where the entry itself is the manifest (Claude); elsewhere its preview would always fail.
  if (
    resolved?.kind === "relative" &&
    resolved.subpath === undefined &&
    !MARKETPLACE_FILE_RULES[file].entryIsManifest
  ) {
    reason =
      "The entry names the repository root, which has no plugin manifest, so Xum cannot install it.";
  }
  return {
    file,
    sourceKind: entry.sourceKind,
    source: sourceLabel(entry, resolved),
    ...(entry.skillCount !== undefined ? { skillCount: entry.skillCount } : {}),
    installable: reason === undefined,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** One row of the merged list: a name and the entry of each file that lists it, in MARKETPLACE_FILES order. */
export interface MergedMarketplaceEntry {
  name: string;
  builds: Array<{ file: MarketplaceFile; entry: ClaudeMarketplaceEntry }>;
}

/**
 * One list from the marketplace files, taken in MARKETPLACE_FILES order: each file's entries in
 * file order, a row per name. An entry joins the row that an earlier file made for its name only
 * when neither entry has a problem, so an "(entry N)" label or a name listed twice never merges.
 */
export function mergeMarketplaces(
  files: Record<MarketplaceFile, ClaudeMarketplace | null>
): MergedMarketplaceEntry[] {
  const rows: MergedMarketplaceEntry[] = [];
  // A file lists a name without a problem at most once (readEntry), so each key is one row.
  const mergeable = new Map<string, MergedMarketplaceEntry>();
  for (const file of MARKETPLACE_FILES) {
    for (const entry of files[file]?.entries ?? []) {
      const row = entry.problem === undefined ? mergeable.get(entry.name) : undefined;
      if (row !== undefined) {
        assert(
          row.builds.every((build) => build.file !== file),
          "mergeMarketplaces: a row takes one build per file"
        );
        row.builds.push({ file, entry });
        continue;
      }
      const added: MergedMarketplaceEntry = { name: entry.name, builds: [{ file, entry }] };
      rows.push(added);
      if (entry.problem === undefined) mergeable.set(entry.name, added);
    }
  }
  return rows;
}

export interface ParsedMarketplaces {
  /** Null when the file is missing, or failed to parse beside a file that parsed. */
  files: Record<MarketplaceFile, ClaudeMarketplace | null>;
  /** The parse error of a file that failed beside a file that parsed. */
  warnings: string[];
}

/**
 * Parse the marketplace files of a root (undefined: the commit has no such file; an Error: the
 * file could not be read; at least one exists). One file alone fails the listing when it does
 * not parse, as before Cursor files existed. With several, a broken file becomes a warning and
 * the other files still list; only when every file is broken does the listing fail.
 */
export function parseMarketplaces(
  contents: Record<MarketplaceFile, string | Error | undefined>
): ParsedMarketplaces {
  const files: ParsedMarketplaces["files"] = { cursor: null, claude: null, agents: null };
  const errors: string[] = [];
  let present = 0;
  for (const file of MARKETPLACE_FILES) {
    const content = contents[file];
    if (content === undefined) continue;
    present++;
    try {
      if (content instanceof Error) throw content;
      files[file] = parseClaudeMarketplace(content, file);
    } catch (error) {
      errors.push(getErrorMessage(error));
    }
  }
  assert(present > 0, "parseMarketplaces: at least one marketplace file exists");
  // Each message names its file, so two failures read as one error that names both.
  if (errors.length === present) throw new Error(errors.join(" "));
  return { files, warnings: errors };
}

/** The entry named `name`. Throws when the marketplace does not list it. */
export function findMarketplaceEntry(
  marketplace: ClaudeMarketplace,
  name: string
): ClaudeMarketplaceEntry {
  const entry = marketplace.entries.find(
    (candidate) => candidate.name === name && candidate.problem === undefined
  );
  if (entry === undefined) {
    throw new Error(
      `The marketplace '${marketplace.name}' does not list a plugin named '${name}'.`
    );
  }
  return entry;
}

/**
 * Component keys of an entry: with a plugin.json there, they add to it or conflict (strict).
 * These are Claude's six; entry `mcpServers` and `lspServers` simply do not apply then.
 */
const ENTRY_COMPONENT_KEYS = [
  "skills",
  "commands",
  "agents",
  "hooks",
  "outputStyles",
  "themes",
] as const;

export function entryDeclaresComponents(entry: ClaudeMarketplaceEntry): boolean {
  return ENTRY_COMPONENT_KEYS.some((key) => entry.raw[key] !== undefined);
}

/** Entry fields that are plugin.json fields Xum maps (normalizeClaudeManifest). */
const ENTRY_MANIFEST_KEYS = [
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "skills",
  "commands",
  "agents",
  "mcpServers",
] as const;

/** Claude component fields of an entry that Xum ignores (each one named in a warning). */
const IGNORED_ENTRY_KEYS = [
  "hooks",
  "lspServers",
  "outputStyles",
  "themes",
  "monitors",
  "userConfig",
  "settings",
  "channels",
  "dependencies",
] as const;

/**
 * The Claude rule for an entry without a plugin.json: the entry is the manifest. Only the
 * plugin.json fields are kept (source, strict, category, tags and the other listing fields are
 * not plugin fields). Entry `hooks` are dropped: Claude reads only the inline form there, and Xum
 * never runs Claude hooks anyway (the plugin's hooks/hooks.json is still listed).
 */
export function entryAsManifest(entry: ClaudeMarketplaceEntry): {
  raw: Record<string, unknown>;
  warnings: string[];
} {
  const raw: Record<string, unknown> = {};
  for (const key of ENTRY_MANIFEST_KEYS) {
    if (entry.raw[key] !== undefined) raw[key] = entry.raw[key];
  }
  // The listing already checked the (trimmed) name against the marketplace grammar; the
  // caller derives the plugin name from it (marketplaceManifest).
  raw.name = entry.name;
  const warnings = IGNORED_ENTRY_KEYS.filter((key) => entry.raw[key] !== undefined).map(
    (key) => `Xum ignores '${key}' of the marketplace entry '${entry.name}'`
  );
  return { raw, warnings };
}

/**
 * The marketplace listing of a repository root (the preview result for a marketplace): one row
 * per merged entry. The header is the first file that parsed, in MARKETPLACE_FILES order.
 */
export function marketplaceListing(args: {
  marketplaces: ParsedMarketplaces;
  source: AgentPluginGitSource;
  lockedSha: string;
  /** The other methods that fit the root (Skills for a repository of SKILL.md files). */
  methods: AgentPluginInstallMethod[];
}): AgentPluginMarketplaceListing {
  const parsed = MARKETPLACE_FILES.flatMap((file) => args.marketplaces.files[file] ?? []);
  const header = parsed[0];
  assert(header !== undefined, "marketplaceListing: at least one marketplace file parsed");
  const entries = mergeMarketplaces(args.marketplaces.files).map(
    (row): AgentPluginMarketplaceEntry => {
      // Agent Plugins entries have no description, so a row takes the first build that has one.
      const description = row.builds.find((build) => build.entry.description !== undefined)?.entry
        .description;
      return {
        name: row.name,
        ...(description !== undefined ? { description } : {}),
        builds: row.builds.map(({ file, entry }) => {
          const marketplace = args.marketplaces.files[file];
          assert(marketplace !== null, "marketplaceListing: a build's file parsed");
          return describeMarketplaceBuild(marketplace, args.source.url, file, entry);
        }),
      };
    }
  );
  return {
    name: header.name,
    ...(header.description !== undefined ? { description: header.description } : {}),
    ...(header.owner !== undefined ? { owner: header.owner } : {}),
    source: args.source,
    lockedSha: args.lockedSha,
    entries,
    methods: args.methods,
    warnings: [
      ...parsed.flatMap((marketplace) => marketplace.warnings),
      ...args.marketplaces.warnings,
    ],
  };
}
