import { afterEach, describe, test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  GIT_NO_HOOKS_ENV,
  gitHooksAllowed,
  gitNoHooksPrefix,
  gitNoRepoAutomationEnv,
  gitNoRepoAutomationEnvForFilterConfigKeys,
  gitNoRepoAutomationEnvForLocalRepo,
} from "./gitNoHooksEnv";

describe("GIT_NO_HOOKS_ENV", () => {
  test("disables git hooks via core.hooksPath=/dev/null", () => {
    expect(GIT_NO_HOOKS_ENV).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_PARAMETERS: "",
    });
  });

  test("all values are strings (safe for env vars)", () => {
    for (const value of Object.values(GIT_NO_HOOKS_ENV)) {
      expect(typeof value).toBe("string");
    }
  });
});

describe("gitNoHooksPrefix", () => {
  test("returns empty string when trusted", () => {
    expect(gitNoHooksPrefix(true)).toBe("");
  });

  test("returns env prefix when untrusted (false)", () => {
    const prefix = gitNoHooksPrefix(false);
    expect(prefix).toContain("GIT_CONFIG_COUNT='3'");
    expect(prefix).toContain("core.hooksPath");
    expect(prefix).toContain("/dev/null");
    expect(prefix).toContain("GIT_CONFIG_PARAMETERS=");
    expect(prefix).toEndWith(" ");
  });

  test("returns env prefix when untrusted (undefined)", () => {
    const prefix = gitNoHooksPrefix(undefined);
    expect(prefix).toContain("GIT_CONFIG_COUNT='3'");
    expect(prefix).toEndWith(" ");
  });
});

