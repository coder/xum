import { describe, expect, test } from "bun:test";
import type { Config } from "@/node/config";
import type { ProjectsConfig } from "@/common/types/project";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { isWorkspaceTrustedForSharedExecution } from "@/node/services/utils/workspaceTrust";
import {
  isProjectTrusted,
  isWorkspaceProjectTrusted,
  isWorkspaceProjectTrustedIn,
} from "./projectTrust";

function configWithProjects(projects: Map<string, { trusted?: boolean }>): Config {
  return { loadConfigOrDefault: () => ({ projects }) } as unknown as Config;
}

describe("isWorkspaceProjectTrusted", () => {
  test("treats scratch workspaces as trusted despite unregistered workdir projectPath", () => {
    const config = configWithProjects(new Map());
    const trusted = isWorkspaceProjectTrusted(config, {
      kind: "scratch",
      projectPath: "/home/user/.mux/scratch/ws-1",
      runtimeConfig: undefined,
    });
    expect(trusted).toBe(true);
    // The raw path lookup alone would report untrusted; that is the bug this
    // helper exists to fix.
    expect(isProjectTrusted(config, "/home/user/.mux/scratch/ws-1")).toBe(false);
  });

  test("falls back to config trust for regular workspaces", () => {
    const config = configWithProjects(
      new Map([
        ["/repo/trusted", { trusted: true }],
        ["/repo/untrusted", {}],
      ])
    );
    expect(
      isWorkspaceProjectTrusted(config, { projectPath: "/repo/trusted", runtimeConfig: undefined })
    ).toBe(true);
    expect(
      isWorkspaceProjectTrusted(config, {
        projectPath: "/repo/untrusted",
        runtimeConfig: undefined,
      })
    ).toBe(false);
  });
});

// Trust is keyed to the local project path; an SSH+None workspace runs in a host directory that
// trust does not cover, while an SSH worktree workspace runs in Xum's own synced checkout.
describe("SSH+None workspaces are outside project trust", () => {
  const projectPath = "/repo/trusted";
  const projects = new Map([
    [projectPath, { trusted: true }],
  ]) as unknown as ProjectsConfig["projects"];
  const config = configWithProjects(projects as Map<string, { trusted?: boolean }>);
  const sshNone: RuntimeConfig = {
    type: "ssh",
    host: "devbox",
    srcBaseDir: "~/xum",
    workspaceIsolation: "none",
    projectDir: "/home/me/app",
  };
  const sshWorktree: RuntimeConfig = { type: "ssh", host: "devbox", srcBaseDir: "~/xum" };

  function metadataFor(runtimeConfig: RuntimeConfig): WorkspaceMetadata {
    const metadata: WorkspaceMetadata = {
      id: "ws-1",
      name: "feature",
      projectName: "trusted",
      projectPath,
      runtimeConfig,
    };
    return metadata;
  }

  test.each([
    ["SSH+None", sshNone, false],
    ["SSH worktree", sshWorktree, true],
  ] as const)("%s workspace of a trusted project", (_label, runtimeConfig, expected) => {
    const metadata = metadataFor(runtimeConfig);
    expect(isWorkspaceProjectTrusted(config, metadata)).toBe(expected);
    expect(isWorkspaceProjectTrustedIn(projects, metadata)).toBe(expected);
    expect(isWorkspaceTrustedForSharedExecution(metadata, projects)).toBe(expected);
  });
});
