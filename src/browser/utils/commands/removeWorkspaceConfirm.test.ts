import { describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "@/common/types/runtime";
import {
  getWorkspaceRemovalKind,
  removeWorkspaceConfirmOptions,
  type WorkspaceRemovalKind,
} from "./removeWorkspaceConfirm";

const ssh: RuntimeConfig = { type: "ssh", host: "build-box", srcBaseDir: "~/xum" };
const createdCoder: RuntimeConfig = {
  ...ssh,
  host: "dev-box.mux--coder",
  coder: { workspaceName: "dev-box" },
};
const existingCoder: RuntimeConfig = {
  ...createdCoder,
  coder: { workspaceName: "dev-box", existingWorkspace: true },
};

describe("getWorkspaceRemovalKind (#5204)", () => {
  const cases: Array<[string, RuntimeConfig | undefined, WorkspaceRemovalKind]> = [
    ["no runtime config (default worktree)", undefined, "worktree"],
    ["worktree", { type: "worktree", srcBaseDir: "~/.xum/src" }, "worktree"],
    ["legacy local with srcBaseDir", { type: "local", srcBaseDir: "~/.xum/src" }, "worktree"],
    ["project-dir local", { type: "local" }, "localProject"],
    ["plain SSH", ssh, "ssh"],
    ["Coder workspace Xum created", createdCoder, "coder"],
    ["existing Coder workspace", existingCoder, "ssh"],
    ["Coder config without a workspace name", { ...ssh, coder: {} }, "ssh"],
    ["Coder config with an empty workspace name", { ...ssh, coder: { workspaceName: "" } }, "ssh"],
    ["Docker", { type: "docker", image: "node:22" }, "docker"],
    ["devcontainer", { type: "devcontainer", configPath: ".devcontainer.json" }, "devcontainer"],
  ];
  for (const [label, runtimeConfig, kind] of cases) {
    test(label, () => {
      expect(getWorkspaceRemovalKind({ name: "feature", runtimeConfig })).toBe(kind);
    });
  }

  test("a runtime type from a newer Xum still gets a confirmation instead of throwing", () => {
    // Config publishes such workspaces with incompatibleRuntime; the type is outside the schema.
    const futureRuntime = JSON.parse('{"type":"future-runtime"}') as RuntimeConfig;
    expect(getWorkspaceRemovalKind({ name: "feature", runtimeConfig: futureRuntime })).toBe(
      "unknown"
    );
  });

  test("a scratch chat is classified by its kind, not its local runtime", () => {
    expect(
      getWorkspaceRemovalKind({ name: "chat", runtimeConfig: { type: "local" }, kind: "scratch" })
    ).toBe("scratch");
  });

  test("several projects win over the runtime type", () => {
    expect(
      getWorkspaceRemovalKind({
        name: "feature",
        runtimeConfig: { type: "local" },
        projects: [1, 2],
      })
    ).toBe("multiProject");
    // A one-project list is an ordinary workspace.
    expect(getWorkspaceRemovalKind({ name: "feature", runtimeConfig: ssh, projects: [1] })).toBe(
      "ssh"
    );
  });
});

describe("removeWorkspaceConfirmOptions names the runtime's resource", () => {
  const describeRemoval = (runtimeConfig: RuntimeConfig | undefined) =>
    removeWorkspaceConfirmOptions("Remove?", { name: "feature", runtimeConfig }).description;

  test("every removal kind gets its own description", () => {
    const descriptions = [
      describeRemoval(undefined),
      describeRemoval({ type: "local" }),
      describeRemoval(ssh),
      describeRemoval(createdCoder),
      describeRemoval({ type: "docker", image: "node:22" }),
      describeRemoval({ type: "devcontainer", configPath: ".devcontainer.json" }),
      removeWorkspaceConfirmOptions("Remove?", { name: "feature", projects: [1, 2] }).description,
      removeWorkspaceConfirmOptions("Remove?", { name: "feature", kind: "scratch" }).description,
    ];
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  test("SSH names the host; Coder names the Coder workspace, not its SSH alias", () => {
    expect(describeRemoval(ssh)).toContain("build-box");
    for (const coder of [createdCoder, existingCoder]) {
      expect(describeRemoval(coder)).toContain('"dev-box"');
      expect(describeRemoval(coder)).not.toContain("mux--coder");
    }
    // Only the Coder workspace Xum created is deleted; an existing one is kept.
    expect(describeRemoval(existingCoder)).not.toBe(describeRemoval(createdCoder));
  });

  test("the multi-project description counts the projects", () => {
    const describeProjects = (count: number) =>
      removeWorkspaceConfirmOptions("Remove?", {
        name: "feature",
        projects: Array.from({ length: count }, (_, i) => i),
      }).description;
    expect(describeProjects(3)).toContain("3");
    expect(describeProjects(2)).not.toBe(describeProjects(3));
  });
});
