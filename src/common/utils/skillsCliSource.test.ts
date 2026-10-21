import { describe, expect, test } from "bun:test";

import {
  SKILLS_CLI_NOT_REMOTE_PROBLEM,
  SKILLS_CLI_REF_OR_SUBPATH_PROBLEM,
  skillsCliSourceProblem,
} from "./skillsCliSource";

describe("skillsCliSourceProblem", () => {
  test.each([
    "anthropics/skills",
    "anthropics/skills/",
    " https://github.com/anthropics/skills.git ",
    "ssh://git@github.com/anthropics/skills.git",
    "ssh://github.com/anthropics/skills.git",
    "git@github.com:anthropics/skills.git",
  ])("takes %p", (source) => {
    expect(skillsCliSourceProblem(source)).toBeUndefined();
  });

  test.each([
    "file:///tmp/skills",
    "/tmp/skills",
    "~/skills",
    "./skills",
    "C:\\skills",
    "http://example.com/skills.git",
    "-oProxyCommand:touch",
    "git@-oProxyCommand=x:repo",
    "ssh://-oProxyCommand=touch/repo",
    "ssh://-u@github.com/repo",
  ])("refuses the local or non-https source %p", (source) => {
    expect(skillsCliSourceProblem(source)).toBe(SKILLS_CLI_NOT_REMOTE_PROBLEM);
  });

  test.each(["anthropics/skills@main", "anthropics/skills/skills/pdf"])(
    "refuses the shorthand with a ref or subpath %p",
    (source) => {
      expect(skillsCliSourceProblem(source)).toBe(SKILLS_CLI_REF_OR_SUBPATH_PROBLEM);
    }
  );
});
