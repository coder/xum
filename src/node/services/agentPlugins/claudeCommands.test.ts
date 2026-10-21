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
