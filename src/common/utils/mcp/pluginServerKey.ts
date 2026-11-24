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

const CANONICAL_PLUGIN_KEY_PARTS = /^plugin:([0-9a-f]{16}):([\s\S]+)$/;

/**
 * What a user sees for a server key. A canonical plugin key's instance ID is an internal
 * routing token, so it shows only the server part (`plugin:<hex>:tray` is `tray`); any other
 * key shows as it is. Display only: binding, dispatch and storage keep the raw key, and callers
 * offer the raw key (a Tooltip) where the short form is ambiguous.
 */
export function mcpServerDisplayName(key: string): string {
  return CANONICAL_PLUGIN_KEY_PARTS.exec(key)?.[2] ?? key;
}

/**
 * The server named where the user grants something (the consent strip). Two plugins can
 * declare the same server name, so a plugin key keeps a short instance marker:
 * `tray (plugin 0123abcd)`, the first 8 hex digits of its instance ID.
 */
export function mcpServerConsentName(key: string): string {
  const parts = CANONICAL_PLUGIN_KEY_PARTS.exec(key);
  return parts === null ? key : `${parts[2]} (plugin ${parts[1].slice(0, 8)})`;
}
