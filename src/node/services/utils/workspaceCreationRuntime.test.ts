import { describe, expect, it } from "bun:test";
import type { RuntimeConfig } from "@/common/types/runtime";
import {
  creationRuntimeConfigError,
  sshProjectDirConfigToResolve,
} from "./workspaceCreationRuntime";

const sshNone = (projectDir?: string): RuntimeConfig => ({
  type: "ssh",
  host: "box",
  srcBaseDir: "~/mux",
  workspaceIsolation: "none",
  ...(projectDir !== undefined ? { projectDir } : {}),
});
const sshWorktree: RuntimeConfig = { type: "ssh", host: "box", srcBaseDir: "~/mux" };

describe("creationRuntimeConfigError", () => {
  it("refuses SSH+None without a project directory", () => {
    expect(creationRuntimeConfigError(sshNone(undefined), "main")).toContain(
      "project directory on the SSH host"
    );
    expect(creationRuntimeConfigError(sshNone("   "), "main")).toContain(
      "project directory on the SSH host"
    );
  });

  it("needs no trunk branch for runtimes that run in an existing directory", () => {
    expect(creationRuntimeConfigError({ type: "local" }, "")).toBeNull();
    expect(creationRuntimeConfigError(sshNone("/srv/app"), "")).toBeNull();
  });

  it("requires a trunk branch for runtimes that build a checkout", () => {
    expect(creationRuntimeConfigError(sshWorktree, "")).toBe(
      "Trunk branch is required for worktree and SSH runtimes"
    );
    expect(creationRuntimeConfigError(sshWorktree, "main")).toBeNull();
  });
});

describe("sshProjectDirConfigToResolve", () => {
  const reachable = { createFlags: undefined };

  it("returns the SSH+None config whose directory the host should resolve", () => {
    expect(sshProjectDirConfigToResolve(sshNone("~/app"), reachable)?.projectDir).toBe("~/app");
  });

  it("skips other runtimes, a missing directory, and runtimes not reachable yet", () => {
    expect(sshProjectDirConfigToResolve(sshWorktree, reachable)).toBeNull();
    expect(sshProjectDirConfigToResolve(sshNone(undefined), reachable)).toBeNull();
    expect(
      sshProjectDirConfigToResolve(sshNone("~/app"), {
        createFlags: { deferredRuntimeAccess: true },
      })
    ).toBeNull();
  });
});
