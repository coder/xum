import { describe, expect, test } from "bun:test";

import { SkillNameSchema } from "@/common/orpc/schemas";
import {
  AgentSkillParseError,
  parseSkillMarkdown,
  quoteBracketedArgumentHint,
} from "./parseSkillMarkdown";

describe("parseSkillMarkdown", () => {
  test("parses valid YAML frontmatter and body", () => {
    const content = `---
name: pdf-processing
description: Extract text from PDFs
---
# Instructions
Do the thing.
`;

    const directoryName = SkillNameSchema.parse("pdf-processing");

    const result = parseSkillMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
      directoryName,
    });

    expect(result.frontmatter.name).toBe("pdf-processing");
    expect(result.frontmatter.description).toBe("Extract text from PDFs");
    expect(result.body).toContain("# Instructions");
  });

  test("tolerates unknown frontmatter keys (e.g., allowed-tools)", () => {
    const content = `---
name: foo
description: Hello
allowed-tools: file_read
---
Body
`;

    const directoryName = SkillNameSchema.parse("foo");

    const result = parseSkillMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
      directoryName,
    });

    expect(result.frontmatter.name).toBe("foo");
    expect(result.frontmatter.description).toBe("Hello");
  });

  test("accepts non-string metadata values (nested maps, numbers)", () => {
    // Shape from warpdotdev/common-skills merge-risk, plus an unquoted version number.
    const content = `---
name: merge-risk
description: Use when assessing the risk of merging a PR
metadata:
  version: 1.0
  credits:
    skill: pr
    author: Matt Pocock
---
Body
`;

    const result = parseSkillMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
      directoryName: SkillNameSchema.parse("merge-risk"),
    });

    expect(result.frontmatter.metadata).toEqual({
      version: 1,
      credits: { skill: "pr", author: "Matt Pocock" },
    });
  });

  // Tagged YAML parses to Set/Map/Uint8Array, and a recursive alias to a cyclic object.
  // Neither survives the RPC serializer or the consent fingerprint, so both reject the skill.
  test.each([
    ["!!set", "metadata:\n  tags: !!set\n    ? a\n    ? b\n", "metadata.tags"],
    ["!!omap", "metadata:\n  order: !!omap\n    - a: 1\n", "metadata.order"],
    ["!!binary", "metadata:\n  blob: !!binary aGVsbG8=\n", "metadata.blob"],
    ["a recursive alias", "metadata:\n  loop: &A\n    self: *A\n", "recursive YAML alias"],
  ])("rejects metadata with %s", (_label, metadataYaml, expectedError) => {
    const content = `---\nname: foo\ndescription: Hello\n${metadataYaml}---\nBody\n`;

    expect(() =>
      parseSkillMarkdown({
        content,
        byteSize: Buffer.byteLength(content, "utf-8"),
        directoryName: SkillNameSchema.parse("foo"),
      })
    ).toThrow(expectedError);
  });

  test("accepts a shared, non-recursive YAML alias in metadata", () => {
    const content = `---
name: foo
description: Hello
metadata:
  base: &B
    owner: team
  copy: *B
---
Body
`;

    const result = parseSkillMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
      directoryName: SkillNameSchema.parse("foo"),
    });

    expect(result.frontmatter.metadata).toEqual({
      base: { owner: "team" },
      copy: { owner: "team" },
    });
  });

  test("parses advertise field in frontmatter", () => {
    const content = `---
name: internal-skill
description: An internal skill not shown in the index
advertise: false
---
Body
`;

    const directoryName = SkillNameSchema.parse("internal-skill");

    const result = parseSkillMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
      directoryName,
    });

    expect(result.frontmatter.name).toBe("internal-skill");
    expect(result.frontmatter.advertise).toBe(false);
  });

  test("parses disable-model-invocation field in frontmatter", () => {
    const content = `---
name: user-only-skill
description: A skill only the user should trigger
disable-model-invocation: true
---
Body
`;

    const directoryName = SkillNameSchema.parse("user-only-skill");

    const result = parseSkillMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
      directoryName,
    });

    expect(result.frontmatter.name).toBe("user-only-skill");
    expect(result.frontmatter["disable-model-invocation"]).toBe(true);
  });

  test("parses user-invocable, argument-hint, and when_to_use fields in frontmatter", () => {
    const content = `---
name: model-only-skill
description: A skill only the model should trigger
user-invocable: false
argument-hint: "[issue-number]"
when_to_use: Use when triaging issues
---
Body
`;

    const directoryName = SkillNameSchema.parse("model-only-skill");

    const result = parseSkillMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
      directoryName,
    });

    expect(result.frontmatter["user-invocable"]).toBe(false);
    expect(result.frontmatter["argument-hint"]).toBe("[issue-number]");
    expect(result.frontmatter.when_to_use).toBe("Use when triaging issues");
  });

  // The Claude Code docs write the hint unquoted, which YAML reads as a flow sequence ("[x]")
  // or as invalid YAML ("[a] [b]"); either way the skill failed to load (#7123 item 5).
  const parseHintedSkill = (frontmatter: string) => {
    const content = `---\n${frontmatter}\n---\nBody\n`;
    return parseSkillMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
      directoryName: SkillNameSchema.parse("hinted-skill"),
    }).frontmatter;
  };

  test.each([
    ["argument-hint: [issue-number]", "[issue-number]"],
    ["argument-hint: [filename] [format]", "[filename] [format]"],
    // JSON quoting keeps inner quotes and backslashes as typed.
    ['argument-hint: [say "hi"] [C:\\dir]', '[say "hi"] [C:\\dir]'],
    // A value that is already quoted is not quoted again.
    ['argument-hint: "[pr]"', "[pr]"],
    ["argument-hint: '[a] [b]'", "[a] [b]"],
    // A trailing YAML comment stays a comment, as it does for a quoted hint.
    ["argument-hint: [issue-number] # issue ID", "[issue-number]"],
    ["argument-hint : [issue-number]", "[issue-number]"],
  ])("keeps %s as typed", (line, hint) => {
    const frontmatter = parseHintedSkill(
      `name: hinted-skill\ndescription: Takes arguments\n${line}`
    );
    expect(frontmatter["argument-hint"]).toBe(hint);
  });

  // A 1 MB SKILL.md can come from a cloned repo. An earlier quadratic pattern took ~16 s on this
  // input; the linear one takes under 1 ms, so the bound leaves room for a slow CI host.
  test("quotes a hint line with a long run of spaces in linear time", () => {
    const hint = `[${" ".repeat(100_000)}x`;
    const startedAt = performance.now();
    const quoted = quoteBracketedArgumentHint(`name: hinted-skill\nargument-hint: ${hint}`);
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(quoted).toBe(`name: hinted-skill\nargument-hint: ${JSON.stringify(hint)}`);
  });

  test("keeps a bracketed argument-hint in an indented root mapping, not in block text", () => {
    const frontmatter = parseHintedSkill(
      "  name: hinted-skill\n  description: |\n    argument-hint: [x]\n  argument-hint: [pr]"
    );
    expect(frontmatter["argument-hint"]).toBe("[pr]");
    expect(frontmatter.description).toBe("argument-hint: [x]\n");
  });

  test("parses kebab-case when-to-use spelling in frontmatter", () => {
    const content = `---
name: kebab-skill
description: Uses the kebab spelling
when-to-use: Use for kebab-style frontmatter
---
Body
`;

    const directoryName = SkillNameSchema.parse("kebab-skill");

    const result = parseSkillMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
      directoryName,
    });

    expect(result.frontmatter["when-to-use"]).toBe("Use for kebab-style frontmatter");
    expect(result.frontmatter.when_to_use).toBeUndefined();
  });

  test("throws on missing frontmatter", () => {
    const content = "# No frontmatter\n";
    expect(() =>
      parseSkillMarkdown({
        content,
        byteSize: Buffer.byteLength(content, "utf-8"),
      })
    ).toThrow(AgentSkillParseError);
  });

  test("throws when frontmatter name does not match directory name", () => {
    const content = `---
name: bar
description: Hello
---
Body
`;

    const directoryName = SkillNameSchema.parse("foo");

    expect(() =>
      parseSkillMarkdown({
        content,
        byteSize: Buffer.byteLength(content, "utf-8"),
        directoryName,
      })
    ).toThrow(AgentSkillParseError);
  });
});

