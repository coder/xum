import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  SKILLS_CLI_PACKAGE,
  skillsCliArgs,
  skillsCliCommand,
  skillsCliCommandResult,
} from "./skillsCli";

const execFileAsync = promisify(execFile);

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
      command: `${process.platform === "win32" ? "" : "cd ~ && "}npx --yes ${SKILLS_CLI_PACKAGE} add git@github.com:anthropics/skills.git --skill pdf --global --agent codex --copy`,
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

// Windows terminals differ (cmd.exe, PowerShell 5 and 7, Git Bash), and no folder-change prefix
// works in all of them, so the Windows command has none: Settings asks the user to run it from
// the home folder instead.
test("the Windows command has no shell-specific prefix", () => {
  const command = skillsCliCommand({ source: REPO, skills: ["pdf"] }, "win32");
  expect(command.startsWith("npx --yes ")).toBe(true);
  expect(skillsCliCommand({ source: REPO, skills: ["pdf"] }, "darwin")).toBe(`cd ~ && ${command}`);
});

// npx prefers a matching package in the working folder's node_modules over the registry, so the
// shown command must leave the folder the user runs it from before npx starts.
test.skipIf(process.platform === "win32")(
  "the shown command starts npx in the home folder, not in the current folder",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-cli-cwd-"));
    try {
      const home = path.join(root, "home");
      const checkout = path.join(root, "checkout");
      const bin = path.join(root, "bin");
      await fs.mkdir(home);
      await fs.mkdir(path.join(checkout, "node_modules", "skills"), { recursive: true });
      await fs.mkdir(bin);
      // A stand-in npx that reports the folder it starts in.
      await fs.writeFile(path.join(bin, "npx"), "#!/bin/sh\npwd -P\n", { mode: 0o755 });
      const command = skillsCliCommand({ source: REPO, skills: ["pdf"] }, "linux");
      const { stdout } = await execFileAsync("/bin/sh", ["-c", command], {
        cwd: checkout,
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
        encoding: "utf8",
      });
      expect(stdout.trim()).toBe(await fs.realpath(home));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
