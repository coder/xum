/**
 * Plugin views: MCP Apps views a plugin declares in `contributes.views`, which
 * the user opens from the command palette without a tool call.
 *
 * The renderer names a view only by `pluginViewId` (`<instanceId>/<viewId>`).
 * This module maps that ID back to the plugin's own server key and ui://
 * resource from a fresh discovery, so the renderer can never name an arbitrary
 * server or resource. Discovery uses the same containers, Project Trust and
 * project-root containment as the plugin MCP provider, and the instance ID
 * comes from resolvePluginInstanceId (the one rule shared with server keys and
 * PLUGIN_DATA).
 */
import type { MCPServerInfo, WorkspaceMCPOverrides } from "@/common/types/mcp";
import assert from "@/common/utils/assert";
import { discoverWorkspaceAgentPlugins } from "./discovery";
import {
  buildPluginServerKey,
  resolvePluginInstanceId,
  type AgentPluginsMcpContext,
} from "./mcpConfig";

export interface PluginViewDescriptor {
  /** `<instanceId>/<viewId>`: the only handle the renderer sends back. */
  pluginViewId: string;
  pluginName: string;
  title: string;
  /** mcp.json server name, for display and error messages. */
  serverName: string;
  /** `plugin:<instanceId>:<serverName>`: the server the view reads from and calls. */
  serverKey: string;
  resourceUri: string;
}

export interface PluginViewEntry extends PluginViewDescriptor {
  /** Whether the view's server is enabled for the workspace (plugin servers start disabled). */
  enabled: boolean;
}

const PLUGIN_VIEW_ID_PATTERN = /^[0-9a-f]{16}\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isPluginViewId(value: string): boolean {
  return PLUGIN_VIEW_ID_PATTERN.test(value);
}

/** Every view declared by the workspace's discoverable plugins (servers not yet checked). */
export async function discoverPluginViews(args: {
  xumHome: string;
  projectTrusted: boolean;
  /** resolveAgentPluginsMcpContext's result; callers pass null-context workspaces nothing. */
  context: AgentPluginsMcpContext & { projectRoot: string };
}): Promise<PluginViewDescriptor[]> {
  const { plugins } = await discoverWorkspaceAgentPlugins({
    workspacePath: args.context.projectRoot,
    xumHome: args.xumHome,
    projectTrusted: args.projectTrusted,
  });
  const views: PluginViewDescriptor[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    const declared = plugin.manifest.contributes?.views ?? [];
    if (declared.length === 0) continue;
    const instanceId = resolvePluginInstanceId(plugin, args.context);
    for (const view of declared) {
      const pluginViewId = `${instanceId}/${view.id}`;
      assert(isPluginViewId(pluginViewId), "discoverPluginViews: malformed plugin view ID");
      // Discovery can list one physical plugin under several registrations.
      if (seen.has(pluginViewId)) continue;
      seen.add(pluginViewId);
      views.push({
        pluginViewId,
        pluginName: plugin.name,
        title: view.title,
        serverName: view.server,
        serverKey: buildPluginServerKey(instanceId, view.server),
        resourceUri: view.resourceUri,
      });
    }
  }
  return views;
}

/**
 * Keep the views whose server the workspace actually has (a view naming a server its
 * mcp.json lacks, that failed to load, or that consent revoked is dropped) and mark whether
 * that server is enabled, with the same precedence the MCP server manager applies:
 * workspace enable, then workspace disable, then the configured default.
 */
export function attachPluginViewServers(
  views: readonly PluginViewDescriptor[],
  servers: Readonly<Record<string, MCPServerInfo>>,
  overrides: WorkspaceMCPOverrides
): PluginViewEntry[] {
  const enabledSet = new Set(overrides.enabledServers ?? []);
  const disabledSet = new Set(overrides.disabledServers ?? []);
  const entries: PluginViewEntry[] = [];
  for (const view of views) {
    const server = Object.hasOwn(servers, view.serverKey) ? servers[view.serverKey] : undefined;
    // Only the plugin's own server: a global or repo server cannot share the reserved key,
    // but check provenance anyway so a view never binds to a non-plugin server.
    if (server?.plugin === undefined) continue;
    const enabled =
      enabledSet.has(view.serverKey) || (!disabledSet.has(view.serverKey) && !server.disabled);
    entries.push({ ...view, enabled });
  }
  return entries;
}
