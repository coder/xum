/**
 * Agent Plugins 1.0.0 placeholder expansion (§9.2).
 *
 * Expansion is a single, non-recursive textual replacement of every exact
 * occurrence of `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`. Replacement text is never
 * rescanned for further placeholders, unrecognized `${...}` text stays
 * literal, and no other placeholder or environment-variable expansion is
 * performed. A Claude Code `.mcp.json` also names the two values
 * `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}`; they expand only when the
 * caller supplies them.
 */

export interface PluginPlaceholderValues {
  PLUGIN_ROOT: string;
  PLUGIN_DATA: string;
  CLAUDE_PLUGIN_ROOT?: string;
  CLAUDE_PLUGIN_DATA?: string;
}

// String.replace with a global regex visits each match of the ORIGINAL string
// exactly once, so replacement output is never rescanned (single-pass §9.2).
const PLUGIN_PLACEHOLDER_PATTERN = /\$\{((?:CLAUDE_)?PLUGIN_(?:ROOT|DATA))\}/g;

/** Expand `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` (and supplied aliases) in a config string (single-pass). */
export function expandPluginPlaceholders(value: string, vars: PluginPlaceholderValues): string {
  return value.replace(
    PLUGIN_PLACEHOLDER_PATTERN,
    (match, name: keyof PluginPlaceholderValues) => vars[name] ?? match
  );
}
