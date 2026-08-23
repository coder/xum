/**
 * Experiments System
 *
 * Global feature flags for experimental features.
 * State is persisted in localStorage as `experiment:${experimentId}`.
 */

export const EXPERIMENT_IDS = {
  PROGRAMMATIC_TOOL_CALLING: "programmatic-tool-calling",
  PROGRAMMATIC_TOOL_CALLING_EXCLUSIVE: "programmatic-tool-calling-exclusive",
  RLM: "rlm-mode",
  CONFIGURABLE_BIND_URL: "configurable-bind-url",
  MUX_GOVERNOR: "mux-governor",
  MULTI_PROJECT_WORKSPACES: "multi-project-workspaces",
  AGENT_BROWSER: "agent-browser",
  ADVISOR_TOOL: "advisor-tool",
  WORKSPACE_HEARTBEATS: "workspace-heartbeats",
  PORTABLE_DESKTOP: "portable-desktop",
  DYNAMIC_WORKFLOWS: "dynamic-workflows",
  MEMORY: "memory",
  MEMORY_HOT_SET: "memory-hot-set",
  MEMORY_CONSOLIDATION: "memory-consolidation",
  TOOL_SEARCH: "tool-search",
  CLAUDE_SKILLS_COMPAT: "claude-skills-compat",
  AGENT_PLUGINS: "agent-plugins",
  SKILL_DYNAMIC_CONTEXT: "skill-dynamic-context",
  TIMELINE: "timeline",
} as const;

export type ExperimentId = (typeof EXPERIMENT_IDS)[keyof typeof EXPERIMENT_IDS];

export interface ExperimentDefinition {
  id: ExperimentId;
  name: string;
  description: string;
  /** Default state - false means disabled by default */
  enabledByDefault: boolean;
  /**
   * When set, the experiment is only toggleable on these platforms. On other platforms it
   * appears disabled with a message.
   */
  platformRestriction?: NodeJS.Platform[];
  /**
   * When false, experiment is hidden from Settings → Experiments.
   * Defaults to true. Use false for invisible A/B tests.
   */
  showInSettings?: boolean;
}

/**
 * Registry of all experiments.
 * Use Record<ExperimentId, ExperimentDefinition> to ensure exhaustive coverage.
 */
