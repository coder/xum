import { describe, expect, it } from "bun:test";

import { PLUGIN_SIBLING_NOTE_MAX_SKILLS } from "@/common/constants/toolLimits";
import type { InvocableSkill } from "@/common/types/agentSkill";
import { formatPluginSiblingNote } from "./pluginSiblingNote";

function mappedNames(note: string | null): string[] {
  return [...(note ?? "").matchAll(/`[^`]+` -> `([^`]+)`/g)].map((match) => match[1]);
}

function qualifiedSkill(pluginName: string, name: string): InvocableSkill {
  return { name: `${pluginName}:${name}`, description: "x", scope: "global", pluginName };
}

describe("formatPluginSiblingNote", () => {
  it("caps the mappings and counts the rest", () => {
    const siblingCount = PLUGIN_SIBLING_NOTE_MAX_SKILLS + 5;
    const skills = Array.from({ length: siblingCount }, (_, i) =>
      qualifiedSkill("big", `skill-${i}`)
    );

    const note = formatPluginSiblingNote({ pluginName: "big", skillName: "main", skills });

    expect(mappedNames(note)).toEqual(
      skills.slice(0, PLUGIN_SIBLING_NOTE_MAX_SKILLS).map((skill) => skill.name)
    );
    expect(note).toContain(" 5 more");
  });
});
