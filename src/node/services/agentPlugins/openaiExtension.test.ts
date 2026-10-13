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
        },
      },
    });

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

  test("validates the interface: bad URL, too-long text and an escaping image are dropped", () => {
    const { extension, warnings } = readOpenAIExtension({
      extensions: {
        "com.openai": {
          interface: {
            ...validInterface,
            longDescription: "x".repeat(4001),
            websiteURL: "http://example.com",
            privacyPolicyURL: "https://example.com/privacy",
            brandColor: "#1ABCFE",
            logo: "../outside.png",
            composerIcon: "./assets/icon.png",
            defaultPrompt: "Inspect a design",
            capabilities: ["Read"],
          },
        },
      },
    });
    expect(extension?.interface).toEqual({
      ...validInterface,
      privacyPolicyURL: "https://example.com/privacy",
      brandColor: "#1ABCFE",
      composerIcon: "./assets/icon.png",
      defaultPrompt: ["Inspect a design"],
      capabilities: ["Read"],
    });
    expect(warnings).toHaveLength(3);
    for (const field of ["longDescription", "websiteURL", "logo"]) {
      expect(warnings.some((warning) => warning.includes(`interface.${field}'`))).toBe(true);
    }
  });

  test("required names up to OpenAI's package limits are kept; one more character drops the interface", () => {
    const atLimits = {
      displayName: "d".repeat(80),
      shortDescription: "s".repeat(240),
      developerName: "v".repeat(120),
    };
    const read = (iface: Record<string, unknown>) =>
      readOpenAIExtension({ extensions: { "com.openai": { interface: iface } } });
    expect(read(atLimits)).toEqual({ extension: { interface: atLimits }, warnings: [] });
    for (const [field, value] of Object.entries(atLimits)) {
      const { extension, warnings } = read({ ...atLimits, [field]: `${value}x` });
      expect(extension).toEqual({});
      expect(warnings.some((warning) => warning.includes(`interface.${field}'`))).toBe(true);
    }
  });

  test("control and direction characters: a required field drops the interface, an optional one is dropped", () => {
    const read = (iface: Record<string, unknown>) =>
      readOpenAIExtension({ extensions: { "com.openai": { interface: iface } } });
    // U+202E reverses the rest of the line: "Example\u202eelgooG" reads as "ExampleGoogle".
    const spoofed = read({ ...validInterface, developerName: "Example\u202eelgooG" });
    expect(spoofed.extension).toEqual({});
    expect(spoofed.warnings.some((w) => w.includes("interface.developerName'"))).toBe(true);
    // U+061C (ARABIC LETTER MARK) is a direction control too.
    expect(read({ ...validInterface, developerName: "Example\u061cCo" }).extension).toEqual({});
    for (const bad of [
      "a\u0007b",
      "a\u0085b",
      "a\u2028b",
      "a\u2066b",
      "a\u200fb",
      "two\nlines",
      "  ",
    ]) {
      expect(read({ ...validInterface, displayName: bad }).extension).toEqual({});
    }
    // Optional: dropped alone, with a warning. longDescription may break lines with \n.
    const optional = read({
      ...validInterface,
      category: "Design\u202a",
      longDescription: "First line\nSecond line",
    });
    expect(optional.extension?.interface).toEqual({
      ...validInterface,
      longDescription: "First line\nSecond line",
    });
    expect(optional.warnings).toHaveLength(1);
    expect(optional.warnings[0]).toContain("interface.category'");
    // Capabilities and prompts are text too.
    expect(read({ ...validInterface, capabilities: ["Read\u202e"] }).extension?.interface).toEqual(
      validInterface
    );
  });

  test("an interface without its required names is dropped as a whole", () => {
    const { extension, warnings } = readOpenAIExtension({
      extensions: { "com.openai": { interface: { displayName: "Only a name" } } },
    });
    expect(extension).toEqual({});
    expect(warnings).toHaveLength(1);
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
