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

function rootRelativeCommand(command: string, aliases: FolderAliases): string | undefined {
  for (const [alias, folder] of Object.entries(aliases)) {
    const prefix = `\${${alias}}/`;
    if (folder === "PLUGIN_ROOT" && command.startsWith(prefix) && command.length > prefix.length)
      return `./${command.slice(prefix.length)}`;
  }
  return undefined;
}

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

/**
 * Each `${...}` in `value` as `[whole, name]`. Cursor interpolates `${NAME}`, `${NAME:-default}`,
 * `${env:NAME}` (names such as `api-key` included), `${userHome}` and `${/}`. The name stops before
 * a `:` other than `env:`, so the reported text never includes a default. A scan, not a regex: a
 * plugin's `mcp.json` is read before consent, and an unterminated `${` must stay linear-time.
 */
function* placeholders(value: string): Generator<[whole: string, name: string]> {
  let from = 0;
  for (;;) {
    const start = value.indexOf("${", from);
    const end = start === -1 ? -1 : value.indexOf("}", start + 2);
    if (end === -1) return;
    const body = value.slice(start + 2, end);
    const prefix = body.startsWith("env:") ? "env:" : "";
    yield [value.slice(start, end + 1), prefix + body.slice(prefix.length).split(":")[0]];
    from = end + 1;
  }
}

/**
 * The first placeholder in `values` that Xum leaves as written, by name only: a default can be a
 * secret. Only an exact `${NAME}` of an `expanded` name expands (expandPluginPlaceholders), and
 * Xum never reads `${env:NAME}` from its own environment.
 */
function unexpandedPlaceholder(
  values: readonly unknown[],
  expanded: ReadonlySet<string>
): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const [whole, name] of placeholders(value)) {
      if (whole !== `\${${name}}` || !expanded.has(name)) return `\${${name}}`;
    }
  }
  return undefined;
}

const CURSOR_EXPANDED_NAMES: ReadonlySet<string> = new Set([
  "PLUGIN_ROOT",
  "PLUGIN_DATA",
  ...Object.keys(DIALECT_FOLDER_ALIASES.cursor),
]);
const NOTHING_EXPANDS: ReadonlySet<string> = new Set();

const objectValues = (value: unknown): unknown[] =>
  isPlainObject(value) ? Object.values(value) : [];
const arrayValues = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * The first `${NAME}` that a Cursor server entry asks the user for. Xum has no Cursor `variables`,
 * so the server cannot load. Command, url and headers never expand.
 */
export function cursorValuePlaceholder(rawEntry: Record<string, unknown>): string | undefined {
  const { command, args, env, cwd, url, headers } = xumStdioEntry(
    rawEntry,
    DIALECT_FOLDER_ALIASES.cursor
  );
  return (
    unexpandedPlaceholder([command], NOTHING_EXPANDS) ??
    unexpandedPlaceholder(
      [...arrayValues(args), ...objectValues(env), cwd],
      CURSOR_EXPANDED_NAMES
    ) ??
    unexpandedPlaceholder([url, ...objectValues(headers)], NOTHING_EXPANDS)
  );
}

export function needsValuesReason(placeholder: string): string {
  return `needs values not supported in Xum (${placeholder})`;
}

/**
 * Cursor server fields that Xum drops so the server still connects. `auth` is not translated
 * (D19, T8): sign-in uses discovery and dynamic client registration. `placement: "server"` asks
 * Cursor to connect from its hosted service, which Xum does not have, so Xum connects directly.
 */
export const CURSOR_IGNORED_FIELDS = ["auth", "placement"] as const;

export function ignoredFieldReason(field: (typeof CURSOR_IGNORED_FIELDS)[number]): string {
  return `${field} not applied in Xum`;
}

/**
 * What a Cursor `mcp.json` asks for that Xum does not apply: each server that needs values, and
 * each ignored field of every other server. A server or file that the loader refuses for another
 * reason also gets the loader's error diagnostic.
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
    return CURSOR_IGNORED_FIELDS.filter((field) => entry[field] !== undefined).map((field) => ({
      part: "mcp",
      name,
      reason: ignoredFieldReason(field),
    }));
  });
}
