import { expect, test } from "bun:test";
import { appAi, containerEnv, outputDir } from "./launch";

test("the container env holds the allowlisted names, the fixed values and no host secret", () => {
  const host = {
    BUGBASH_AI_RESOLVED: "mock",
    BUGBASH_MODEL: "anthropic:claude-sonnet-5-5",
    ANTHROPIC_API_KEY: "sk-ant-real",
    OPENAI_API_KEY: "sk-real",
    GH_TOKEN: "ghp_real",
    XUM_SERVER_AUTH_TOKEN: "real",
    HOME: "/home/alice",
    PATH: "/usr/bin",
    TMPDIR: "/home/alice/tmp",
  };
  expect(containerEnv(host, { BUGBASH_APP_LOG: ".e2e/run/app.log" })).toEqual({
    HOME: "/home/bugbash",
    TMPDIR: "/tmp",
    BUGBASH_CONTAINER: "1",
    BUGBASH_AI_RESOLVED: "mock",
    BUGBASH_MODEL: "anthropic:claude-sonnet-5-5",
    BUGBASH_APP_LOG: ".e2e/run/app.log",
  });
});

test("a credential from a caller is refused, not passed", () => {
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_BASE_URL", "GH_TOKEN"]) {
    expect(() => containerEnv({}, { [name]: "x" })).toThrow("no credential enters the sandbox");
  }
});

test("the export comes back only to one folder under .e2e", () => {
  expect(outputDir(["run", "--output", ".e2e/repros", "--grep", "x"])).toBe(".e2e/repros");
  expect(outputDir(["run", "--output=.e2e/runs/one"])).toBe(".e2e/runs/one");
  for (const args of [
    ["run"],
    ["run", "--output"],
    ["run", "--output", ".e2e/a", "--output", ".e2e/b"],
    ["run", "--output", ".e2e"],
    ["run", "--output", ".e2e/../escape"],
    ["run", "--output", ".e2e/./a"],
    ["run", "--output", "/tmp/escape"],
    ["run", "--output", "../.e2e/escape"],
    ["run", "--output", ".e2e/a b"],
  ]) {
    expect(() => outputDir(args)).toThrow("exactly one --output");
  }
});

test("the launcher reads the app AI mode the way e2e.config.ts does", () => {
  expect(appAi({ BUGBASH_AI: "mock" })).toBe("mock");
  expect(appAi({ BUGBASH_AI: "mock", BUGBASH_AI_RESOLVED: "real" })).toBe("real");
  expect(appAi({ BUGBASH_AI: "auto" })).toBeUndefined();
});
