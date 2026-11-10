import { describe, expect, test } from "bun:test";
import { getCreationDraftStore } from "@/browser/stores/CreationDraftStore";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import type { ProjectConfig } from "@/common/types/project";
import { DEFAULT_RUNTIME_ENABLEMENT, type ParsedRuntime } from "@/common/types/runtime";
import { changeCreationDraftProject, projectDefaultIsolation } from "./creationDraftProject";

const PROJECTS = new Map<string, ProjectConfig>([
  ["/projects/a", { workspaces: [] }],
  ["/projects/open", { workspaces: [] }],
  ["/projects/no-local", { workspaces: [], runtimeEnablement: { local: false } }],
  ["/projects/a/sub", { workspaces: [], parentProjectPath: "/projects/a" }],
]);

function runtimeAfterMove(runtime: ParsedRuntime, target: string): ParsedRuntime | null {
  const store = getCreationDraftStore();
  const draftId = store.create("/projects/a", null);
  store.updateExecution(draftId, { runtime });
  changeCreationDraftProject(draftId, target, PROJECTS, DEFAULT_RUNTIME_ENABLEMENT);
  return store.getView(draftId).draft?.execution?.runtime ?? null;
}

describe("changeCreationDraftProject", () => {
  // Local and Worktree need no host, so they travel; the target's Settings may still forbid them.
  test.each([
    { runtime: { mode: "worktree" } as const, target: "/projects/open", kept: true },
    { runtime: { mode: "local" } as const, target: "/projects/open", kept: true },
    { runtime: { mode: "local" } as const, target: "/projects/no-local", kept: false },
    { runtime: { mode: "worktree" } as const, target: SCRATCH_PROJECT_CONFIG_KEY, kept: false },
  ])("$runtime.mode to $target kept: $kept", ({ runtime, target, kept }) => {
    expect(runtimeAfterMove(runtime, target)).toEqual(kept ? runtime : null);
  });

  // A sub-project is the same repository: its host and trunk still apply.
  test("a sub-project of the same repository keeps the runtime and trunk", () => {
    const store = getCreationDraftStore();
    const draftId = store.create("/projects/a", null);
    const choices = { runtime: { mode: "ssh", host: "a-host" } as const, trunkBranch: "main" };
    store.updateExecution(draftId, choices);
    changeCreationDraftProject(draftId, "/projects/a/sub", PROJECTS, DEFAULT_RUNTIME_ENABLEMENT);
    expect(store.getView(draftId).draft).toMatchObject({
      subProjectPath: "/projects/a/sub",
      execution: choices,
    });
  });
});

describe("projectDefaultIsolation", () => {
  const sshWorktree = { project: "ssh", workspace: "worktree" } as const;

  test("a project that disables Worktree starts an inherited SSH x Worktree default on SSH x None", () => {
    // Settings shows SSH x None here; starting on SSH x Worktree made creation fall back to Local.
    const project: ProjectConfig = { workspaces: [], runtimeEnablement: { worktree: false } };
    expect(projectDefaultIsolation(project, sshWorktree, DEFAULT_RUNTIME_ENABLEMENT)).toEqual({
      project: "ssh",
      workspace: "none",
    });
  });

  test("the project's own default wins only while it overrides Settings", () => {
    const localDocker = { project: "local", workspace: "docker" } as const;
    const overriding: ProjectConfig = { workspaces: [], defaultIsolation: localDocker };
    expect(projectDefaultIsolation(overriding, sshWorktree, DEFAULT_RUNTIME_ENABLEMENT)).toEqual(
      localDocker
    );
    expect(projectDefaultIsolation(undefined, sshWorktree, DEFAULT_RUNTIME_ENABLEMENT)).toEqual(
      sshWorktree
    );
  });

  test("global Settings apply to a project without overrides", () => {
    const noSsh = { ...DEFAULT_RUNTIME_ENABLEMENT, ssh: false };
    expect(projectDefaultIsolation({ workspaces: [] }, sshWorktree, noSsh)).toEqual({
      project: "local",
      workspace: "worktree",
    });
  });
});
