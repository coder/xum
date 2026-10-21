/**
 * Claude Code plugin manifest (`.claude-plugin/plugin.json`) normalizer.
 *
 * Source: https://code.claude.com/docs/en/plugins-reference.md. Discovery reads this manifest
 * only when neither `plugin.json` nor `.codex-plugin/plugin.json` exists, and rewrites it into
 * the Agent Plugins 1.0.0 shape before the regular validator runs. Every unsupported or invalid
 * field is dropped with a warning (never fatal), matching manifest.ts.
 *
 * Paths are checked lexically here (relative, no `..`, no absolute/home prefix). Discovery
 * resolves each one through its realpath containment before it opens anything.
 */
import * as path from "node:path";

import {
  AGENT_PLUGIN_SCHEMA_ID_1_0_0,
  MAX_SKILLS_ROOTS,
  isPlainObject,
  isSafeContributesPath,
} from "./manifest";
import { MAX_HOOK_POINTER_ENTRIES } from "./openaiExtension";

/** Claude components that have no `contributes` member. Discovery resolves them itself. */
export interface ClaudePluginComponents {
  /** `commands` paths (`.md` files or folders of them), in declared order. Absent: `commands/`. */
  commands?: string[];
  /** `hooks` file paths, read after the default `hooks/hooks.json` (Claude merges them). */
  hooks?: string[];
}

export interface NormalizedClaudeManifest {
  manifest: unknown;
  warnings: string[];
  claude: ClaudePluginComponents;
}

/** Metadata keys that map one to one onto the Agent Plugins manifest. */
const CLAUDE_METADATA_KEYS = [
  "name",
  "version",
  "description",
  "homepage",
  "repository",
  "license",
  "keywords",
] as const;
const AUTHOR_KEYS = ["name", "email", "url"] as const;

/**
 * Keys that Claude Code itself does not read at load time (schema URL, catalog data and the
 * directory listing fields). Xum drops them without a warning.
 */
const SILENT_CLAUDE_KEYS = new Set([
  "$schema",
  "metadata",
  "icon",
  "documentationUrl",
  "supportUrl",
  "privacyPolicyUrl",
  "termsOfServiceUrl",
]);

/**
 * A Claude component path ("./x/", "x", "." for the plugin root) as a contributes path, or
 * undefined when it is not a safe relative path. The safety check runs before normalization,
 * so normalizing can never remove a `..` segment.
 */
export function claudeComponentPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return isSafeContributesPath(trimmed) ? path.posix.normalize(trimmed) : undefined;
}

/** A path or a list of paths, as a list (a non-list is one entry). */
function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * The safe paths of a path-or-list key, at most `cap` of them. Inline objects and unsafe paths
 * are dropped with one warning each kind, so a long list cannot flood the preview.
 */
function readPathList(key: string, value: unknown, cap: number, warnings: string[]): string[] {
  const paths: string[] = [];
  let inline = 0;
  let invalid = 0;
  const entries = asList(value);
  for (const entry of entries.slice(0, cap)) {
    if (isPlainObject(entry)) {
      inline++;
      continue;
    }
    const normalized = claudeComponentPath(entry);
    if (normalized === undefined) invalid++;
    else if (!paths.includes(normalized)) paths.push(normalized);
  }
  if (inline > 0)
    warnings.push(`Inline '${key}' in .claude-plugin/plugin.json is not supported; ignoring`);
  if (invalid > 0) {
    warnings.push(
      `'${key}' must name relative paths inside the plugin; ignoring invalid entries (${invalid})`
    );
  }
  if (entries.length > cap)
    warnings.push(`'${key}' lists more than ${cap} entries; reading only the first ${cap}`);
  return paths;
}

/**
 * Claude `agents` is a list of `.md` files. Xum reads one agents folder, so the list maps only
 * when every file sits in one folder below the plugin root. Otherwise Xum warns and reads the
 * default `agents/`. The plugin root itself is refused: it would load every Markdown file there.
 */
function agentsFolder(value: unknown, warnings: string[]): { agents?: string } {
  if (value === undefined) return {};
  const folders = new Set<string>();
  for (const entry of asList(value)) {
    const normalized = claudeComponentPath(entry);
    if (normalized === undefined || !normalized.endsWith(".md")) {
      folders.clear();
      break;
    }
    folders.add(path.posix.dirname(normalized));
  }
  const [folder] = folders;
  if (folders.size === 1 && folder !== undefined && folder !== ".") return { agents: folder };
  warnings.push(
    "'agents' must list .md files in one folder below the plugin root; reading the default agents/ instead"
  );
  return {};
}

