import { describe, expect, test } from "bun:test";
import type { Config } from "@/node/config";
import type { ProjectsConfig } from "@/common/types/project";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { isWorkspaceTrustedForSharedExecution } from "@/node/services/utils/workspaceTrust";
import {
  isProjectTrusted,
  isWorkspaceDirTrusted,
  isWorkspaceProjectTrusted,
  isWorkspaceProjectTrustedIn,
  secretsForWorkspace,
} from "./projectTrust";
import type { Secret } from "@/common/types/secrets";

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

// An SSH+None workspace runs in a host directory that is not the local project: it is trusted only
// when the project is trusted AND the user trusted that exact directory. An SSH worktree workspace
// runs in Xum's own synced checkout, so project trust alone covers it.
describe("SSH+None workspaces need their directory trusted", () => {
  const projectPath = "/repo/trusted";
  const subProjectPath = "/repo/trusted/sub";
  const directory = { host: "devbox", projectDir: "/home/me/app" };
  function projectsWith(project: Record<string, unknown>): ProjectsConfig["projects"] {
    return new Map<string, unknown>([
      [projectPath, project],
      [subProjectPath, { workspaces: [], parentProjectPath: projectPath }],
    ]) as unknown as ProjectsConfig["projects"];
  }
  const sshNone: RuntimeConfig = {
    type: "ssh",
    host: "devbox",
    srcBaseDir: "~/xum",
    workspaceIsolation: "none",
    projectDir: "/home/me/app",
  };
  const sshWorktree: RuntimeConfig = { type: "ssh", host: "devbox", srcBaseDir: "~/xum" };

  function metadataFor(runtimeConfig: RuntimeConfig, path = projectPath): WorkspaceMetadata {
    const metadata: WorkspaceMetadata = {
      id: "ws-1",
      name: "feature",
      projectName: "trusted",
      projectPath: path,
      runtimeConfig,
    };
    return metadata;
  }

  test.each([
    ["SSH+None, directory untrusted", sshNone, { trusted: true }, false],
    [
      "SSH+None, directory trusted",
      sshNone,
      { trusted: true, trustedSshDirectories: [directory] },
      true,
    ],
    // Directory trust applies only while the project itself is trusted.
    ["SSH+None, project untrusted", sshNone, { trustedSshDirectories: [directory] }, false],
    [
      "SSH+None, another directory trusted",
      sshNone,
      { trusted: true, trustedSshDirectories: [{ ...directory, projectDir: "/home/me/other" }] },
      false,
    ],
    ["SSH worktree", sshWorktree, { trusted: true }, true],
  ] as const)("%s", (_label, runtimeConfig, project, expected) => {
    const projects = projectsWith(project);
    const config = configWithProjects(projects as Map<string, { trusted?: boolean }>);
    const metadata = metadataFor(runtimeConfig);
    expect(isWorkspaceProjectTrusted(config, metadata)).toBe(expected);
    expect(isWorkspaceProjectTrustedIn(projects, metadata)).toBe(expected);
    expect(isWorkspaceTrustedForSharedExecution(metadata, projects)).toBe(expected);
  });

  test("a sub-project's SSH+None directory is trusted through its parent", () => {
    const projects = projectsWith({ trusted: true, trustedSshDirectories: [directory] });
    expect(isWorkspaceProjectTrustedIn(projects, metadataFor(sshNone, subProjectPath))).toBe(true);
    expect(isWorkspaceDirTrusted(projects, subProjectPath, sshNone)).toBe(true);
  });

  test.each([
    ["SSH+None, directory untrusted", sshNone, false, false],
    ["SSH+None, directory trusted", sshNone, true, true],
    ["SSH worktree", sshWorktree, false, true],
    ["local", { type: "local" } satisfies RuntimeConfig, false, true],
    ["unset", undefined, false, true],
  ] as const)("%s workspace project secrets", (_label, runtimeConfig, dirTrusted, expected) => {
    const projectSecrets: Secret[] = [{ key: "GH_TOKEN", value: "ghp_secret" }];
    const secretsStore = {
      getEffectiveSecrets: (path: string) => (path === projectPath ? projectSecrets : []),
    };
    const config = configWithProjects(
      projectsWith({
        trusted: true,
        ...(dirTrusted ? { trustedSshDirectories: [directory] } : {}),
      }) as Map<string, { trusted?: boolean }>
    );
    expect(secretsForWorkspace(secretsStore, config, projectPath, runtimeConfig)).toEqual(
      expected ? projectSecrets : []
    );
  });
});
