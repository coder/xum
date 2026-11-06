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

/**
 * The method that loads each manifest file, by its path relative to the plugin root with `/`
 * (`AgentPluginInfo.manifestPath`). Pinned to discovery's manifest table by a test.
 */
export const MANIFEST_PATH_INSTALL_METHODS: Readonly<Record<string, SavedInstallMethod>> = {
  "plugin.json": "agent-plugin",
  ".codex-plugin/plugin.json": "agent-plugin",
  ".claude-plugin/plugin.json": "claude-plugin",
  ".cursor-plugin/plugin.json": "cursor-plugin",
};

/**
 * The kind an install row reads "Installed as <label>" for: the generator when Xum wrote the
 * plugin.json, else the method of the manifest discovery loaded. Undefined for a manifest path
 * that no method loads.
 */
export function installedAsKind(plugin: {
  generatedFrom?: GeneratedMethodKind | undefined;
  manifestPath?: string | undefined;
}): AgentPluginInstallMethod["kind"] | undefined {
  if (plugin.generatedFrom !== undefined) return plugin.generatedFrom;
  return plugin.manifestPath === undefined
    ? undefined
    : MANIFEST_PATH_INSTALL_METHODS[plugin.manifestPath];
}

/** A manifest method's long label for the "Install as" toggle: its short label and its file. */
export function installMethodLongLabel(method: SavedInstallMethod, manifestPath: string): string {
  return `${AGENT_PLUGIN_INSTALL_METHOD_LABELS[method]} (${manifestPath})`;
}