export const EXPERIMENTS: Record<ExperimentId, ExperimentDefinition> = {
  [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: {
    id: EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING,
    name: "Programmatic Tool Calling",
    description: "Enable code_execution tool for multi-tool workflows in a sandboxed JS runtime",
    enabledByDefault: false,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING_EXCLUSIVE]: {
    id: EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING_EXCLUSIVE,
    name: "PTC Exclusive Mode",
    description: "Replace all tools with code_execution (forces PTC usage)",
    enabledByDefault: false,
    showInSettings: true,
  },
  // Sub-experiment of Programmatic Tool Calling (flat flag, gated on the PTC
  // parent at call sites; Settings nests it under the PTC toggle). Without a
  // PTC flag the option is inert: code_execution is never assembled.
  [EXPERIMENT_IDS.RLM]: {
    id: EXPERIMENT_IDS.RLM,
    name: "RLM Mode",
    description:
      "Kernel-first exclusive toolset: code_execution becomes the primary tool, backed by a persistent sandbox kernel (vars survive across calls/turns, bulk file loads, result handles, fire-and-forget sub-agents). Implies PTC Exclusive posture; supplement mode is not supported.",
    enabledByDefault: false,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.CONFIGURABLE_BIND_URL]: {
    id: EXPERIMENT_IDS.CONFIGURABLE_BIND_URL,
    name: "Expose API server on LAN/VPN",
    description:
      "Allow Xum to listen on a non-localhost address so other devices on your LAN/VPN can connect. Anyone on your network with the auth token can access your Xum API. HTTP only; use only on trusted networks (Tailscale recommended).",
    enabledByDefault: false,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.MUX_GOVERNOR]: {
    id: EXPERIMENT_IDS.MUX_GOVERNOR,
    name: "Xum Governor",
    description: "Remote policy delivery for enterprise Xum Governor service",
    enabledByDefault: false,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES]: {
    id: EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES,
    name: "Multi-project workspaces",
    description: "Enable workspaces that can span multiple projects instead of a single project",
    enabledByDefault: false,
    // Keep this visible so users can opt into the still-default-off experiment from Settings.
    showInSettings: true,
  },
  [EXPERIMENT_IDS.AGENT_BROWSER]: {
    id: EXPERIMENT_IDS.AGENT_BROWSER,
    name: "Agent Browser",
    description: "Show the Browser tab in the right sidebar for live agent-browser viewing",
    enabledByDefault: false,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.ADVISOR_TOOL]: {
    id: EXPERIMENT_IDS.ADVISOR_TOOL,
    name: "Advisor Tool",
    description: "Enable the experimental client-side advisor tool foundation",
    enabledByDefault: false,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.WORKSPACE_HEARTBEATS]: {
    id: EXPERIMENT_IDS.WORKSPACE_HEARTBEATS,
    name: "Workspace Heartbeats",
    description: "Persist per-workspace heartbeat settings for future background follow-ups",
    enabledByDefault: false,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.PORTABLE_DESKTOP]: {
    id: EXPERIMENT_IDS.PORTABLE_DESKTOP,
    name: "Portable Desktop",
    description: "Enable virtual desktop sessions for GUI-based agent interactions",
    enabledByDefault: false,
    platformRestriction: ["linux"],
    showInSettings: true,
  },
  [EXPERIMENT_IDS.DYNAMIC_WORKFLOWS]: {
    id: EXPERIMENT_IDS.DYNAMIC_WORKFLOWS,
    name: "Dynamic Workflows",
    description: "Enable durable JavaScript workflow orchestration for delegated agent tasks",
    enabledByDefault: false,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.MEMORY]: {
    id: EXPERIMENT_IDS.MEMORY,
    name: "Agent Memory",
    description:
      "Enable the agent memory tool and memory index (global / project / workspace scopes)",
    enabledByDefault: false,
    showInSettings: true,
  },
  // Sub-experiment of Agent Memory (flat flag, gated on the parent at the call
  // site; Settings nests it under the Agent Memory toggle). Without it, memories
  // stay pull-based like skills: index advertised in the memory tool description,
  // contents fetched on demand.
  [EXPERIMENT_IDS.MEMORY_HOT_SET]: {
    id: EXPERIMENT_IDS.MEMORY_HOT_SET,
    name: "Memory Hot Set",
    description: "Preload pinned and frequently used memory files into the system prompt",
    enabledByDefault: false,
    showInSettings: true,
  },
  // Sub-experiment of Agent Memory (flat flag, gated on the parent at call
  // sites; Settings nests it under the Agent Memory toggle): background "dream"
  // consolidation passes that merge, prune, and promote memory files (issue #3534).
  [EXPERIMENT_IDS.MEMORY_CONSOLIDATION]: {
    id: EXPERIMENT_IDS.MEMORY_CONSOLIDATION,
    name: "Memory Consolidation",
    description:
      "Background dream agent that consolidates memory files after compaction, on idle, and at archive",
    enabledByDefault: false,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.TOOL_SEARCH]: {
    id: EXPERIMENT_IDS.TOOL_SEARCH,
    name: "Tool Search",
    description:
      "Defer MCP tool definitions out of the model-visible tool list until the model discovers them via the tool_catalog_search tool",
    enabledByDefault: false,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.CLAUDE_SKILLS_COMPAT]: {
    id: EXPERIMENT_IDS.CLAUDE_SKILLS_COMPAT,
    name: "Claude compatibility",
    description:
      "Also read skills from .claude/skills and ~/.claude/skills, plus global instructions from ~/.claude/CLAUDE.md (read-only, lowest precedence)",
    enabledByDefault: false,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.AGENT_PLUGINS]: {
    id: EXPERIMENT_IDS.AGENT_PLUGINS,
    name: "Agent Plugins",
    description:
      "Discover Agent Plugins (agent-plugins.org 1.0.0) from .xum/plugins, .agents/plugins, ~/.xum/plugins, and ~/.agents/plugins: plugin skills join skill discovery and plugin MCP servers appear disabled by default",
    enabledByDefault: false,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT]: {
    id: EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT,
    name: "Skill dynamic context injection",
    description:
      "When you invoke a skill, whole-line !`command` directives in SKILL.md run in the workspace and are replaced with their output before the model sees the skill. Commands come from skill files, so only enable this if you trust the skills in your projects.",
    enabledByDefault: false,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.TIMELINE]: {
    id: EXPERIMENT_IDS.TIMELINE,
    name: "Timeline",
    description:
      "Record a durable birds-eye timeline per workspace: prompts, agent events, goals, heartbeats, sub-agents, and workflows",
    enabledByDefault: false,
    showInSettings: true,
  },
};

function getPlatformDisplayName(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return platform;
  }
}

export function isExperimentSupportedOnPlatform(
  experiment: ExperimentDefinition | ExperimentId,
  platform: NodeJS.Platform | null | undefined
): boolean {
  const definition = typeof experiment === "string" ? EXPERIMENTS[experiment] : experiment;

  if (!definition.platformRestriction?.length || platform == null) {
    return true;
  }

  return definition.platformRestriction.includes(platform);
}

export function getExperimentPlatformRestrictionLabel(
  experiment: ExperimentDefinition | ExperimentId
): string | null {
  const definition = typeof experiment === "string" ? EXPERIMENTS[experiment] : experiment;
  const platforms = definition.platformRestriction;

  if (!platforms?.length) {
    return null;
  }

  const platformLabels = platforms.map(getPlatformDisplayName);
  if (platformLabels.length === 1) {
    return `Only available on ${platformLabels[0]}`;
  }

  if (platformLabels.length === 2) {
    return `Only available on ${platformLabels[0]} and ${platformLabels[1]}`;
  }

  const lastPlatform = platformLabels[platformLabels.length - 1];
  return `Only available on ${platformLabels.slice(0, -1).join(", ")}, and ${lastPlatform}`;
}

/**
 * Get localStorage key for an experiment.
 * Format: "experiment:{experimentId}"
 */
export function getExperimentKey(experimentId: ExperimentId): string {
  return `experiment:${experimentId}`;
}

/**
 * Get all experiment definitions as an array for iteration.
 */
export function getExperimentList(): ExperimentDefinition[] {
  return Object.values(EXPERIMENTS);
}
