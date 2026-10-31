/**
 * Cursor plugin manifest (`.cursor-plugin/plugin.json`) normalizer (Cursor plugin RFC section 1).
 *
 * Source: https://cursor.com/docs/reference/plugins.md. Discovery reads this manifest only when
 * no root `plugin.json` with `$schema`, no Codex and no Claude manifest exists (D21), and
 * rewrites it into the Agent Plugins 1.0.0 shape before the regular validator runs, as
 * normalizeClaudeManifest does for Claude. A manifest path replaces folder discovery for its
 * component. Xum applies folder paths only (D24): a glob, a file path or a path outside the plugin
 * folder is listed in `notApplied`, and the component then loads nothing. Fields Xum has no part
 * for are listed too, so the install review shows every part Xum does not apply (Goal 7).
 *
 * SECURITY AUDIT: a Cursor package was not written for Xum, so it gets no Xum-only behavior. Only
 * the mapped keys below survive: repository-provided `contributes` (slash commands, hooks.js and
 * workflows paths) and `extensions` (hook tool grants, com.openai) are dropped with a warning.
 * Discovery also skips the implicit hooks.js and workflows/ for these packages (cursorFallback).
 */
import {
  INERT_COMPONENT_PATH,
  MAX_SKILLS_ROOTS,
  AGENT_PLUGIN_SCHEMA_ID_1_0_0,
  isPlainObject,
} from "./manifest";
import { claudeComponentPath, claudePluginName, readAuthor } from "./claudeManifest";
import { CURSOR_RULE_EXTENSIONS } from "./cursorRules";
import type { AgentPluginNotApplied } from "./discovery";

const CURSOR_MANIFEST_LABEL = ".cursor-plugin/plugin.json";

export interface CursorManifestResult {
  /** The Agent Plugins manifest that validatePluginManifest reads. */
  manifest: unknown;
  warnings: string[];
  /** Rule folders in declared order. Default `["rules"]`; empty when `rules` names no folder. */
  ruleDirs: string[];
  /** A hooks file path or an inline hooks object. Default `hooks/hooks.json`. */
  hooks?: string | Record<string, unknown>;
  notApplied: AgentPluginNotApplied[];
}

/** Metadata keys that map one to one onto the Agent Plugins manifest. */
const CURSOR_METADATA_KEYS = [
  "name",
  "version",
  "description",
  "homepage",
  "repository",
  "license",
  "keywords",
] as const;

/** Display fields that the Agent Plugins manifest has no member for. Xum drops them silently. */
const SILENT_CURSOR_KEYS = new Set(["displayName", "logo"]);

/** Fields that Xum lists as not applied: no Xum part reads them. */
const NOT_APPLIED_CURSOR_KEYS = [
  "variables",
  "category",
  "tags",
  "publisher",
  "clientVersionRequirement",
  "minClientVersions",
] as const;

