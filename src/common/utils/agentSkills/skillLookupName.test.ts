import { describe, expect, test } from "bun:test";

import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import { listInvocableSkills, parseSkillLookupName } from "./skillLookupName";

describe("parseSkillLookupName", () => {
  test.each([
    ["tdd", { skillName: "tdd" }],
    ["pstack:tdd", { pluginName: "pstack", skillName: "tdd" }],
    ["a.b:c", { pluginName: "a.b", skillName: "c" }],
  ])("accepts %s", (input, expected) => {
    expect(parseSkillLookupName(input)).toEqual(expected);
  });

  test.each([
    "a::b",
    ":tdd",
    "tdd:",
    // The schema regex cannot express these plugin-name rules.
    "a--b:c",
    "a..b:c",
    "con:x",
    "Pstack:tdd",
    "pstack:TDD",
    `${"a".repeat(65)}:tdd`,
  ])("rejects %s", (input) => {
    expect(parseSkillLookupName(input)).toBeNull();
  });
});

describe("listInvocableSkills", () => {
  const skill = (name: string, pluginName?: string): AgentSkillDescriptor => ({
    name,
    description: `${name} description`,
    scope: "global",
    ...(pluginName != null ? { pluginName } : {}),
  });

  test("lists shadowed plugin skills qualified and sorted, after the unchanged winners", () => {
    const invocable = listInvocableSkills({
      skills: [skill("alpha"), skill("tdd"), skill("zeta", "pstack")],
      shadowedPluginSkills: [skill("tdd", "pstack"), skill("tdd", "other")],
    });
    expect(invocable.map((entry) => entry.name)).toEqual([
      "alpha",
      "tdd",
      "zeta",
      "other:tdd",
      "pstack:tdd",
    ]);
  });
});
