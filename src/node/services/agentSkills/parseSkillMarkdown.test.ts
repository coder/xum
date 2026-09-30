import { describe, expect, test } from "bun:test";

import { SkillNameSchema } from "@/common/orpc/schemas";
import { AgentSkillParseError, parseSkillMarkdown } from "./parseSkillMarkdown";

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
