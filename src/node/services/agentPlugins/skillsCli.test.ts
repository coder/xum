/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `await expect(...).rejects.toThrow()` as void */
import { describe, expect, test } from "bun:test";

import { SKILLS_CLI_PACKAGE, skillsCliArgs, skillsCliCommandResult } from "./skillsCli";

const REPO = "https://github.com/anthropics/skills.git";

describe("skillsCliArgs", () => {
  test("passes the normalized clone URL and one --skill per name", () => {
    expect(
      skillsCliArgs(" https://github.com/anthropics/skills.git ", ["pdf", "skill-creator"])
    ).toEqual([
      "--yes",
      SKILLS_CLI_PACKAGE,
      "add",
      REPO,
      "--skill",
      "pdf",
      "--skill",
      "skill-creator",
      "--global",
      "--agent",
      "codex",
      "--copy",
    ]);
  });

  test("accepts an SCP-style ssh URL", () => {
    expect(skillsCliArgs("git@github.com:anthropics/skills.git", ["pdf"])[3]).toBe(
      "git@github.com:anthropics/skills.git"
    );
  });

  test("refuses an empty skill list", () => {
    expect(() => skillsCliArgs(REPO, [])).toThrow("at least one skill");
  });

  test.each(["--all", "-a", "Bad_Name", "pdf --global", ""])(
    "refuses the skill name %p",
    (name) => {
      expect(() => skillsCliArgs(REPO, ["pdf", name])).toThrow("not a valid skill name");
    }
  );

  test.each([
    ["a credential URL", "https://user:token@github.com/anthropics/skills.git"],
    ["an option-like SCP source", "-oProxyCommand:touch"],
    ["a source with an option-like host", "git@-oProxyCommand=x:repo"],
    ["a file URL", "file:///tmp/skills"],
    ["a local path", "/tmp/skills"],
    ["plain http", "http://example.com/skills.git"],
    ["shorthand with a ref", "anthropics/skills@main"],
    ["shorthand with a subpath", "anthropics/skills/skills/pdf"],
    ["a cmd.exe metacharacter", "https://attacker.example/repo&calc&x.git"],
  ])("refuses %s", (_label, source) => {
    expect(() => skillsCliArgs(source, ["pdf"])).toThrow();
  });
});

test("the command holds only validated arguments; invalid input is the error branch", () => {
  expect(
    skillsCliCommandResult({ source: "git@github.com:anthropics/skills.git", skills: ["pdf"] })
  ).toEqual({
    success: true,
    data: {
      command: `npx --yes ${SKILLS_CLI_PACKAGE} add git@github.com:anthropics/skills.git --skill pdf --global --agent codex --copy`,
    },
  });
  for (const input of [
    { source: REPO, skills: ["--all"] },
    { source: "https://attacker.example/repo&calc&x.git", skills: ["pdf"] },
    { source: REPO, skills: [] },
  ]) {
    expect(skillsCliCommandResult(input).success).toBe(false);
  }
});
