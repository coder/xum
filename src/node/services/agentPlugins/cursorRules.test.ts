import { describe, expect, test } from "bun:test";
import {
  AgentSkillParseError,
  parseSkillMarkdown,
} from "@/node/services/agentSkills/parseSkillMarkdown";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { convertCursorRule, cursorRuleSkillMarkdown } from "./cursorRules";

const SKILL_DESCRIPTION_CAP = 1024;

/** A rule file as the skill Xum loads: converted, then parsed like any plugin SKILL.md. */
function ruleSkill(name: string, content: string) {
  const markdown = cursorRuleSkillMarkdown({ name, file: `${name}.mdc` }, content);
  return parseSkillMarkdown({
    content: markdown,
    byteSize: Buffer.byteLength(markdown, "utf8"),
    directoryName: name,
  });
}

function ruleType(frontmatter: { metadata?: Record<string, unknown> }) {
  return frontmatter.metadata?.["cursor-rule-type"];
}

describe("Cursor rule types", () => {
  test("alwaysApply: true is a model-invocable always-apply skill with its description", () => {
    const { frontmatter } = ruleSkill(
      "prefer-const",
      "---\nalwaysApply: true\ndescription: Prefer const over let\n---\nUse const.\n"
    );
    expect(frontmatter.name).toBe("prefer-const");
    expect(ruleType(frontmatter)).toBe("always-apply");
    expect(frontmatter.description).toBe("Prefer const over let");
    expect(frontmatter["disable-model-invocation"]).not.toBe(true);
  });

  test("description only is a model-invocable description skill", () => {
    const { frontmatter } = ruleSkill(
      "api-style",
      "---\ndescription: REST naming rules\n---\nUse plural nouns.\n"
    );
    expect(ruleType(frontmatter)).toBe("description");
    expect(frontmatter.description).toBe("REST naming rules");
    expect(frontmatter["disable-model-invocation"]).not.toBe(true);
  });

  test("alwaysApply: false with a description is a description rule", () => {
    const { frontmatter } = ruleSkill(
      "api-style",
      "---\nalwaysApply: false\ndescription: REST naming rules\n---\nBody\n"
    );
    expect(ruleType(frontmatter)).toBe("description");
  });

  test("globs make a model-invocable glob skill with the globs in its description", () => {
    const { frontmatter } = ruleSkill(
      "typescript",
      '---\ndescription: TypeScript rules\nglobs: ["**/*.ts"]\n---\nNo any.\n'
    );
    expect(ruleType(frontmatter)).toBe("glob");
    expect(frontmatter.description).toBe("TypeScript rules\n\nApplies to files matching: **/*.ts");
    expect(frontmatter["disable-model-invocation"]).not.toBe(true);
  });

  test("a globs string counts as globs", () => {
    const { frontmatter } = ruleSkill("typescript", '---\nglobs: "**/*.ts"\n---\nNo any.\n');
    expect(ruleType(frontmatter)).toBe("glob");
    expect(frontmatter.description).toEndWith("\n\nApplies to files matching: **/*.ts");
  });

  test("several globs are joined with a comma", () => {
    const { frontmatter } = ruleSkill(
      "typescript",
      '---\ndescription: TS\nglobs: ["**/*.ts", "**/*.tsx"]\n---\nBody\n'
    );
    expect(frontmatter.description).toBe("TS\n\nApplies to files matching: **/*.ts, **/*.tsx");
  });

  test("alwaysApply: true wins over globs", () => {
    const { frontmatter } = ruleSkill(
      "typescript",
      '---\nalwaysApply: true\ndescription: TS\nglobs: ["**/*.ts"]\n---\nBody\n'
    );
    expect(ruleType(frontmatter)).toBe("always-apply");
    expect(frontmatter["disable-model-invocation"]).not.toBe(true);
  });

  test("globs win over a description", () => {
    const { frontmatter } = ruleSkill(
      "typescript",
      '---\ndescription: TS\nglobs: ["**/*.ts"]\n---\nBody\n'
    );
    expect(ruleType(frontmatter)).toBe("glob");
  });

  test("none of the three is a user-only manual rule described by its first body line", () => {
    const { frontmatter } = ruleSkill(
      "commit-style",
      "---\n---\n\nWrite commit titles in the imperative.\nSecond line.\n"
    );
    expect(ruleType(frontmatter)).toBe("manual");
    expect(frontmatter["disable-model-invocation"]).toBe(true);
    expect(frontmatter.description).toBe("Write commit titles in the imperative.");
  });

  test("a rule file without frontmatter is a manual rule", () => {
    const { frontmatter } = ruleSkill("commit-style", "Write commit titles in the imperative.\n");
    expect(ruleType(frontmatter)).toBe("manual");
    expect(frontmatter["disable-model-invocation"]).toBe(true);
    expect(frontmatter.description).toBe("Write commit titles in the imperative.");
  });

  test("a rule with no description and an empty body is described by its name", () => {
    const { frontmatter } = ruleSkill("empty-rule", "---\nalwaysApply: false\n---\n");
    expect(frontmatter.description).toBe("Cursor rule empty-rule");
  });
});

