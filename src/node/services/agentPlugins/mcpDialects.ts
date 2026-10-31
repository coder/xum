/**
 * The folder names each plugin MCP dialect expands, and the Cursor dialect's rules for what Xum
 * does not apply (Cursor plugin RFC section 4). Pure, so discovery and the MCP loader share one
 * decision: discovery lists it in `notApplied`, and the loader skips or warns.
 */
import type { AgentPluginInfo, AgentPluginNotApplied } from "./discovery";
import type { PluginPlaceholderValues } from "./expansion";
import { isPlainObject } from "./manifest";

export type McpDialect = NonNullable<AgentPluginInfo["mcpConfigDialect"]>;
type XumFolderName = "PLUGIN_ROOT" | "PLUGIN_DATA";
export type FolderAliases = Partial<
  Record<Exclude<keyof PluginPlaceholderValues, XumFolderName>, XumFolderName>
>;

/**
 * The other names a dialect gives the plugin folder and its data folder. Cursor documents only its
 * two roots, so a Cursor data name stays a user value (D29).
 */
const DIALECT_FOLDER_ALIASES: Record<McpDialect, FolderAliases> = {
  codex: {},
  claude: { CLAUDE_PLUGIN_ROOT: "PLUGIN_ROOT", CLAUDE_PLUGIN_DATA: "PLUGIN_DATA" },
  cursor: { CURSOR_PLUGIN_ROOT: "PLUGIN_ROOT", CLAUDE_PLUGIN_ROOT: "PLUGIN_ROOT" },
};

export function folderAliases(dialect: McpDialect | undefined): FolderAliases {
  return dialect === undefined ? {} : DIALECT_FOLDER_ALIASES[dialect];
}

/** `./<path>` for a command of exactly `${<root alias>}/<path>`; undefined for any other form. */
function rootRelativeCommand(command: string, aliases: FolderAliases): string | undefined {
  for (const [alias, folder] of Object.entries(aliases)) {
    const prefix = `\${${alias}}/`;
    if (folder === "PLUGIN_ROOT" && command.startsWith(prefix) && command.length > prefix.length)
      return `./${command.slice(prefix.length)}`;
  }
  return undefined;
}

/** A cwd anchored at an alias, anchored at the matching Xum name instead. */
function xumAnchoredCwd(cwd: string, aliases: FolderAliases): string {
  for (const [alias, folder] of Object.entries(aliases)) {
    const token = `\${${alias}}`;
    if (cwd.startsWith(token) && (cwd.length === token.length || cwd[token.length] === "/"))
      return `\${${folder}}${cwd.slice(token.length)}`;
  }
  return cwd;
}

/**
 * A stdio entry with its dialect's folder names in Xum's spelling:
 * - A command of exactly `${<root alias>}/<path>` becomes `./<path>`, so it goes through the same
 *   `./` checks (containment, a file, executable). Every other form, including a quoted or
 *   absolute one, stays unchanged and classifyCommandToken refuses it.
 * - A cwd anchored at an alias is anchored at the matching Xum name, so the cwd form and
 *   containment checks apply unchanged.
 * Args and env values expand the aliases through the placeholder values instead.
 */
export function xumStdioEntry(
  entry: Record<string, unknown>,
  aliases: FolderAliases
): Record<string, unknown> {
  const { command, cwd } = entry;
  const rewritten = { ...entry };
  const relative = typeof command === "string" ? rootRelativeCommand(command, aliases) : undefined;
  if (relative !== undefined) rewritten.command = relative;
  if (typeof cwd === "string") rewritten.cwd = xumAnchoredCwd(cwd, aliases);
  return rewritten;
}

// A `${NAME}` or `${NAME:-default}`: how a Cursor `mcp.json` asks for a user value.
const PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

/**
 * The first placeholder in `values` that Xum leaves as written, by name only: a default can be a
 * secret. Only an exact `${NAME}` of an `expanded` name expands (expandPluginPlaceholders).
 */
function unexpandedPlaceholder(
  values: readonly unknown[],
  expanded: ReadonlySet<string>
): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const [whole, name] of value.matchAll(PLACEHOLDER_PATTERN)) {
      if (whole !== `\${${name}}` || !expanded.has(name)) return `\${${name}}`;
    }
  }
  return undefined;
}

/** The names that expand in a Cursor server's args, env values and cwd. */
const CURSOR_EXPANDED_NAMES: ReadonlySet<string> = new Set([
  "PLUGIN_ROOT",
  "PLUGIN_DATA",
  ...Object.keys(DIALECT_FOLDER_ALIASES.cursor),
]);
const NOTHING_EXPANDS: ReadonlySet<string> = new Set();

const objectValues = (value: unknown): unknown[] =>
  isPlainObject(value) ? Object.values(value) : [];

/**
 * The first `${NAME}` that a Cursor server entry asks the user for. Xum has no Cursor `variables`,
 * so the server cannot load. Command, url and headers never expand. A cwd anchored at a name that
 * does not expand, such as `${CURSOR_PLUGIN_DATA}`, is left to the cwd form check (D29).
 */
export function cursorValuePlaceholder(rawEntry: Record<string, unknown>): string | undefined {
  const { command, args, env, cwd, url, headers } = xumStdioEntry(
    rawEntry,
    DIALECT_FOLDER_ALIASES.cursor
  );
  const anchor = typeof cwd === "string" ? /^\$\{(\w+)\}/.exec(cwd)?.[1] : undefined;
  const checkedCwd = anchor === undefined || CURSOR_EXPANDED_NAMES.has(anchor) ? [cwd] : [];
  return (
    unexpandedPlaceholder([command], NOTHING_EXPANDS) ??
    unexpandedPlaceholder(
      [...(Array.isArray(args) ? args : []), ...objectValues(env), ...checkedCwd],
      CURSOR_EXPANDED_NAMES
    ) ??
    unexpandedPlaceholder([url, ...objectValues(headers)], NOTHING_EXPANDS)
  );
}

export function needsValuesReason(placeholder: string): string {
  return `needs values not supported in Xum (${placeholder})`;
}

/** D19: Cursor's `auth` block is not translated; sign-in uses discovery and DCR (T8). */
export const CURSOR_AUTH_REASON = "auth not applied in Xum";

/**
 * What a Cursor `mcp.json` asks for that Xum does not apply: each server that needs values, and
 * each other server's `auth` block. A document or entry that cannot load at all gets the loader's
 * error diagnostic instead.
 */
export function cursorMcpNotApplied(raw: unknown): AgentPluginNotApplied[] {
  if (!isPlainObject(raw)) return [];
  // The Codex shape: a flat server map is also valid; its `$schema` string is no server.
  const servers = "mcpServers" in raw ? raw.mcpServers : raw;
  if (!isPlainObject(servers)) return [];
  return Object.entries(servers).flatMap(([name, entry]): AgentPluginNotApplied[] => {
    if (name === "__proto__" || !isPlainObject(entry)) return [];
    const placeholder = cursorValuePlaceholder(entry);
    if (placeholder !== undefined)
      return [{ part: "mcp", name, reason: needsValuesReason(placeholder) }];
    return entry.auth !== undefined ? [{ part: "mcp", name, reason: CURSOR_AUTH_REASON }] : [];
  });
}
