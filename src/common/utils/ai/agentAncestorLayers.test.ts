import { describe, expect, test } from "bun:test";

import type { AgentDefinitionPackage } from "@/common/types/agentDefinition";

import { applySettingsBaseChain, getAgentAiSettingsBases } from "./agentAncestorLayers";

interface Hop {
  id: string;
  ai?: AgentDefinitionPackage["frontmatter"]["ai"];
}

describe("applySettingsBaseChain", () => {
  const ownChain: Hop[] = [{ id: "fast", ai: { thinkingLevel: "low" } }, { id: "exec" }];

  test("keeps the own chain when the settings-base agent could not be read", () => {
    expect(applySettingsBaseChain("fast", ownChain, null)).toEqual({
      chain: ownChain,
      ignored: "missing",
    });
  });

  test("keeps the own chain when the settings base is the agent itself", () => {
    expect(applySettingsBaseChain("fast", ownChain, [{ id: "fast" }, { id: "exec" }])).toEqual({
      chain: ownChain,
      ignored: "self",
    });
  });

  test("keeps the own chain when the settings base inherits from the agent", () => {
    const settingsBaseChain: Hop[] = [{ id: "helper" }, { id: "fast" }, { id: "exec" }];
    expect(applySettingsBaseChain("fast", ownChain, settingsBaseChain)).toEqual({
      chain: ownChain,
      ignored: "cycle",
    });
  });

  test.each([
    ["the settings base", 0],
    ["a base of the settings base", 1],
  ])("keeps the own chain when %s sets a settings base", (_label, index) => {
    const settingsBaseChain: Hop[] = [{ id: "b" }, { id: "c" }];
    settingsBaseChain[index] = { ...settingsBaseChain[index], ai: { settingsBase: "explore" } };
    expect(applySettingsBaseChain("fast", ownChain, settingsBaseChain)).toEqual({
      chain: ownChain,
      ignored: "nested",
    });
  });

  test("keeps the agent's same-ID refinements, then the settings-base chain", () => {
    const project: Hop = { id: "a", ai: { model: "custom:project" } };
    const plugin: Hop = { id: "a", ai: { thinkingLevel: "high" } };
    const explore: Hop = { id: "explore", ai: { cacheTtl: "5m" } };
    const result = applySettingsBaseChain(
      "a",
      [project, plugin, { id: "exec" }],
      [explore, { id: "exec" }]
    );
    expect(result).toEqual({ chain: [project, plugin, explore, { id: "exec" }] });
  });
});

describe("getAgentAiSettingsBases", () => {
  const watcher = {
    id: "ci-watcher",
    base: "exec",
    aiSettingsBase: "explore",
    aiLayers: { ancestors: [{ agentId: "explore" }, { agentId: "exec" }] },
  };

  test("adds the resolved hops through an agent the list leaves out", () => {
    expect(getAgentAiSettingsBases([watcher, { id: "exec" }])).toEqual(
      new Map([
        ["explore", "exec"],
        ["ci-watcher", "explore"],
        ["exec", undefined],
      ])
    );
  });

  test("keeps a listed agent's own base over a hop from another agent's layers", () => {
    const bases = getAgentAiSettingsBases([watcher, { id: "explore", base: "helper" }]);
    expect(bases.get("explore")).toBe("helper");
  });
});
