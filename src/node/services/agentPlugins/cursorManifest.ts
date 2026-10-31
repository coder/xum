/**
 * Source: https://cursor.com/docs/reference/plugins.md.
 *
 * SECURITY AUDIT: a Cursor package was not written for Xum, so it gets no Xum-only behavior. Only
 * the mapped keys below survive: repository-provided `contributes` (slash commands, hooks.js and
 * workflows paths) and `extensions` (hook tool grants, com.openai) are dropped with a warning.
 * Discovery also skips the implicit hooks.js and workflows/ for these packages (cursorFallback).
 */
import { INERT_COMPONENT_PATH, MAX_SKILLS_ROOTS, isPlainObject } from "./manifest";
import { CLAUDE_METADATA_KEYS, claudeComponentPath, readForeignMetadata } from "./claudeManifest";
import { CURSOR_RULE_EXTENSIONS } from "./cursorRules";
import type { AgentPluginNotApplied } from "./discovery";

const CURSOR_MANIFEST_LABEL = ".cursor-plugin/plugin.json";

export interface CursorManifestResult {
  manifest: unknown;
  warnings: string[];
  /** Rule folders in declared order. Default `["rules"]`; empty when `rules` names no folder. */
  ruleDirs: string[];
  /** Default `hooks/hooks.json`. */
  hooks?: string | Record<string, unknown>;
  /**
   * The `mcpServers` file path; the inert path when the field names no file Xum applies. Kept out
   * of `contributes.mcp` until Cursor MCP servers load (Cursor plugin RFC PR 3): the sign-out
   * pass reads a declared `contributes.mcp` that resolves to no file as an unreadable MCP file.
   */
  mcpConfigPath?: string;
  notApplied: AgentPluginNotApplied[];
}

const SILENT_CURSOR_KEYS = new Set(["displayName", "logo"]);

const NOT_APPLIED_CURSOR_KEYS = [
  "variables",
  "category",
  "tags",
  "publisher",
  "clientVersionRequirement",
  "minClientVersions",
] as const;

const HANDLED_CURSOR_KEYS = new Set<string>([
  ...CLAUDE_METADATA_KEYS,
  ...SILENT_CURSOR_KEYS,
  ...NOT_APPLIED_CURSOR_KEYS,
  "author",
  "skills",
  "rules",
  "agents",
  "commands",
  "hooks",
  "mcpServers",
]);

