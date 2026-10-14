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

  test("invisible format characters (\\p{Cf}) are refused like direction controls", () => {
    const read = (iface: Record<string, unknown>) =>
      readOpenAIExtension({ extensions: { "com.openai": { interface: iface } } });
    // ZERO WIDTH SPACE: "Fig\u200bma" looks like "Figma" in Settings.
    for (const bad of ["Fig\u200bma", "Fig\u2064ma", "Fig\ufeffma", "Fig\u00adma", "Fig\u2060ma"]) {
      expect(read({ ...validInterface, developerName: bad }).extension).toEqual({});
    }
    const optional = read({ ...validInterface, longDescription: "Line one\nLine\u200b two" });
    expect(optional.extension?.interface).toEqual(validInterface);
    expect(optional.warnings).toHaveLength(1);
  });

  test("joiners and emoji tag characters stay allowed; other format characters do not", () => {
    const read = (iface: Record<string, unknown>) =>
      readOpenAIExtension({ extensions: { "com.openai": { interface: iface } } });
    // ZWJ emoji sequence, a Persian name with ZWNJ, and a subdivision flag (tag characters).
    const scotland = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}";
    for (const good of [
      "Dev \u{1f469}\u200d\u{1f4bb}",
      "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645",
      `Team ${scotland}`,
    ]) {
      const result = read({ ...validInterface, displayName: good, developerName: good });
      expect(result.warnings).toEqual([]);
      expect(result.extension?.interface?.displayName).toBe(good);
    }
    for (const bad of ["Fig\u200bma", "Example\u202eelgooG"]) {
      expect(read({ ...validInterface, developerName: bad }).extension).toEqual({});
    }
  });

  test("a blank capability drops the capability list with a warning", () => {
    const read = (capabilities: unknown) =>
      readOpenAIExtension({
        extensions: { "com.openai": { interface: { ...validInterface, capabilities } } },
      });
    for (const blank of ["", "   "]) {
      const result = read(["Search", blank]);
      expect(result.extension?.interface).toEqual(validInterface);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("interface.capabilities'");
    }
    expect(read(["Search", "Read"]).extension?.interface?.capabilities).toEqual(["Search", "Read"]);
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
