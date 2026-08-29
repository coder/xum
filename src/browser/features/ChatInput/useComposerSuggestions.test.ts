import { describe, expect, test } from "bun:test";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import {
  applyComposerSuggestion,
  detectActiveComposerToken,
  getSynchronousComposerSuggestions,
} from "./useComposerSuggestions";

const experiments = {
  workspaceHeartbeats: false,
  dynamicWorkflows: false,
  memory: false,
  memoryConsolidation: false,
  rlm: false,
  programmaticToolCalling: false,
};
const context = {
  agentSkills: [
    { name: "deep-review", description: "Review code", scope: "global" },
  ] satisfies AgentSkillDescriptor[],
  mcpPrompts: [],
  pluginCommands: [],
  variant: "workspace" as const,
  experiments,
};
const suggestion = (replacement: string): SlashSuggestion => ({
  id: replacement,
  display: replacement,
  description: "",
  replacement,
});

describe("detectActiveComposerToken", () => {
  test.each([
    ["/ask @src/fo", 12, "file", "src/fo"],
    ["/ask $deep", 10, "inline", "deep"],
    [String.raw`/ask \alp`, 9, "symbol", "alp"],
    ["/clear", 6, "slash", "/clear"],
    ["plain text", 10, null, null],
  ] as const)("detects the active token in %s", (input, cursor, kind, query) => {
    const token = detectActiveComposerToken(input, cursor);
    expect(token?.kind ?? null).toBe(kind);
    expect(token?.query ?? null).toBe(query);
  });
});

describe("getSynchronousComposerSuggestions", () => {
  test.each([
    ["$deep", 5, "$deep-review"],
    [String.raw`\alpha`, 6, String.raw`\alpha`],
    ["/cl", 3, "/clear"],
  ] as const)("derives matches for %s during render", (input, cursor, expected) => {
    const token = detectActiveComposerToken(input, cursor);
    expect(getSynchronousComposerSuggestions(token, context).map((item) => item.display)).toContain(
      expected
    );
  });
});

describe("applyComposerSuggestion", () => {
  test.each([
    ["see @sr now", 7, "@src/file.ts", "see @src/file.ts  now", 17],
    ["use $de, now", 7, "$deep-review", "use $deep-review, now", 16],
    [String.raw`x \alp2`, 6, "α", "x α2", 3],
    ["/cl", 3, "/clear", "/clear", 6],
  ] as const)("applies a selection for %s", (input, cursor, replacement, expected, nextCursor) => {
    const token = detectActiveComposerToken(input, cursor);
    expect(token).not.toBeNull();
    if (!token) return;
    expect(applyComposerSuggestion(input, token, suggestion(replacement))).toEqual({
      input: expected,
      cursor: nextCursor,
    });
  });
});
