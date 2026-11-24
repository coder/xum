import { describe, expect, test } from "bun:test";
import {
  normalizeRepoRootProjectPath,
  resolveExecuteBashScript,
  selectRepoRootProject,
} from "./executeBashTargets";

describe("normalizeRepoRootProjectPath", () => {
  test.each([
    ["/repo/a/", "/repo/a"],
    ["  /repo/a  ", "/repo/a"],
    ["C:\\repo\\a\\", "C:/repo/a"],
    ["/repo/./a/../b", "/repo/b"],
    ["", ""],
    [null, ""],
    [undefined, ""],
  ])("%p -> %p", (input, expected) => {
    expect(normalizeRepoRootProjectPath(input)).toBe(expected);
  });
});

describe("resolveExecuteBashScript", () => {
  test("script mode runs the script unchanged", () => {
    expect(resolveExecuteBashScript("ls -la | wc -l", undefined, ["ignored"])).toEqual({
      success: true,
      data: "ls -la | wc -l",
    });
  });

  test("git command mode quotes every argument, so none is interpreted by the shell", () => {
    const result = resolveExecuteBashScript("", "git", ["log", "--format=%H %s", "$(rm -rf x)"]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.startsWith("'git' 'log' ")).toBe(true);
    expect(result.data).not.toContain(" $(rm");
  });

  test("git command mode without args runs bare git", () => {
    expect(resolveExecuteBashScript("", "git", undefined)).toEqual({
      success: true,
      data: "'git'",
    });
  });

  test("command mode refuses anything but git", () => {
    expect(resolveExecuteBashScript("", "rm", ["-rf", "/"]).success).toBe(false);
  });
});

describe("selectRepoRootProject", () => {
  const projects = [
    { projectPath: "/repos/first", id: "first" },
    { projectPath: "/repos/primary/", id: "primary" },
    { projectPath: "/repos/other", id: "other" },
  ];

  test("a requested project wins, compared in normalized form", () => {
    expect(selectRepoRootProject(projects, "/repos/other", "/repos/primary")?.id).toBe("other");
  });

  test("an unknown requested project selects nothing instead of falling back", () => {
    expect(selectRepoRootProject(projects, "/repos/missing", "/repos/primary")).toBeUndefined();
  });

  test("without a request the primary project is used", () => {
    expect(selectRepoRootProject(projects, "", "/repos/primary")?.id).toBe("primary");
  });

  test("without a request or a matching primary the first project is used", () => {
    expect(selectRepoRootProject(projects, "", "/repos/elsewhere")?.id).toBe("first");
    expect(selectRepoRootProject([], "", "/repos/primary")).toBeUndefined();
  });
});
