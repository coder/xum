import { describe, expect, test } from "bun:test";

import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";
import { normalizeCodexManifest, readOpenAIExtension } from "./openaiExtension";

const validInterface = { displayName: "Figma", shortDescription: "Design", developerName: "Figma" };

describe("readOpenAIExtension", () => {
  test("parses every supported field and normalizes package paths", () => {
    const { extension, warnings } = readOpenAIExtension({
      extensions: {
        "com.openai": {
          apps: "./.app.json",
          hooks: ["./hooks/session.json", { hooks: {} }],
          onboardingSkill: "./skills/setup/SKILL.md",
          interface: { displayName: 3 },
        },
      },
    });

    // `interface` is not validated here (no warning even when malformed).
    expect(warnings).toEqual([]);
    expect(extension).toEqual({
      apps: "./.app.json",
      hooks: ["./hooks/session.json", { hooks: {} }],
      onboardingSkill: "./skills/setup/SKILL.md",
    });
  });

  test("drops each invalid field with a warning and keeps the valid ones", () => {
    const { extension, warnings } = readOpenAIExtension({
      extensions: {
        "com.openai": {
          apps: "../outside.json",
          hooks: ["/etc/hooks.json", "./hooks/ok.json"],
          onboardingSkill: "./skills/setup/README.md",
        },
      },
    });

    expect(extension).toEqual({
      hooks: ["./hooks/ok.json"],
    });
    expect(warnings).toHaveLength(3);
    for (const field of ["apps", "hooks", "onboardingSkill"]) {
      expect(warnings.some((warning) => warning.includes(field))).toBe(true);
    }
  });

  test("an absent namespace yields nothing; a non-object namespace warns", () => {
    expect(readOpenAIExtension({})).toEqual({ extension: undefined, warnings: [] });
    const result = readOpenAIExtension({ extensions: { "com.openai": "yes" } });
    expect(result.extension).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
  });
});

describe("normalizeCodexManifest", () => {
  test("maps a one-entry skills array; longer arrays stay unknown", () => {
    expect(normalizeCodexManifest({ name: "a", skills: ["./custom/"] }).manifest).toMatchObject({
      contributes: { skills: "./custom" },
    });
    expect(normalizeCodexManifest({ name: "a", skills: ["./a", "./b"] }).manifest).toMatchObject({
      skills: ["./a", "./b"],
    });
  });

  test("adds $schema and folds Codex top-level fields; inline extension values win", () => {
    const { manifest, warnings } = normalizeCodexManifest({
      name: "figma",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      apps: "./.app.json",
      hooks: "./legacy-hooks.json",
      interface: validInterface,
      extensions: { "com.openai": { hooks: "./hooks/hooks.json" } },
    });

    expect(manifest).toEqual({
      $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
      name: "figma",
      contributes: { skills: "./skills", mcp: "./.mcp.json" },
      extensions: {
        "com.openai": {
          hooks: "./hooks/hooks.json",
          apps: "./.app.json",
          interface: validInterface,
        },
      },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Top-level 'hooks' conflicts");
  });
});
