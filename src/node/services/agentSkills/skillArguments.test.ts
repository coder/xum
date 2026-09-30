import { describe, expect, test } from "bun:test";

import { substituteSkillArguments } from "./skillArguments";

describe("substituteSkillArguments", () => {
  test("replaces every $ARGUMENTS occurrence with the full trimmed argument text", () => {
    const result = substituteSkillArguments(
      "Fix issue $ARGUMENTS.\nRepeat: $ARGUMENTS",
      "  123 high  "
    );

    expect(result.body).toBe("Fix issue 123 high.\nRepeat: 123 high");
    expect(result.substituted).toBe(true);
  });

  test("replaces positional placeholders from whitespace-tokenized arguments", () => {
    const result = substituteSkillArguments("Issue=$1 Priority=$2 Again=$1", "123\thigh");

    expect(result.body).toBe("Issue=123 Priority=high Again=123");
    expect(result.substituted).toBe(true);
  });

  test("replaces missing positions with empty strings", () => {
    const result = substituteSkillArguments("Issue=$1 Priority=$2 Extra=$9", "123");

    expect(result.body).toBe("Issue=123 Priority= Extra=");
    expect(result.substituted).toBe(true);
  });

  test("treats $10 as $1 followed by a literal 0", () => {
    const result = substituteSkillArguments("Value=$10", "a b");

    expect(result.body).toBe("Value=a0");
    expect(result.substituted).toBe(true);
  });

  test("does not match $ARGUMENTS as a prefix of a longer identifier", () => {
    const result = substituteSkillArguments("Keep $ARGUMENTSFOO but replace $ARGUMENTS", "x");

    expect(result.body).toBe("Keep $ARGUMENTSFOO but replace x");
    expect(result.substituted).toBe(true);
  });

  test("substitutes inside code blocks (intentionally, matching Claude Code)", () => {
    const result = substituteSkillArguments("```bash\necho $1\n```", "hello");

    expect(result.body).toBe("```bash\necho hello\n```");
    expect(result.substituted).toBe(true);
  });

  test("returns substituted=false and an unchanged body when there are no placeholders", () => {
    const body = "No placeholders here. Not even $0 or $ARG.";
    const result = substituteSkillArguments(body, "123 high");

    expect(result.body).toBe(body);
    expect(result.substituted).toBe(false);
  });

  test("replaces placeholders with empty strings when argument text is empty", () => {
    const result = substituteSkillArguments("All: [$ARGUMENTS] First: [$1]", "");

    expect(result.body).toBe("All: [] First: []");
    expect(result.substituted).toBe(true);
  });

  test("does not re-substitute placeholder-like text inside argument values", () => {
    const result = substituteSkillArguments("First: $1 Second: $2", "$2 literal");

    expect(result.body).toBe("First: $2 Second: literal");
    expect(result.substituted).toBe(true);
  });
});