const HANDLED_CURSOR_KEYS = new Set<string>([
  ...CURSOR_METADATA_KEYS,
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

/** Why a component path is not applied, or undefined for a folder path inside the plugin. */
function folderPathRefusal(entry: string): string | undefined {
  const normalized = claudeComponentPath(entry);
  if (normalized === undefined) return "path is outside the plugin folder";
  const isFile = CURSOR_RULE_EXTENSIONS.some((extension) => normalized.endsWith(extension));
  return GLOB_CHARACTERS.test(normalized) || isFile
    ? "only folder paths are applied in Xum"
    : undefined;
}

/**
 * The folder paths of `skills`, `rules` or `agents`, in declared order and without repeats, at
 * most MAX_SKILLS_ROOTS of them. Undefined when the field is absent, or when the value is not a
 * path or a list of paths: such a field is dropped with a warning, and the default folder applies.
 */
function readFolderPaths(
  field: string,
  value: unknown,
  warnings: string[],
  notApplied: AgentPluginNotApplied[]
): string[] | undefined {
  if (value === undefined) return undefined;
  const entries = Array.isArray(value) ? value : [value];
  if (!entries.every((entry): entry is string => typeof entry === "string")) {
    warnings.push(`'${field}' must be a path or a list of paths; ignoring it`);
    return undefined;
  }
  if (entries.length > MAX_SKILLS_ROOTS) {
    warnings.push(
      `'${field}' lists more than ${MAX_SKILLS_ROOTS} paths; reading only the first ${MAX_SKILLS_ROOTS}`
    );
  }
  return appliedFolders(field, entries.slice(0, MAX_SKILLS_ROOTS), notApplied);
}

/** The folder paths among `entries`, normalized and without repeats; the rest are listed. */
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
 * A declared folder list as a `contributes` member. A field that names no folder replaces the
 * default folder with nothing, so the inert path keeps the default from loading in its place.
 */
function declaredFolders(folders: string[]): string[] {
  return folders.length > 0 ? folders : [INERT_COMPONENT_PATH];
}

/** `contributes.agents`: Cursor reads every agents path, Xum one agents folder. */
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

/**
 * Cursor `mcpServers`: a path to an MCP file (the `contributes.mcp` member), or an inline config,
 * which Xum does not apply. A declared form that Xum does not apply replaces the default file, so
 * the inert path keeps it from loading.
 */
function mcpFile(
  value: unknown,
  warnings: string[],
  notApplied: AgentPluginNotApplied[]
): { mcp?: string } {
  if (value === undefined) return {};
  if (typeof value === "string") {
    const normalized = claudeComponentPath(value);
    if (normalized !== undefined) return { mcp: normalized };
    notApplied.push({
      part: "mcp",
      name: `mcpServers: ${value}`,
      reason: "path is outside the plugin folder",
    });
    return { mcp: INERT_COMPONENT_PATH };
  }
  if (isPlainObject(value) || Array.isArray(value)) {
    notApplied.push({
      part: "mcp",
      name: "mcpServers",
      reason: "inline mcpServers is not applied in Xum; use a ./mcp.json file",
    });
    return { mcp: INERT_COMPONENT_PATH };
  }
  warnings.push("'mcpServers' must be a path, an object or a list; ignoring it");
  return {};
}

/** Until Cursor hooks run (Cursor plugin RFC PR 8), every Cursor hook is listed with this reason. */
export const CURSOR_HOOKS_REASON = "Cursor hooks run in a later Xum build";

/**
 * Cursor `hooks`: a hooks file path or an inline object. Default `hooks/hooks.json`. Inline hooks
 * are listed here; discovery lists a hooks file that exists.
 */
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
  if (value !== undefined) warnings.push("'hooks' must be a path or an object; ignoring it");
  return { hooks: "hooks/hooks.json" };
}

/** The metadata half of the manifest (with a synthesized `$schema`), warning on unknown keys. */
function readMetadata(raw: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  const manifest: Record<string, unknown> = { $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0 };
  for (const key of CURSOR_METADATA_KEYS) {
    if (raw[key] !== undefined) manifest[key] = raw[key];
  }
  if (raw.author !== undefined) manifest.author = readAuthor(raw.author, warnings);
  if (typeof raw.name === "string") manifest.name = claudePluginName(raw.name, warnings);
  for (const key of Object.keys(raw)) {
    if (HANDLED_CURSOR_KEYS.has(key)) continue;
    warnings.push(`'${key}' is not supported in ${CURSOR_MANIFEST_LABEL}; ignoring`);
  }
  return manifest;
}

/** The fields Xum lists as not applied. `commands` is a component, so its part is `command`. */
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
 * and `agents` become `contributes` members (the inert path when the field names no folder, so
 * the default folder does not load in its place), `mcpServers` becomes `contributes.mcp`, and
 * rules and hooks, which have no `contributes` member, come back beside the manifest.
 */
export function normalizeCursorManifest(raw: unknown): CursorManifestResult {
  const warnings: string[] = [];
  if (!isPlainObject(raw)) return { manifest: raw, warnings, ruleDirs: [], notApplied: [] };
  const notApplied = notAppliedFields(raw);
  const manifest = readMetadata(raw, warnings);
  const read = (field: string) => readFolderPaths(field, raw[field], warnings, notApplied);
  const skills = read("skills");
  const rules = read("rules");
  manifest.contributes = {
    ...(skills !== undefined ? { skills: declaredFolders(skills) } : {}),
    ...agentsFolder(read("agents"), notApplied),
    ...mcpFile(raw.mcpServers, warnings, notApplied),
  };
  return {
    manifest,
    warnings,
    ruleDirs: rules ?? ["rules"],
    ...readHooks(raw.hooks, warnings, notApplied),
    notApplied,
  };
}
