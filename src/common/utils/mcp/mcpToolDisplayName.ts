import type { MCPConnectionRef } from "@/common/types/mcp";
import { normalizeMcpToolNamePart } from "@/common/utils/tools/mcpPromptCommandKey";
import { isCanonicalPluginServerKey } from "./pluginServerKey";

/**
 * Human-facing label for an MCP tool call whose host-captured connection is
 * known. The model-facing name is `${normalize(serverKey)}_${tool}`; for an
 * Agent Plugin server that key is `plugin:<16 hex instance id>:<server>`, so
 * chat would show `plugin_656443adaa7377b9_coder_coder_create_chat`. The
 * instance ID belongs to routing, enablement and history (it keeps a plugin
 * stable across updates and sibling installs), not to a readable label: the
 * server badge already names the server, so the header shows the remainder.
 *
 * Shortening happens only on a positive match: a canonical plugin key whose
 * exact normalized prefix starts the tool name. Non-plugin keys, a different
 * installation of the same plugin, a prefix lost to length truncation, or an
 * empty remainder all keep the raw name; nothing is guessed from underscores,
 * and any collision/truncation suffix stays on the remainder. Callers must keep
 * using the raw name for dispatch, history and sticky expansion keys.
 */
export function mcpToolDisplayName(
  toolName: string,
  connection: Pick<MCPConnectionRef, "key">
): string {
  if (!isCanonicalPluginServerKey(connection.key)) return toolName;
  const prefix = `${normalizeMcpToolNamePart(connection.key)}_`;
  if (toolName.length <= prefix.length || !toolName.startsWith(prefix)) return toolName;
  return toolName.slice(prefix.length);
}
