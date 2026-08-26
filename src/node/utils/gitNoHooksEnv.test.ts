import { afterEach, describe, test, expect } from "bun:test";
import {
  GIT_NO_HOOKS_ENV,
  gitHooksAllowed,
  gitNoHooksPrefix,
  gitNoRepoAutomationEnv,
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
    expect(prefix).toContain("GIT_CONFIG_COUNT=3");
    expect(prefix).toContain("core.hooksPath");
    expect(prefix).toContain("/dev/null");
    expect(prefix).toContain("GIT_CONFIG_PARAMETERS=");
    expect(prefix).toEndWith(" ");
  });

  test("returns env prefix when untrusted (undefined)", () => {
    const prefix = gitNoHooksPrefix(undefined);
    expect(prefix).toContain("GIT_CONFIG_COUNT=3");
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
    // Checkout filters (smudge/clean) select drivers via tracked
    // .gitattributes; pointing the attributes source at the empty tree
    // disables them.
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
    expect(prefix).toContain("ANTHROPIC_API_KEY= ");
  });
});
