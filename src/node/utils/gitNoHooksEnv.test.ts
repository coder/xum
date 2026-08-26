import { afterEach, describe, test, expect } from "bun:test";
import { GIT_NO_HOOKS_ENV, gitHooksAllowed, gitNoHooksPrefix } from "./gitNoHooksEnv";

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
    expect(prefix).toContain("GIT_CONFIG_COUNT=1");
    expect(prefix).toContain("core.hooksPath");
    expect(prefix).toContain("/dev/null");
    expect(prefix).toContain("GIT_CONFIG_PARAMETERS=");
    expect(prefix).toEndWith(" ");
  });

  test("returns env prefix when untrusted (undefined)", () => {
    const prefix = gitNoHooksPrefix(undefined);
    expect(prefix).toContain("GIT_CONFIG_COUNT=1");
    expect(prefix).toEndWith(" ");
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
    expect(gitNoHooksPrefix(true)).toContain("core.hooksPath");
  });
});
