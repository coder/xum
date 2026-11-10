import type { AgentPluginInstallMethod } from "@/common/orpc/schemas/agentPlugins";

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