/**
 * Claude `mcpServers`: Xum reads one MCP file. A `.json` path replaces the default `.mcp.json`
 * (Claude merges the two). Inline servers, lists and `.mcpb`/`.dxt` bundles are not supported.
 */
function mcpFile(value: unknown, warnings: string[]): { mcp?: string } {
  if (value === undefined) return {};
  const normalized = typeof value === "string" ? claudeComponentPath(value) : undefined;
  if (normalized === undefined || !normalized.endsWith(".json")) {
    warnings.push(
      "'mcpServers' must be one .json file path inside the plugin; ignoring it (reading .mcp.json)"
    );
    return {};
  }
  if (normalized !== ".mcp.json") {
    warnings.push(`Xum reads only '${normalized}' for MCP servers, not .mcp.json as well`);
  }
  return { mcp: normalized };
}

/** `author` keeps its name, email and url. Other keys warn instead of failing validation. */
function readAuthor(value: unknown, warnings: string[]): unknown {
  if (!isPlainObject(value)) return value;
  const author: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if ((AUTHOR_KEYS as readonly string[]).includes(key)) author[key] = member;
    else warnings.push(`'author.${key}' is not supported; ignoring`);
  }
  return author;
}

/**
 * Rewrite a `.claude-plugin/plugin.json` document into the Agent Plugins 1.0.0 shape. Used ONLY
 * for that fallback file: the root `plugin.json` parse stays strict.
 *
 * Mapping: metadata keys keep their names. `skills` adds to the default `skills/` (Codex
 * replaces it). `agents` maps to one folder (agentsFolder). `mcpServers` maps to one MCP file
 * (mcpFile). `commands` and `hooks` paths are returned in `claude` for discovery. Every other key
 * (lspServers, outputStyles, userConfig, settings, channels, dependencies, workflows, ...) is
 * dropped with a warning.
 *
 * SECURITY AUDIT: a Claude Code package was not written for Xum and is often unmanaged (a repo,
 * `~/.agents/plugins`), so it gets no Xum-only behavior: repository-provided `contributes`
 * (slash commands, hooks.js and workflows paths) and `extensions` (including `extensions.mux`
 * hook tool grants) are dropped here. Discovery also skips the implicit hooks.js and workflows/
 * for these packages, and the hooks loader lists Claude hooks without running any of them.
 */
export function normalizeClaudeManifest(raw: unknown): NormalizedClaudeManifest {
  const warnings: string[] = [];
  if (!isPlainObject(raw)) return { manifest: raw, warnings, claude: {} };

  const manifest: Record<string, unknown> = { $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0 };
  for (const key of CLAUDE_METADATA_KEYS) {
    if (raw[key] !== undefined) manifest[key] = raw[key];
  }
  if (raw.author !== undefined) manifest.author = readAuthor(raw.author, warnings);

  const handled = new Set<string>([
    ...CLAUDE_METADATA_KEYS,
    "author",
    "skills",
    "agents",
    "mcpServers",
    "commands",
    "hooks",
  ]);
  for (const key of Object.keys(raw)) {
    if (handled.has(key) || SILENT_CLAUDE_KEYS.has(key)) continue;
    warnings.push(`'${key}' is not supported in .claude-plugin/plugin.json; ignoring`);
  }

  // Claude `skills` adds to the default skills/ scan, so the default is listed first.
  const skills =
    raw.skills === undefined
      ? []
      : readPathList("skills", raw.skills, MAX_SKILLS_ROOTS - 1, warnings);
  manifest.contributes = {
    ...(skills.length > 0 ? { skills: ["skills", ...skills.filter((s) => s !== "skills")] } : {}),
    ...agentsFolder(raw.agents, warnings),
    ...mcpFile(raw.mcpServers, warnings),
  };

  const claude: ClaudePluginComponents = {};
  if (raw.commands !== undefined) {
    if (isPlainObject(raw.commands)) {
      warnings.push("An object map in 'commands' is not supported; ignoring it");
      claude.commands = [];
    } else {
      claude.commands = readPathList("commands", raw.commands, MAX_SKILLS_ROOTS, warnings);
    }
  }
  if (raw.hooks !== undefined) {
    claude.hooks = readPathList("hooks", raw.hooks, MAX_HOOK_POINTER_ENTRIES, warnings);
  }
  return { manifest, warnings, claude };
}
