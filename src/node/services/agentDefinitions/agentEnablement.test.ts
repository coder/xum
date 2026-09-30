import { describe, expect, test } from "bun:test";

import type { AgentDefinitionFrontmatter } from "@/common/types/agentDefinition";
import type { ProjectsConfig } from "@/common/types/project";

import {
  isAgentDisabledByFrontmatter,
  isAgentEffectivelyDisabled,
  resolveAgentEnabledOverride,
} from "./agentEnablement";

function cfgWithOverrides(overrides: Record<string, { enabled?: boolean }>): ProjectsConfig {
  return {
    projects: new Map(),
    agentAiDefaults: overrides,
  };
}

describe("agentEnablement", () => {
  test("disabled: true reports the agent as disabled", () => {
    const frontmatter: AgentDefinitionFrontmatter = {
      name: "Test",
      disabled: true,
    };

    expect(isAgentDisabledByFrontmatter(frontmatter)).toBe(true);
  });

  test("disabled: false (or unset) reports the agent as enabled", () => {
    const enabledExplicit: AgentDefinitionFrontmatter = {
      name: "Test",
      disabled: false,
    };
    const enabledImplicit: AgentDefinitionFrontmatter = { name: "Test" };

    expect(isAgentDisabledByFrontmatter(enabledExplicit)).toBe(false);
    expect(isAgentDisabledByFrontmatter(enabledImplicit)).toBe(false);
  });

  test("user override enabled:true re-enables a disabled agent", () => {
    const cfg = cfgWithOverrides({ foo: { enabled: true } });
    const frontmatter: AgentDefinitionFrontmatter = { name: "Foo", disabled: true };

    expect(resolveAgentEnabledOverride(cfg, "foo")).toBe(true);
    expect(
      isAgentEffectivelyDisabled({
        cfg,
        agentId: "foo",
        resolvedFrontmatter: frontmatter,
      })
    ).toBe(false);
  });

  test("user override enabled:false disables an enabled agent", () => {
    const cfg = cfgWithOverrides({ foo: { enabled: false } });
    const frontmatter: AgentDefinitionFrontmatter = { name: "Foo" };

    expect(resolveAgentEnabledOverride(cfg, "foo")).toBe(false);
    expect(
      isAgentEffectivelyDisabled({
        cfg,
        agentId: "foo",
        resolvedFrontmatter: frontmatter,
      })
    ).toBe(true);
  });

  test("core agents are never effectively disabled", () => {
    const cfg = cfgWithOverrides({ exec: { enabled: false } });
    const frontmatter: AgentDefinitionFrontmatter = { name: "Exec", disabled: true };

    expect(
      isAgentEffectivelyDisabled({
        cfg,
        agentId: "exec",
        resolvedFrontmatter: frontmatter,
      })
    ).toBe(false);
  });
});
