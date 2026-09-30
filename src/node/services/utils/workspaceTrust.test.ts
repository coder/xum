import { describe, expect, test } from "bun:test";
import type { ProjectsConfig } from "@/common/types/project";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { isWorkspaceTrustedForSharedExecution } from "./workspaceTrust";

const baseMetadata: WorkspaceMetadata = {
  id: "ws-1",
  name: "ws-1",
  projectName: "proj",
  projectPath: "/repo/proj",
  runtimeConfig: { type: "local" },
};

describe("isWorkspaceTrustedForSharedExecution", () => {
  test("treats scratch workspaces as trusted despite unregistered workdir projectPath", () => {
    const projects: ProjectsConfig["projects"] = new Map();
    const scratch: WorkspaceMetadata = {
      ...baseMetadata,
      kind: "scratch",
      projectPath: "/home/user/.mux/scratch/ws-1",
    };
    expect(isWorkspaceTrustedForSharedExecution(scratch, projects)).toBe(true);
  });

  test("single-project workspaces follow the config trust flag", () => {
    const projects: ProjectsConfig["projects"] = new Map([
      ["/repo/proj", { workspaces: [], trusted: true }],
    ]);
    expect(isWorkspaceTrustedForSharedExecution(baseMetadata, projects)).toBe(true);
    projects.set("/repo/proj", { workspaces: [] });
    expect(isWorkspaceTrustedForSharedExecution(baseMetadata, projects)).toBe(false);
  });

  test("multi-project workspaces require every project to be trusted", () => {
    const projects: ProjectsConfig["projects"] = new Map([
      ["/repo/a", { workspaces: [], trusted: true }],
      ["/repo/b", { workspaces: [] }],
    ]);
    const multi: WorkspaceMetadata = {
      ...baseMetadata,
      projects: [
        { projectPath: "/repo/a", projectName: "a" },
        { projectPath: "/repo/b", projectName: "b" },
      ],
    };
    expect(isWorkspaceTrustedForSharedExecution(multi, projects)).toBe(false);
    projects.set("/repo/b", { workspaces: [], trusted: true });
    expect(isWorkspaceTrustedForSharedExecution(multi, projects)).toBe(true);
  });
});
