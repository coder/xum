import type {
  AgentPluginInstallMethod,
  GeneratedMethodKind,
  SavedInstallMethod,
} from "@/common/orpc/schemas/agentPlugins";

/** User-facing name of each install method (preview label, "Install as" choice, errors). */
export const AGENT_PLUGIN_INSTALL_METHOD_LABELS: Record<AgentPluginInstallMethod["kind"], string> =
  {
    "agent-plugin": "Agent Plugin",
    "claude-plugin": "Claude Code plugin",
    "cursor-plugin": "Cursor plugin",
    skills: "Skills",
    "claude-marketplace": "Claude Code marketplace entry",
    "cursor-marketplace": "Cursor marketplace entry",
  };

export const MANIFEST_PATH_INSTALL_METHODS: Readonly<Record<string, SavedInstallMethod>> = {
  "plugin.json": "agent-plugin",
  ".codex-plugin/plugin.json": "agent-plugin",
  ".claude-plugin/plugin.json": "claude-plugin",
  ".cursor-plugin/plugin.json": "cursor-plugin",
};

export function installedAsKind(plugin: {
  generatedFrom?: GeneratedMethodKind | undefined;
  manifestPath?: string | undefined;
}): AgentPluginInstallMethod["kind"] | undefined {
  if (plugin.generatedFrom !== undefined) return plugin.generatedFrom;
  return plugin.manifestPath === undefined
    ? undefined
    : MANIFEST_PATH_INSTALL_METHODS[plugin.manifestPath];
}
