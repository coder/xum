import { describe, expect, test } from "bun:test";
import { fenceFrontmatter } from "./markdownFrontmatter";

describe("fenceFrontmatter", () => {
  test("rewrites leading frontmatter as a yaml fence that keeps its --- lines and the body", () => {
    expect(fenceFrontmatter("---\ndescription: prefs\n---\n# Title\n")).toBe(
      "```yaml\n---\ndescription: prefs\n---\n```\n\n# Title\n"
    );
  });

  test("recognizes CRLF frontmatter", () => {
    expect(fenceFrontmatter("---\r\ndescription: prefs\r\n---\r\nbody")).toBe(
      "```yaml\n---\ndescription: prefs\n---\n```\n\nbody"
    );
  });

  test.each([
    ["no frontmatter", "# Title\n\nbody\n"],
    ["--- not at the start", "intro\n---\ndescription: prefs\n---\n"],
  ])("leaves content with %s unchanged", (_name, content) => {
    expect(fenceFrontmatter(content)).toBe(content);
  });

  test("uses a fence longer than any backtick run in the yaml", () => {
    const yaml = "description: |\n  ```\n  code\n  ``````";
    const fenced = fenceFrontmatter(`---\n${yaml}\n---\nbody`);
    expect(fenced).toBe(`\`\`\`\`\`\`\`yaml\n---\n${yaml}\n---\n\`\`\`\`\`\`\`\n\nbody`);
  });

  test("handles yaml with more backtick runs than a call accepts as arguments", () => {
    const yaml = "`a".repeat(1_000_000);
    expect(fenceFrontmatter(`---\n${yaml}\n---\nbody`).startsWith("```yaml\n---\n`a`a")).toBe(true);
  });
});