describe("Cursor rule conversion", () => {
  test("keeps the rule body unchanged", () => {
    const body = "# Heading\n\nUse `const`.\n\n- one\n- two\n";
    const { body: skillBody } = ruleSkill(
      "prefer-const",
      `---\ndescription: Prefer const\n---\n${body}`
    );
    expect(skillBody).toBe(body);
  });

  test("drops rule-only frontmatter keys from the skill", () => {
    const { frontmatter } = ruleSkill(
      "prefer-const",
      "---\ndescription: Prefer const\nalwaysApply: true\nglobs: []\n---\nBody\n"
    );
    expect(frontmatter).not.toHaveProperty("alwaysApply");
    expect(frontmatter).not.toHaveProperty("globs");
  });

  test("cuts a long description so it and the globs fit the skill description cap", () => {
    const { frontmatter } = ruleSkill(
      "long",
      `---\ndescription: ${"d".repeat(2000)}\nglobs: ["**/*.ts"]\n---\nBody\n`
    );
    expect(frontmatter.description.length).toBeLessThanOrEqual(SKILL_DESCRIPTION_CAP);
    expect(frontmatter.description).toStartWith("ddd");
    expect(frontmatter.description).toEndWith("\n\nApplies to files matching: **/*.ts");
  });

  test("cuts a long first body line to the skill description cap", () => {
    const { frontmatter } = ruleSkill("long", `${"w".repeat(3000)}\n`);
    expect(frontmatter.description.length).toBeLessThanOrEqual(SKILL_DESCRIPTION_CAP);
    expect(frontmatter.description).toStartWith("www");
  });
});

describe("invalid Cursor rules", () => {
  test.each([
    ["frontmatter that does not parse", "---\n: [\n---\nBody\n"],
    ["frontmatter that is a list", "---\n- a\n- b\n---\nBody\n"],
    ["frontmatter that is a scalar", "---\njust text\n---\nBody\n"],
  ])("%s is refused with the invalid frontmatter warning", (_label, content) => {
    expect(convertCursorRule({ name: "bad", file: "bad.mdc" }, content)).toEqual({
      reason: "invalid frontmatter",
      warning: "Rule 'bad.mdc' has invalid frontmatter; ignoring it",
    });
    expect(() => cursorRuleSkillMarkdown({ name: "bad", file: "bad.mdc" }, content)).toThrow(
      AgentSkillParseError
    );
  });

  test("the warning names the rule file, extension included", () => {
    const refused = convertCursorRule({ name: "bad", file: "bad.markdown" }, "---\n: [\n---\n");
    expect(refused).toMatchObject({
      warning: "Rule 'bad.markdown' has invalid frontmatter; ignoring it",
    });
  });
});

// Review Finding 11: YAML aliases expand when the frontmatter is written again, and the scan sites
// parse the converted text with the original file's size, so the conversion itself enforces the cap.
describe("Cursor rule size cap", () => {
  const anchored = "a".repeat(200);
  const aliases = Array.from({ length: 40 }, () => "*x").join(", ");
  const frontmatter = `---\nx: &x "${anchored}"\nglobs: [${aliases}]\n---\n`;

  test("a rule over the SKILL.md cap once rewritten is refused", () => {
    const headroom = 100;
    const padding = "p".repeat(MAX_FILE_SIZE - headroom - Buffer.byteLength(frontmatter, "utf8"));
    const content = `${frontmatter}${padding}`;
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_FILE_SIZE);

    const converted = convertCursorRule({ name: "big", file: "big.mdc" }, content);
    expect(converted).toMatchObject({ reason: "too large once rewritten as a skill" });
    expect(() => cursorRuleSkillMarkdown({ name: "big", file: "big.mdc" }, content)).toThrow(
      AgentSkillParseError
    );
  });

  test("the same rule with a small body converts", () => {
    const { frontmatter: skill } = ruleSkill("big", `${frontmatter}Small body.\n`);
    expect(ruleType(skill)).toBe("glob");
    expect(skill.description).toContain(`Applies to files matching: ${anchored}, ${anchored}`);
  });
});