describe("parseSkillMarkdown allowDisplayName", () => {
  const parse = (name: string, dir: string, allowDisplayName?: boolean) => {
    const content = `---\n${name}\ndescription: Router skill\n---\nBody\n`;
    return parseSkillMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
      directoryName: SkillNameSchema.parse(dir),
      allowDisplayName,
    });
  };

  test.each([
    ["name: Poteto Mode", "poteto-mode", "Poteto Mode"],
    ["name: deploy", "deploy-staging", "deploy"],
    ["name: '  Make Bot UI  '", "make-bot-ui", "Make Bot UI"],
  ])("%s in %s loads under the directory name", (name, dir, displayName) => {
    const result = parse(name, dir, true);
    expect(result.frontmatter.name).toBe(dir);
    expect(result.displayName).toBe(displayName);
  });

  test("a valid skill parses the same with or without the option", () => {
    const strict = parse("name: poteto-mode", "poteto-mode");
    const lenient = parse("name: poteto-mode", "poteto-mode", true);
    expect(lenient).toEqual(strict);
    expect("displayName" in lenient).toBe(false);
  });

  test("strict callers still reject a name that differs from the directory", () => {
    expect(() => parse("name: Poteto Mode", "poteto-mode")).toThrow(AgentSkillParseError);
  });

  test.each([
    ["non-string", "name: 42"],
    ["empty", "name: ''"],
    ["whitespace", "name: '   '"],
    ["too long", `name: ${"x".repeat(65)}`],
    ["multi-line", "name: |\n  Poteto\n  Mode"],
    // YAML double-quoted escapes: a C1 control, a line separator, a bidi override.
    ["C1 control", 'name: "Poteto\\x85Mode"'],
    ["line-separator", 'name: "Poteto\\u2028Mode"'],
    ["bidi-override", 'name: "Poteto\\u202eMode"'],
    ["missing", "license: MIT"],
  ])("a %s name still throws with the option", (_label, name) => {
    expect(() => parse(name, "poteto-mode", true)).toThrow(AgentSkillParseError);
  });
});
