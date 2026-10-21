import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  installWithSkillsCli,
  installWithSkillsCliResult,
  SKILLS_CLI_PACKAGE,
  skillsCliArgs,
  skillsCliStatus,
  type SkillsCliOptions,
} from "./skillsCli";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";

const REPO = "https://github.com/anthropics/skills.git";

describe("skillsCliArgs", () => {
  test("passes the normalized clone URL and one --skill per name", () => {
    expect(
      skillsCliArgs(" https://github.com/anthropics/skills.git?x=1 ", ["pdf", "skill-creator"])
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
      "--yes",
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
  ])("refuses %s", (_label, source) => {
    expect(() => skillsCliArgs(source, ["pdf"])).toThrow();
  });
});

test("invalid input is the error branch of the ORPC result, not a failed run", async () => {
  const result = await installWithSkillsCliResult({ source: REPO, skills: ["--all"] });

  expect(result.success).toBe(false);
  if (result.success) throw new Error("expected the error branch");
  expect(result.error).toContain("not a valid skill name");
});

describe("skills CLI run", () => {
  let root: string;
  let bin: string;
  let home: string;
  let options: SkillsCliOptions;

  async function writeScript(name: string, body: string): Promise<void> {
    const file = path.join(bin, name);
    await fs.writeFile(file, `#!/bin/sh\n${body}\n`);
    await fs.chmod(file, 0o755);
  }

  async function fakeNode(version: string): Promise<void> {
    await writeScript("node", `echo ${version}`);
  }

  /** A fake npx that writes ~/.agents/skills/<name>/SKILL.md for each --skill. */
  async function fakeInstallingNpx(): Promise<void> {
    await writeScript(
      "npx",
      [
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "--skill" ]; then',
        '    mkdir -p "$HOME/.agents/skills/$2" && echo "# $2" > "$HOME/.agents/skills/$2/SKILL.md"',
        "    shift",
        "  fi",
        "  shift",
        "done",
        `printf '\\033[32mInstalled\\033[0m\\n'`,
        'echo "telemetry=$DISABLE_TELEMETRY files_in_cwd=$(ls -A | wc -l | tr -d " ")"',
      ].join("\n")
    );
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-cli-test-"));
    bin = path.join(root, "bin");
    home = path.join(root, "home");
    await fs.mkdir(bin);
    await fs.mkdir(home);
    // The fake bin first; /usr/bin and /bin only for sh, mkdir, ls and sleep.
    options = { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, homeDir: home };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("Node.js 22.19 is unavailable, and Xum returns the command without running it", async () => {
    await fakeNode("v22.19.0");
    await writeScript("npx", `touch "${root}/ran"`);

    expect(await skillsCliStatus(options)).toMatchObject({
      available: false,
      nodeVersion: "v22.19.0",
    });
    const run = await installWithSkillsCli({ source: REPO, skills: ["pdf"] }, options);

    expect(run).toMatchObject({
      status: "unavailable",
      command: `npx --yes ${SKILLS_CLI_PACKAGE} add ${REPO} --skill pdf --global --agent codex --copy --yes`,
    });
    if (run.status !== "unavailable") throw new Error("expected unavailable");
    expect(run.reason).toContain("22.20.0");
    expect(await fs.stat(path.join(root, "ran")).catch(() => null)).toBeNull();
  });

  test("no npx on PATH is unavailable", async () => {
    await fakeNode("v24.1.0");

    expect(await skillsCliStatus(options)).toMatchObject({ available: false, nodeVersion: null });
    expect((await installWithSkillsCli({ source: REPO, skills: ["pdf"] }, options)).status).toBe(
      "unavailable"
    );
  });

  test("Node.js 22.20 runs the CLI and finds the skills in ~/.agents/skills", async () => {
    await fakeNode("v22.20.0");
    await fakeInstallingNpx();

    expect(await skillsCliStatus(options)).toEqual({
      available: true,
      nodeVersion: "v22.20.0",
      package: SKILLS_CLI_PACKAGE,
    });
    const run = await installWithSkillsCli({ source: REPO, skills: ["pdf", "xlsx"] }, options);

    expect(run).toMatchObject({
      status: "ran",
      ok: true,
      exitCode: 0,
      timedOut: false,
      missingSkills: [],
      failure: null,
    });
    if (run.status !== "ran") throw new Error("expected a run");
    // ANSI stripped; telemetry off; an empty working folder.
    expect(run.output).toBe("Installed\ntelemetry=1 files_in_cwd=0");
  });

  test("secrets in the Xum environment do not reach the CLI; npm config and the proxy do", async () => {
    await fakeNode("v22.20.0");
    await writeScript(
      "npx",
      'echo "key=${ANTHROPIC_API_KEY:-none} gh=${GH_TOKEN:-none} registry=${npm_config_registry:-none} proxy=${HTTPS_PROXY:-none}"'
    );
    const run = await installWithSkillsCli(
      { source: REPO, skills: ["pdf"] },
      {
        ...options,
        env: {
          ...options.env,
          ANTHROPIC_API_KEY: "sk-secret",
          GH_TOKEN: "ghp-secret",
          npm_config_registry: "https://registry.example",
          HTTPS_PROXY: "http://proxy.example:3128",
        },
      }
    );

    if (run.status !== "ran") throw new Error("expected a run");
    expect(run.output).toContain(
      "key=none gh=none registry=https://registry.example proxy=http://proxy.example:3128"
    );
  });

  test("a failing CLI reports its exit code and the output tail", async () => {
    await fakeNode("v22.20.0");
    await writeScript(
      "npx",
      'i=0; while [ $i -lt 20000 ]; do echo "progress line $i"; i=$((i+1)); done\n' +
        'echo "fatal: repository not found" >&2\nexit 1'
    );

    const run = await installWithSkillsCli({ source: REPO, skills: ["pdf"] }, options);

    expect(run).toMatchObject({ status: "ran", ok: false, exitCode: 1, timedOut: false });
    if (run.status !== "ran") throw new Error("expected a run");
    expect(run.failure).toContain("exit code 1");
    expect(run.output.endsWith("fatal: repository not found")).toBe(true);
    expect(run.output.length).toBeLessThan(70 * 1024);
    expect(run.output).not.toContain("progress line 0\n");
  });

  test("an existing skill folder stops the run: the CLI would replace it without asking", async () => {
    await fakeNode("v22.20.0");
    await fakeInstallingNpx();
    const kept = path.join(home, ".agents", "skills", "pdf");
    await fs.mkdir(kept, { recursive: true });
    await fs.writeFile(path.join(kept, "SKILL.md"), "# hand-edited");
    // A dangling link is an entry too: the CLI would delete it.
    await fs.symlink(path.join(root, "gone"), path.join(home, ".agents", "skills", "xlsx"));

    await expect(
      installWithSkillsCli({ source: REPO, skills: ["pdf", "docx", "xlsx"] }, options)
    ).rejects.toThrow("~/.agents/skills already has pdf, xlsx.");
    expect(await fs.readFile(path.join(kept, "SKILL.md"), "utf8")).toBe("# hand-edited");
    expect(
      await fs.lstat(path.join(home, ".agents", "skills", "docx")).catch(() => null)
    ).toBeNull();
  });

  test("another backend's run in the same home makes this one wait", async () => {
    await fakeNode("v22.20.0");
    await fakeInstallingNpx();
    // Another Xum backend holds the run lock (same home, separate process mutex).
    const held = await acquireProcessFileLock({
      lockPath: path.join(home, ".agents", ".xum-skills-cli.lock"),
      timeoutMs: 1000,
      label: "test holder",
    });
    let settled = false;
    const run = installWithSkillsCli({ source: REPO, skills: ["pdf"] }, options).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    await held[Symbol.asyncDispose]();
    expect(await run).toMatchObject({ status: "ran", ok: true });
  });

  test("XDG_STATE_HOME reaches the CLI, which keeps its lock file there", async () => {
    await fakeNode("v22.20.0");
    await writeScript("npx", 'echo "state=${XDG_STATE_HOME:-none}"');
    const run = await installWithSkillsCli(
      { source: REPO, skills: ["pdf"] },
      { ...options, env: { ...options.env, XDG_STATE_HOME: "/state" } }
    );
    if (run.status !== "ran") throw new Error("expected a run");
    expect(run.output).toBe("state=/state");
  });

  test("exit 0 without the skill folder is a missing-skill failure", async () => {
    await fakeNode("v22.20.0");
    await writeScript("npx", "echo 'No matching skills found'");

    const run = await installWithSkillsCli({ source: REPO, skills: ["pdf"] }, options);

    expect(run).toMatchObject({ status: "ran", ok: false, exitCode: 0, missingSkills: ["pdf"] });
  });

  test("spinner redraws keep only the text after the last carriage return of each line", async () => {
    await fakeNode("v22.20.0");
    await writeScript(
      "npx",
      "printf '◒ Cloning\\r◐ Cloning\\r\\033[2K◇ Cloned\\r\\n│\\n└  Done!\\r\\n'"
    );

    const run = await installWithSkillsCli({ source: REPO, skills: ["pdf"] }, options);

    if (run.status !== "ran") throw new Error("expected a run");
    expect(run.output).toBe("◇ Cloned\n│\n└  Done!");
  });

  test("a hanging CLI is stopped at the timeout", async () => {
    await fakeNode("v22.20.0");
    await writeScript("npx", "echo started\nexec sleep 30");

    const run = await installWithSkillsCli(
      { source: REPO, skills: ["pdf"] },
      { ...options, timeoutMs: 300 }
    );

    expect(run).toMatchObject({ status: "ran", ok: false, timedOut: true, exitCode: null });
    if (run.status !== "ran") throw new Error("expected a run");
    expect(run.output).toBe("started");
  });
});
