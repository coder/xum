import { describe, expect, test } from "bun:test";
import type { ProjectConfig } from "@/common/types/project";
import {
  deriveProjectHierarchy,
  formatProjectHierarchyLabel,
  getFirstTopLevelProjectPath,
  getSubProjectsForParent,
  getTopLevelProjectEntries,
  isPathDescendant,
  resolveWorkspaceCreationScope,
} from "./subProjects";

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return { workspaces: [], ...overrides };
}

describe("subProjects", () => {
  test("detects only boundary-safe descendants", () => {
    expect(isPathDescendant("/repo", "/repo/packages/api")).toBe(true);
    expect(isPathDescendant("/repo", "/repo-sibling")).toBe(false);
    expect(isPathDescendant("/repo", "/repo")).toBe(false);
  });

  // #5917: a root project restored from an older config must not adopt every project.
  test("never treats the filesystem root as a parent project", () => {
    expect(isPathDescendant("/", "/repo")).toBe(false);
    expect(isPathDescendant("//", "/repo/packages/api")).toBe(false);
    expect(
      deriveProjectHierarchy(
        new Map<string, ProjectConfig>([
          ["/", project()],
          ["/repo", project()],
        ])
      ).get("/repo")?.parentProjectPath
    ).toBeUndefined();
  });

  // #5919: a drive-root or UNC share-root project from an older config must not adopt every
  // project on that drive or share.
  test("never treats a Windows drive root as a parent project", () => {
    for (const driveRoot of ["C:\\", "C:/", "C:", "c:\\\\"]) {
      expect(isPathDescendant(driveRoot, "C:\\repo")).toBe(false);
    }
    const derived = deriveProjectHierarchy(
      new Map<string, ProjectConfig>([
        ["C:\\", project()],
        ["C:\\repo", project()],
      ])
    );
    expect(derived.get("C:\\repo")?.parentProjectPath).toBeUndefined();
  });

  test("never treats a UNC share root as a parent project", () => {
    for (const shareRoot of ["\\\\srv\\share\\", "\\\\srv\\share", "//srv/share/"]) {
      expect(isPathDescendant(shareRoot, "\\\\srv\\share\\repo")).toBe(false);
    }
    const derived = deriveProjectHierarchy(
      new Map<string, ProjectConfig>([
        ["\\\\srv\\share", project()],
        ["\\\\srv\\share\\repo", project()],
      ])
    );
    expect(derived.get("\\\\srv\\share\\repo")?.parentProjectPath).toBeUndefined();
  });

  test("still nests Windows projects under a non-root Windows parent", () => {
    expect(isPathDescendant("C:\\a", "C:\\a\\b")).toBe(true);
    // "/:" is a POSIX directory, not a drive root.
    expect(isPathDescendant("/:", "/:/repo")).toBe(true);
    expect(isPathDescendant("\\\\srv\\share\\a", "\\\\srv\\share\\a\\b")).toBe(true);
  });

  test("treats Windows drive-letter paths as case-insensitive", () => {
    expect(isPathDescendant("C:\\Repo", "c:\\repo\\packages\\api")).toBe(true);
  });

  test("treats Windows UNC paths as case-insensitive", () => {
    expect(
      isPathDescendant("\\\\server\\share\\Repo", "\\\\SERVER\\Share\\repo\\packages\\api")
    ).toBe(true);
  });

  test("derives one-level parentage from registered project paths", () => {
    const projects = new Map<string, ProjectConfig>([
      ["/repo", project()],
      ["/repo/packages/api", project()],
      ["/repo/packages/api/nested", project()],
    ]);

    const derived = deriveProjectHierarchy(projects);

    expect(derived.get("/repo")?.parentProjectPath).toBeUndefined();
    expect(derived.get("/repo/packages/api")?.parentProjectPath).toBe("/repo");
    expect(derived.get("/repo/packages/api/nested")?.parentProjectPath).toBe("/repo");
  });

  test("clears stale parent pointers for top-level projects", () => {
    const projects = deriveProjectHierarchy(
      new Map<string, ProjectConfig>([["/repo", project({ parentProjectPath: "/stale" })]])
    );

    expect(projects.get("/repo")?.parentProjectPath).toBeUndefined();
  });

  test("does not depend on insertion order for nested existing paths", () => {
    const projects = deriveProjectHierarchy(
      new Map<string, ProjectConfig>([
        ["/repo", project()],
        ["/repo/packages/api/nested", project()],
        ["/repo/packages/api", project()],
      ])
    );

    expect(projects.get("/repo/packages/api")?.parentProjectPath).toBe("/repo");
    expect(projects.get("/repo/packages/api/nested")?.parentProjectPath).toBe("/repo");
  });

  test("returns top-level projects without sub-project entries", () => {
    const projects = new Map<string, ProjectConfig>([
      ["/repo/packages/api", project({ parentProjectPath: "/repo" })],
      ["/repo", project()],
      ["/other", project()],
    ]);

    expect(getTopLevelProjectEntries(projects).map(([path]) => path)).toEqual(["/repo", "/other"]);
    expect(getFirstTopLevelProjectPath(projects)).toBe("/repo");
  });

  test("resolves workspace creation scope to the parent plus optional sub-project", () => {
    const projects = new Map<string, ProjectConfig>([
      ["/repo", project()],
      ["/repo/packages/api", project({ parentProjectPath: "/repo" })],
      ["/other", project()],
      ["/other/packages/web", project({ parentProjectPath: "/other" })],
    ]);

    expect(resolveWorkspaceCreationScope("/repo/packages/api", projects)).toEqual({
      projectPath: "/repo",
      subProjectPath: "/repo/packages/api",
    });
    expect(resolveWorkspaceCreationScope("/repo", projects, "/repo/packages/api")).toEqual({
      projectPath: "/repo",
      subProjectPath: "/repo/packages/api",
    });
    expect(resolveWorkspaceCreationScope("/repo", projects, "/other/packages/web")).toEqual({
      projectPath: "/repo",
      subProjectPath: null,
    });
  });

  test("orders sub-projects by display name and labels them with parent context", () => {
    const projects = deriveProjectHierarchy(
      new Map<string, ProjectConfig>([
        ["/repo", project({ displayName: "Xum" })],
        ["/repo/packages/web", project({ displayName: "Web" })],
        ["/repo/packages/api", project({ displayName: "API" })],
      ])
    );

    expect(getSubProjectsForParent("/repo", projects).map(([path]) => path)).toEqual([
      "/repo/packages/api",
      "/repo/packages/web",
    ]);
    expect(formatProjectHierarchyLabel("/repo/packages/api", projects)).toBe("Xum / API");
  });
});
