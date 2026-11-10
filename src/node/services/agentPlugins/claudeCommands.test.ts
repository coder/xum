import { describe, expect, test } from "bun:test";
import YAML from "yaml";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { claudeCommandSkillMarkdown } from "./claudeCommands";

function commandFrontmatter(content: string) {
  return parseSkillMarkdown({
    content: claudeCommandSkillMarkdown("review", content),
    byteSize: content.length,
    directoryName: "review",
  }).frontmatter;
}

describe("claudeCommandSkillMarkdown", () => {
  // The two hint forms of the Claude Code docs, unquoted: a YAML list and text YAML refuses.
  test.each(["[focus]", "[filename] [format]"])("keeps argument-hint %s as typed", (hint) => {
    const frontmatter = commandFrontmatter(
      `---\ndescription: Review\nargument-hint: ${hint}\n---\nReview $ARGUMENTS\n`
    );
    expect(frontmatter["argument-hint"]).toBe(hint);
    expect(frontmatter["disable-model-invocation"]).toBe(true);
  });

  test("leaves a quoted hint and other bracketed keys alone", () => {
    const markdown = claudeCommandSkillMarkdown(
      "review",
      `---\ndescription: Review\nargument-hint: "[pr]"\nallowed-tools: [Read, Grep]\n---\nBody\n`
    );
    const raw: unknown = YAML.parse(markdown.split("---\n")[1]);
    expect(raw).toMatchObject({ "argument-hint": "[pr]", "allowed-tools": ["Read", "Grep"] });
  });
});

test("a command that YAML aliases blow up past the size cap does not load", () => {
  // 20 KB in the file; each alias repeats the value when Xum rewrites the frontmatter.
  const value = "x".repeat(20_000);
  const aliases = Array.from({ length: 60 }, (_, index) => `k${index}: *big`).join("\n");
  const content = `---\nbig: &big "${value}"\n${aliases}\n---\nReview it.\n`;
  expect(content.length).toBeLessThan(25_000);
  expect(() => claudeCommandSkillMarkdown("review", content)).toThrow(
    "once its frontmatter is rewritten as a skill"
  );
});