describe("gitNoRepoAutomationEnv", () => {
  test("neutralizes every repo-controlled git execution vector", () => {
    const env = gitNoRepoAutomationEnv();
    // Hooks, fsmonitor, and credential helpers via env config entries.
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_KEY_0).toBe("core.hooksPath");
    expect(env.GIT_CONFIG_VALUE_0).toBe("/dev/null");
    expect(env.GIT_CONFIG_KEY_1).toBe("core.fsmonitor");
    expect(env.GIT_CONFIG_VALUE_1).toBe("false");
    expect(env.GIT_CONFIG_KEY_2).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_2).toBe("");
    // Pointing the tracked attributes source at the empty tree suppresses
    // .gitattributes; the repo-aware builder below additionally overrides
    // drivers selected by highest-precedence .git/info/attributes.
    expect(env.GIT_ATTR_SOURCE).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    // Environment beats repo-config core.sshCommand.
    expect(env.GIT_SSH_COMMAND).toBe("ssh");
  });

  test("blanks provider secret env vars so leaked processes capture nothing", () => {
    const env = gitNoRepoAutomationEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.OPENAI_API_KEY).toBe("");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("");
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe("");
  });

  test("rejects filter driver names that cannot be overridden safely", () => {
    const longName = "a".repeat(513);
    expect(() => gitNoRepoAutomationEnvForFilterConfigKeys([`filter.${longName}.smudge`])).toThrow(
      "unsupported driver name"
    );
    expect(() => gitNoRepoAutomationEnvForFilterConfigKeys([`diff.${longName}.command`])).toThrow(
      "unsupported driver name"
    );
  });

  test("neutralizes filters selected by .git/info/attributes without mutating it", async () => {
    using tmp = new DisposableTempDir("git-filter-automation-off");
    const repo = path.join(tmp.path, "repo");
    const worktree = path.join(tmp.path, "worktree");
    const marker = path.join(tmp.path, "filter-ran");
    const driver = path.join(tmp.path, "smudge.sh");
    await fs.mkdir(repo, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email test@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Test`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "data.txt"), "payload\n", "utf-8");
    await Bun.$`git add data.txt`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await fs.writeFile(
      driver,
      `#!/bin/sh\nprintf '%s' "\${ANTHROPIC_API_KEY-}" > "${marker}"\ncat\n`,
      "utf-8"
    );
    await fs.chmod(driver, 0o755);
    await Bun.$`git config filter.evil.smudge ${driver}`.cwd(repo).quiet();
    await Bun.$`git config filter.evil.required true`.cwd(repo).quiet();
    await fs.writeFile(
      path.join(repo, ".git", "info", "attributes"),
      "*.txt filter=evil\n",
      "utf-8"
    );

    const env = await gitNoRepoAutomationEnvForLocalRepo(repo);
    const filterKeys = Object.entries(env)
      .filter(([key]) => key.startsWith("GIT_CONFIG_KEY_"))
      .map(([, value]) => value);
    expect(filterKeys).toContain("filter.evil.smudge");
    expect(filterKeys).toContain("filter.evil.process");
    expect(filterKeys).toContain("filter.evil.required");

    await Bun.$`git worktree add ${worktree} -b safe-filter-checkout`
      .cwd(repo)
      .env({ ...process.env, ANTHROPIC_API_KEY: "secret", ...env })
      .quiet();
    expect(await fs.readFile(path.join(worktree, "data.txt"), "utf-8")).toBe("payload\n");
    expect(await fs.readFile(path.join(repo, ".git", "info", "attributes"), "utf-8")).toBe(
      "*.txt filter=evil\n"
    );
    let markerExists = true;
    try {
      await fs.access(marker);
    } catch {
      markerExists = false;
    }
    expect(markerExists).toBe(false);
  });

  test("neutralizes external diff drivers selected by .git/info/attributes", async () => {
    using tmp = new DisposableTempDir("git-diff-automation-off");
    const repo = path.join(tmp.path, "repo");
    const marker = path.join(tmp.path, "diff-ran");
    const driver = path.join(tmp.path, "diff.sh");
    await fs.mkdir(repo, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email test@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Test`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "data.txt"), "before\n", "utf-8");
    await Bun.$`git add data.txt`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await fs.writeFile(driver, `#!/bin/sh\ntouch "${marker}"\n`, "utf-8");
    await fs.chmod(driver, 0o755);
    await Bun.$`git config diff.evil.command ${driver}`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, ".git", "info", "attributes"), "*.txt diff=evil\n", "utf-8");
    await fs.writeFile(path.join(repo, "data.txt"), "after\n", "utf-8");

    await Bun.$`git diff`.cwd(repo).quiet();
    await fs.access(marker);
    await fs.rm(marker);

    const env = await gitNoRepoAutomationEnvForLocalRepo(repo);
    const configKeys = Object.entries(env)
      .filter(([key]) => key.startsWith("GIT_CONFIG_KEY_"))
      .map(([, value]) => value);
    expect(configKeys).toContain("diff.evil.command");
    expect(configKeys).toContain("diff.evil.textconv");

    await Bun.$`git diff`
      .cwd(repo)
      .env({ ...process.env, ...env })
      .quiet()
      .nothrow();
    await expect(fs.access(marker)).rejects.toThrow();
  });
});

describe("gitHooksAllowed", () => {
  const previousKillSwitch = process.env.MUX_DISABLE_PROJECT_AUTOMATION;

  afterEach(() => {
    if (previousKillSwitch === undefined) {
      delete process.env.MUX_DISABLE_PROJECT_AUTOMATION;
    } else {
      process.env.MUX_DISABLE_PROJECT_AUTOMATION = previousKillSwitch;
    }
  });

  test("hooks run only for trusted projects", () => {
    delete process.env.MUX_DISABLE_PROJECT_AUTOMATION;
    expect(gitHooksAllowed(true)).toBe(true);
    expect(gitHooksAllowed(false)).toBe(false);
    expect(gitHooksAllowed(undefined)).toBe(false);
  });

  test("the automation kill-switch neutralizes hooks even when trusted", () => {
    process.env.MUX_DISABLE_PROJECT_AUTOMATION = "1";
    // Dataset-planted .git/hooks must not execute during git operations
    // (worktree add for task forks, bash-tool git commands) even though the
    // project keeps config trust for delegation.
    expect(gitHooksAllowed(true)).toBe(false);
    const prefix = gitNoHooksPrefix(true);
    expect(prefix).toContain("core.hooksPath");
    // Checkout filters and provider secrets are suppressed in the same
    // prefix, covering remote (SSH/Docker) materialization paths.
    expect(prefix).toContain("GIT_ATTR_SOURCE=");
    expect(prefix).toContain("ANTHROPIC_API_KEY='' ");
  });
});
