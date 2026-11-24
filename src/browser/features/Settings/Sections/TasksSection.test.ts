import { describe, expect, test } from "bun:test";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { FALLBACK_AGENTS, deriveTasksSectionAgentGroups } from "./TasksSection.agents";

// NOTE: the invariant that FALLBACK_AGENTS mirrors the built-in agent inventory
// lives in src/node/services/agentDefinitions/builtInAgentDefinitions.test.ts,
// since browser/ cannot value-import from node/.

describe("FALLBACK_AGENTS", () => {
  test("keeps hidden built-ins in the fallback inventory", () => {
    const fallbackAgentIds = FALLBACK_AGENTS.map((agent) => agent.id);

    expect(fallbackAgentIds).toContain("desktop");
    expect(fallbackAgentIds).toContain("name_workspace");
    expect(fallbackAgentIds).toContain("dream");
  });
});

describe("deriveTasksSectionAgentGroups", () => {
  test("hides Desktop from Settings while keeping its overrides known when Portable Desktop is off", () => {
    const agentAiDefaults: AgentAiDefaults = {
      desktop: { enabled: false },
      mystery: { enabled: true },
    };

    const groups = deriveTasksSectionAgentGroups({
      listedAgents: FALLBACK_AGENTS,
      agentAiDefaults,
      portableDesktopEnabled: false,
      memoryConsolidationEnabled: false,
      statusPageAgentEnabled: false,
    });

    expect(groups.subagents.map((agent) => agent.id)).toEqual(["explore"]);
    expect(groups.unknownAgentIds).toEqual(["mystery"]);
  });

  test("shows Desktop before Explore in Sub-agents when Portable Desktop is on", () => {
    const groups = deriveTasksSectionAgentGroups({
      listedAgents: FALLBACK_AGENTS,
      agentAiDefaults: {},
      portableDesktopEnabled: true,
      memoryConsolidationEnabled: false,
      statusPageAgentEnabled: false,
    });

    expect(groups.subagents.map((agent) => agent.id)).toEqual(["desktop", "explore"]);
  });

  test("hides Dream from Settings while keeping its overrides known when Memory Consolidation is off", () => {
    const agentAiDefaults: AgentAiDefaults = {
      dream: { modelString: "anthropic:claude-haiku-4-5" },
    };

    const groups = deriveTasksSectionAgentGroups({
      listedAgents: FALLBACK_AGENTS,
      agentAiDefaults,
      portableDesktopEnabled: false,
      memoryConsolidationEnabled: false,
      statusPageAgentEnabled: false,
    });

    expect(groups.internalAgents.map((agent) => agent.id)).not.toContain("dream");
    // The saved override must stay "known", not surface under Unknown agents.
    expect(groups.unknownAgentIds).toEqual([]);
  });

  test("shows Dream under Internal when Memory Consolidation is on", () => {
    const groups = deriveTasksSectionAgentGroups({
      listedAgents: FALLBACK_AGENTS,
      agentAiDefaults: {},
      portableDesktopEnabled: false,
      memoryConsolidationEnabled: true,
      statusPageAgentEnabled: false,
    });

    expect(groups.internalAgents.map((agent) => agent.id)).toContain("dream");
  });

  test("shows Status Page under Internal only when the status page agent is enabled", () => {
    const agentAiDefaults: AgentAiDefaults = {
      status_page: { modelString: "anthropic:claude-haiku-4-5" },
    };
    const derive = (statusPageAgentEnabled: boolean) =>
      deriveTasksSectionAgentGroups({
        listedAgents: FALLBACK_AGENTS,
        agentAiDefaults,
        portableDesktopEnabled: false,
        memoryConsolidationEnabled: false,
        statusPageAgentEnabled,
      });

    const off = derive(false);
    expect(off.internalAgents.map((agent) => agent.id)).not.toContain("status_page");
    // The saved model choice must stay "known", not surface under Unknown agents.
    expect(off.unknownAgentIds).toEqual([]);
    expect(derive(true).internalAgents.map((agent) => agent.id)).toContain("status_page");
  });
});