const GLOB_CHARACTERS = /[*?[]/;

/**
 * A known field of the wrong type is dropped, so its default applies. It is listed as well as
 * warned about: a warning shows only in the preview, and the plugin detail must still show it.
 */
function invalidField(
  field: string,
  type: string,
  warnings: string[],
  notApplied: AgentPluginNotApplied[]
): void {
  warnings.push(`'${field}' must be ${type}; ignoring it`);
  notApplied.push({ part: "field", name: field, reason: `must be ${type}` });
}

function folderPathRefusal(entry: string): string | undefined {
  const normalized = claudeComponentPath(entry);
  if (normalized === undefined) return "path is outside the plugin folder";
  const isFile = CURSOR_RULE_EXTENSIONS.some((extension) => normalized.endsWith(extension));
  return GLOB_CHARACTERS.test(normalized) || isFile
    ? "only folder paths are applied in Xum"
    : undefined;
}

function readFolderPaths(
  field: string,
  value: unknown,
  warnings: string[],
  notApplied: AgentPluginNotApplied[]
): string[] | undefined {
  if (value === undefined) return undefined;
  const entries = Array.isArray(value) ? value : [value];
  if (!entries.every((entry): entry is string => typeof entry === "string")) {
    invalidField(field, "a path or a list of paths", warnings, notApplied);
    return undefined;
  }
  if (entries.length > MAX_SKILLS_ROOTS) {
    warnings.push(
      `'${field}' lists more than ${MAX_SKILLS_ROOTS} paths; reading only the first ${MAX_SKILLS_ROOTS}`
    );
  }
  return appliedFolders(field, entries.slice(0, MAX_SKILLS_ROOTS), notApplied);
}

function appliedFolders(
  field: string,
  entries: string[],
  notApplied: AgentPluginNotApplied[]
): string[] {
  const folders: string[] = [];
  for (const entry of entries) {
    const reason = folderPathRefusal(entry);
    if (reason !== undefined) {
      notApplied.push({ part: "field", name: `${field}: ${entry}`, reason });
      continue;
    }
    const normalized = claudeComponentPath(entry);
    if (normalized !== undefined && !folders.includes(normalized)) folders.push(normalized);
  }
  return folders;
}

/**
 * A field that names no folder replaces the default folder with nothing, so the inert path keeps
 * the default from loading in its place.
 */
function declaredFolders(folders: string[]): string[] {
  return folders.length > 0 ? folders : [INERT_COMPONENT_PATH];
}

function agentsFolder(
  folders: string[] | undefined,
  notApplied: AgentPluginNotApplied[]
): { agents?: string } {
  if (folders === undefined) return {};
  const [first, ...later] = declaredFolders(folders);
  for (const folder of later) {
    notApplied.push({
      part: "field",
      name: `agents: ${folder}`,
      reason: "only one agents folder is applied in Xum",
    });
  }
  return { agents: first };
}

function mcpFile(
  value: unknown,
  warnings: string[],
  notApplied: AgentPluginNotApplied[]
): Pick<CursorManifestResult, "mcpConfigPath"> {
  if (value === undefined) return {};
  if (typeof value === "string") {
    const normalized = claudeComponentPath(value);
    if (normalized !== undefined) return { mcpConfigPath: normalized };
    notApplied.push({
      part: "mcp",
      name: `mcpServers: ${value}`,
      reason: "path is outside the plugin folder",
    });
    return { mcpConfigPath: INERT_COMPONENT_PATH };
  }
  if (isPlainObject(value) || Array.isArray(value)) {
    notApplied.push({
      part: "mcp",
      name: "mcpServers",
      reason: "inline mcpServers is not applied in Xum; use a ./mcp.json file",
    });
    return { mcpConfigPath: INERT_COMPONENT_PATH };
  }
  invalidField("mcpServers", "a path, an object or a list", warnings, notApplied);
  return {};
}

/** Until Cursor hooks run (Cursor plugin RFC PR 8), every Cursor hook is listed with this reason. */
export const CURSOR_HOOKS_REASON = "Cursor hooks run in a later Xum build";

/** Inline hooks are listed here; discovery lists a hooks file that exists. */
function readHooks(
  value: unknown,
  warnings: string[],
  notApplied: AgentPluginNotApplied[]
): Pick<CursorManifestResult, "hooks"> {
  if (typeof value === "string") {
    const normalized = claudeComponentPath(value);
    if (normalized !== undefined) return { hooks: normalized };
    notApplied.push({
      part: "field",
      name: `hooks: ${value}`,
      reason: "path is outside the plugin folder",
    });
    return {};
  }
  if (isPlainObject(value)) {
    notApplied.push({ part: "hook", name: "hooks", reason: CURSOR_HOOKS_REASON });
    return { hooks: value };
  }
  if (value !== undefined) invalidField("hooks", "a path or an object", warnings, notApplied);
  return { hooks: "hooks/hooks.json" };
}

function notAppliedFields(raw: Record<string, unknown>): AgentPluginNotApplied[] {
  const entries: AgentPluginNotApplied[] = [];
  if (raw.commands !== undefined) {
    entries.push({ part: "command", name: "commands", reason: "not applied in Xum" });
  }
  for (const key of NOT_APPLIED_CURSOR_KEYS) {
    if (raw[key] !== undefined)
      entries.push({ part: "field", name: key, reason: "not applied in Xum" });
  }
  return entries;
}

/**
 * Rewrite a `.cursor-plugin/plugin.json` document into the Agent Plugins 1.0.0 shape. `skills`
 * and `agents` become `contributes` members. Rules, hooks and the MCP file come back beside the
 * manifest.
 */
export function normalizeCursorManifest(raw: unknown): CursorManifestResult {
  const warnings: string[] = [];
  if (!isPlainObject(raw)) return { manifest: raw, warnings, ruleDirs: [], notApplied: [] };
  const notApplied = notAppliedFields(raw);
  const manifest = readForeignMetadata(raw, warnings, {
    label: CURSOR_MANIFEST_LABEL,
    isKnown: (key) => HANDLED_CURSOR_KEYS.has(key),
  });
  const read = (field: string) => readFolderPaths(field, raw[field], warnings, notApplied);
  const skills = read("skills");
  const rules = read("rules");
  manifest.contributes = {
    ...(skills !== undefined ? { skills: declaredFolders(skills) } : {}),
    ...agentsFolder(read("agents"), notApplied),
  };
  return {
    manifest,
    warnings,
    ruleDirs: rules ?? ["rules"],
    ...mcpFile(raw.mcpServers, warnings, notApplied),
    ...readHooks(raw.hooks, warnings, notApplied),
    notApplied,
  };
}
