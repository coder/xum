/**
 * Agent Plugins 1.0.0 placeholder expansion (§9.2).
 *
 * Expansion is a single, non-recursive textual replacement of every exact
 * occurrence of `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`. Replacement text is never
 * rescanned for further placeholders, unrecognized `${...}` text stays
 * literal, and no other placeholder or environment-variable expansion is
 * performed.
 */

export interface PluginPlaceholderValues {
  PLUGIN_ROOT: string;
  PLUGIN_DATA: string;
}

// String.replace with a global regex visits each match of the ORIGINAL string
// exactly once, so replacement output is never rescanned (single-pass §9.2).
const PLUGIN_PLACEHOLDER_PATTERN = /\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g;

/** Expand `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` in a config string (single-pass). */
export function expandPluginPlaceholders(value: string, vars: PluginPlaceholderValues): string {
  return value.replace(PLUGIN_PLACEHOLDER_PATTERN, (_match, name: string) =>
    name === "PLUGIN_ROOT" ? vars.PLUGIN_ROOT : vars.PLUGIN_DATA
  );
}
