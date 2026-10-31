/**
 * Claude Code marketplace (`.claude-plugin/marketplace.json`) reader. The Cursor marketplace
 * (`.cursor-plugin/marketplace.json`) uses the same format, so this reader parses both, and a
 * repository with both files lists one merged list (mergeMarketplaces).
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
import * as path from "node:path";

import type { AgentPluginGitSource } from "@/common/config/schemas/agentPluginInstalls";
import {
  AgentPluginMarketplaceBuildSchema,
  type AgentPluginInstallMethod,
  type AgentPluginMarketplaceBuild,
  type AgentPluginMarketplaceEntry,
  type AgentPluginMarketplaceListing,
} from "@/common/orpc/schemas/agentPlugins";
import { isValidMarketplaceEntryName } from "@/common/utils/agentPluginName";
import { displayRepoUrl } from "@/common/utils/agentPluginSource";
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

export type MarketplaceFile = AgentPluginMarketplaceBuild["file"];

/** The repository-relative path of each marketplace file ("/"-separated, as git names it). */
export const MARKETPLACE_RELATIVE_PATHS: Record<MarketplaceFile, string> = {
  cursor: CURSOR_MARKETPLACE_RELATIVE_PATH,
  claude: CLAUDE_MARKETPLACE_RELATIVE_PATH,
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
 * list has at most twice as many rows.
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

/** The `source.source` values of a source object that Xum knows (installable or refused). */
const OBJECT_SOURCE_KINDS: readonly MarketplaceSourceKind[] = [
  "github",
  "git-subdir",
  "url",
  "npm",
  "archive",
  "command",
];

function sourceKindOf(source: unknown): MarketplaceSourceKind {
  if (typeof source === "string") return "relative";
  if (!isPlainObject(source)) return "unknown";
  return OBJECT_SOURCE_KINDS.find((kind) => kind === source.source) ?? "unknown";
}

/** Number of `skills` paths an entry lists (a string is one path). */
function entrySkillCount(skills: unknown): number | undefined {
  if (typeof skills === "string") return 1;
  return Array.isArray(skills)
    ? skills.filter((item) => typeof item === "string").length
    : undefined;
}

function readEntry(value: unknown, index: number, seen: Set<string>): ClaudeMarketplaceEntry {
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
    sourceKind: sourceKindOf(value.source),
    ...(skillCount !== undefined ? { skillCount } : {}),
  };
  if (name === undefined) return { ...entry, problem: "The entry has no name." };
  if (!isValidMarketplaceEntryName(name)) {
    return {
      ...entry,
      problem: `'${name}' is not a valid plugin name (letters, digits, '.', '_' and '-').`,
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
 * Parse a marketplace file; `relativePath` names it in the diagnostics. Throws only when the file
 * is not JSON or has no `plugins` list.
 */
export function parseClaudeMarketplace(
  content: string,
  relativePath = CLAUDE_MARKETPLACE_RELATIVE_PATH
): ClaudeMarketplace {
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
    .map((value, index) => readEntry(value, index, seen));
  return {
    ...readMarketplaceHeader(raw, warnings, relativePath),
    ...readPluginRoot(raw.metadata),
    entries,
    warnings,
  };
}

/** The display fields: `name` (warns when absent), the description and the owner's name. */
function readMarketplaceHeader(
  raw: Record<string, unknown>,
  warnings: string[],
  relativePath: string
): Pick<ClaudeMarketplace, "name" | "description" | "owner"> {
  const name = optionalString(raw.name);
  if (name === undefined) warnings.push(`${relativePath} has no 'name'.`);
  const metadata = isPlainObject(raw.metadata) ? raw.metadata : {};
  const description = optionalString(raw.description) ?? optionalString(metadata.description);
  const owner = isPlainObject(raw.owner) ? optionalString(raw.owner.name) : undefined;
  return {
    name: name ?? "marketplace",
    ...(description !== undefined ? { description } : {}),
    ...(owner !== undefined ? { owner } : {}),
  };
}

function isLocalGitUrl(url: string): boolean {
  return (
    url.startsWith("file://") ||
    url.startsWith("~") ||
    path.isAbsolute(url) ||
    /^[a-zA-Z]:[\\/]/.test(url)
  );
}

/** The host of a scheme URL (`ssh://`, `https://`, …) or of an SCP form (`user@host:path`). */
function gitUrlHost(url: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }
  return /^(?:[^@/]+@)?(\[[^\]]+\]|[^:/]+):/.exec(url)?.[1];
}

// 127.0.0.0/8, and its IPv4-mapped IPv6 form after WHATWG normalization (::ffff:7f00:1).
const LOOPBACK_ADDRESS_PATTERN = /^(?:127\.|::ffff:7f)/;
// 0.0.0.0 and :: reach this machine on Linux and macOS.
const LOOPBACK_ADDRESSES = new Set(["0.0.0.0", "::1", "::", "::ffff:0:0"]);

/** localhost, 127.0.0.0/8, 0.0.0.0 and the IPv6 loopback, in any spelling git accepts. */
function isLoopbackHost(rawHost: string): boolean {
  const host = rawHost
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  let normalized: string;
  try {
    // WHATWG parsing normalizes IPv4 spellings (127.1, 2130706433, 0x7f000001) and IPv6.
    normalized = new URL(`http://${host.includes(":") ? `[${host}]` : host}/`).hostname;
  } catch {
    return false;
  }
  normalized = normalized.replace(/^\[|\]$/g, "");
  return LOOPBACK_ADDRESS_PATTERN.test(normalized) || LOOPBACK_ADDRESSES.has(normalized);
}

/**
 * True for a repository on this machine: a path, a file:// URL, or a URL whose host is this
 * machine (git would reach it with the user's own SSH keys). Fails closed: a remote-looking URL
 * whose host Xum cannot read counts as this machine.
 */
function pointsAtThisMachine(url: string): boolean {
  if (isLocalGitUrl(url)) return true;
  const host = gitUrlHost(url);
  return host === undefined || isLoopbackHost(host);
}

/**
 * The `ref`/`sha` pair of a git source as one ref: a pinned `sha` wins (the install is then
 * pinned to that commit). Throws for a short or malformed sha.
 */
function sourceRef(source: Record<string, unknown>): string | undefined {
  if (source.sha !== undefined) {
    if (typeof source.sha !== "string" || !isFullCommitSha(source.sha)) {
      throw new Error("'sha' must be a full 40-character commit SHA.");
    }
    return source.sha.toLowerCase();
  }
  if (source.ref === undefined) return undefined;
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

function relativeEntrySource(
  marketplace: Pick<ClaudeMarketplace, "pluginRoot" | "pluginRootProblem">,
  source: string
): ResolvedEntrySource {
  if (marketplace.pluginRootProblem !== undefined) throw new Error(marketplace.pluginRootProblem);
  // Each part is checked on its own before the join, so `..` cannot cancel a pluginRoot folder.
  const folder = marketplaceRelativePath(source);
  // The Claude rule: "." and "./..." start at the marketplace root; only a bare folder name (no
  // "/") starts at metadata.pluginRoot, and any other path needs the "./" prefix.
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
  return { kind: "relative", subpath: joined === "" ? undefined : joined };
}

/**
 * Where an entry's plugin lives. A relative source joins `metadata.pluginRoot`; the others name a
 * git repository. Throws a user-facing reason when the entry cannot install.
 */
export function resolveEntrySource(
  marketplace: Pick<ClaudeMarketplace, "pluginRoot" | "pluginRootProblem">,
  marketplaceUrl: string,
  entry: ClaudeMarketplaceEntry
): ResolvedEntrySource {
  if (entry.problem !== undefined) throw new Error(entry.problem);
  const refused = REFUSED_SOURCE_REASONS[entry.sourceKind];
  if (refused !== undefined) throw new Error(refused);
  const source = entry.raw.source;
  if (typeof source === "string") return relativeEntrySource(marketplace, source);
  if (!isPlainObject(source)) throw new Error("The entry has no source.");
  return remoteEntrySource(source, marketplaceUrl);
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
  marketplaceUrl: string
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
      return { kind: "remote", url, ref: sourceRef(source), subpath: undefined };
    }
    default:
      throw new Error(`Marketplace source '${String(source.source)}' is not supported.`);
  }
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

/** One file's build of a listing row, with the reason when it cannot install. */
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
  return {
    file,
    sourceKind: entry.sourceKind,
    source: sourceLabel(entry, resolved),
    ...(entry.skillCount !== undefined ? { skillCount: entry.skillCount } : {}),
    installable: reason === undefined,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** One row of the merged list: a name and the entry of each file that lists it, Cursor first. */
export interface MergedMarketplaceEntry {
  name: string;
  builds: Array<{ file: MarketplaceFile; entry: ClaudeMarketplaceEntry }>;
}

/**
 * One list from both marketplace files: the Cursor entries in file order, then each Claude entry
 * whose name the Cursor rows lack. A Claude entry joins the Cursor row of its name only when
 * neither entry has a problem, so an "(entry N)" label or a name listed twice never merges.
 */
export function mergeMarketplaces(
  cursor: ClaudeMarketplace | null,
  claude: ClaudeMarketplace | null
): MergedMarketplaceEntry[] {
  const rows: MergedMarketplaceEntry[] = (cursor?.entries ?? []).map((entry) => ({
    name: entry.name,
    builds: [{ file: "cursor", entry }],
  }));
  // A file lists a name without a problem at most once (readEntry), so each key is one row.
  const mergeable = new Map(
    rows.flatMap((row) => (row.builds[0].entry.problem === undefined ? [[row.name, row]] : []))
  );
  for (const entry of claude?.entries ?? []) {
    const row = entry.problem === undefined ? mergeable.get(entry.name) : undefined;
    if (row === undefined) {
      rows.push({ name: entry.name, builds: [{ file: "claude", entry }] });
      continue;
    }
    assert(row.builds.length === 1, "mergeMarketplaces: a Cursor row takes one Claude build");
    row.builds.push({ file: "claude", entry });
  }
  return rows;
}

/** The marketplace files of a repository root, as parsed for its listing. */
export interface ParsedMarketplaces {
  /** Null when the file is missing, or failed to parse beside a file that parsed. */
  files: Record<MarketplaceFile, ClaudeMarketplace | null>;
  /** The parse error of a file that failed beside a file that parsed. */
  warnings: string[];
}

/**
 * Parse the marketplace files of a root (undefined: the commit has no such file; at least one
 * exists). One file alone fails the listing when it does not parse, as before Cursor files
 * existed. With both, a broken file becomes a warning and the other file still lists; only two
 * broken files fail.
 */
export function parseMarketplaces(
  contents: Record<MarketplaceFile, string | undefined>
): ParsedMarketplaces {
  const files: ParsedMarketplaces["files"] = { cursor: null, claude: null };
  const errors: string[] = [];
  let present = 0;
  for (const file of AgentPluginMarketplaceBuildSchema.shape.file.options) {
    const content = contents[file];
    if (content === undefined) continue;
    present++;
    try {
      files[file] = parseClaudeMarketplace(content, MARKETPLACE_RELATIVE_PATHS[file]);
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
 * per merged entry. The header is the Cursor file's when it parsed, else the Claude file's.
 */
export function marketplaceListing(args: {
  marketplaces: ParsedMarketplaces;
  source: AgentPluginGitSource;
  lockedSha: string;
  /** The other methods that fit the root (Skills for a repository of SKILL.md files). */
  methods: AgentPluginInstallMethod[];
}): AgentPluginMarketplaceListing {
  const { cursor, claude } = args.marketplaces.files;
  const header = cursor ?? claude;
  assert(header !== null, "marketplaceListing: at least one marketplace file parsed");
  const entries = mergeMarketplaces(cursor, claude).map((row): AgentPluginMarketplaceEntry => {
    const description = row.builds[0].entry.description;
    return {
      name: row.name,
      ...(description !== undefined ? { description } : {}),
      builds: row.builds.map(({ file, entry }) => {
        const marketplace = args.marketplaces.files[file];
        assert(marketplace !== null, "marketplaceListing: a build's file parsed");
        return describeMarketplaceBuild(marketplace, args.source.url, file, entry);
      }),
    };
  });
  return {
    name: header.name,
    ...(header.description !== undefined ? { description: header.description } : {}),
    ...(header.owner !== undefined ? { owner: header.owner } : {}),
    source: args.source,
    lockedSha: args.lockedSha,
    entries,
    methods: args.methods,
    warnings: [
      ...(cursor?.warnings ?? []),
      ...(claude?.warnings ?? []),
      ...args.marketplaces.warnings,
    ],
  };
}
