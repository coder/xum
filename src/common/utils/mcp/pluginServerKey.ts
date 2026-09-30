/**
 * Whether a FULL override key has the canonical managed-plugin shape
 * `plugin:<16-hex instanceId>:<server>`. MCP server names are otherwise
 * arbitrary user strings (a user-defined server may legitimately be named
 * "plugin:custom"), so plugin-key pruning must match only this shape.
 *
 * Lives in common (crypto-free) because the renderer needs the same positive
 * match to recognize plugin connections in chat; the ID itself is minted in
 * node (see agentPlugins/mcpConfig).
 */
const CANONICAL_PLUGIN_KEY_PATTERN = /^plugin:[0-9a-f]{16}:/;

export function isCanonicalPluginServerKey(key: string): boolean {
  return CANONICAL_PLUGIN_KEY_PATTERN.test(key);
}
