import { describe, expect, test } from "bun:test";
import type { ProjectsConfig } from "@/common/types/project";
import type { RuntimeConfig } from "@/common/types/runtime";
import { buildTargetWorkspaceAgentContext } from "@/node/services/workspaceTurnManager";

describe("buildTargetWorkspaceAgentContext", () => {
  const projectPath = "/repo/app";
  const sshNone: RuntimeConfig = {
    type: "ssh",
    host: "devbox",
    srcBaseDir: "~/xum",
    workspaceIsolation: "none",
    projectDir: "/srv/app",
  };
  const worktree: RuntimeConfig = { type: "worktree", srcBaseDir: "/home/me/xum" };
  const owner = { runtimeConfig: sshNone, name: "owner-ws" };
  const projectsWith = (project: Record<string, unknown>) =>
    new Map([
      [projectPath, { workspaces: [], ...project }],
    ]) as unknown as ProjectsConfig["projects"];

  test("a target without its own runtime runs on the owner's, and trust follows it", () => {
    const target = { projectPath, workspace: { path: "/srv/app", name: "child" } };

    const untrustedDir = buildTargetWorkspaceAgentContext(
      projectsWith({ trusted: true }),
      target,
      owner
    );
    expect(untrustedDir.runtimeConfig).toBe(sshNone);
    expect(untrustedDir.workspacePath).toBe("/srv/app");
    // The owner's SSH+None directory is untrusted, so the target's plugins stay off.
    expect(untrustedDir.projectPluginsTrusted).toBe(false);

    const trustedDir = buildTargetWorkspaceAgentContext(
      projectsWith({
        trusted: true,
        trustedSshDirectories: [{ host: "devbox", projectDir: "/srv/app" }],
      }),
      target,
      owner
    );
    expect(trustedDir.projectPluginsTrusted).toBe(true);
  });

  test("a target with its own runtime ignores the owner's directory trust", () => {
    const context = buildTargetWorkspaceAgentContext(
      projectsWith({ trusted: true }),
      { projectPath, workspace: { path: "", runtimeConfig: worktree } },
      owner
    );
    expect(context.runtimeConfig).toBe(worktree);
    expect(context.projectPluginsTrusted).toBe(true);
    // No persisted name: the checkout path falls back to the owner's workspace name.
    expect(context.workspacePath).toEndWith("/owner-ws");
  });
});
