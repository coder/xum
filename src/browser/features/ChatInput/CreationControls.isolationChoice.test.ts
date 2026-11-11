import { describe, expect, test } from "bun:test";
import {
  CODER_RUNTIME_PLACEHOLDER,
  DEFAULT_RUNTIME_ENABLEMENT,
  type ParsedRuntime,
} from "@/common/types/runtime";
import { buildWorkspaceIsolationOptions, runtimeForIsolationChoice } from "./CreationControls";
import type { RuntimeAvailabilityMap } from "./useCreationWorkspace";

const coderConfigFallback = { existingWorkspace: false };

function contextFor(
  selectedRuntime: ParsedRuntime,
  overrides: Partial<Parameters<typeof runtimeForIsolationChoice>[1]> = {}
): Parameters<typeof runtimeForIsolationChoice>[1] {
  return {
    runtimeChoiceContext: {
      selectedRuntime,
      sshHostFallback: "last-host",
      coderConfigFallback,
      runtimeAvailabilityState: { status: "loading" },
    },
    runtimeEnablement: undefined,
    coderAvailable: true,
    ...overrides,
  };
}

describe("runtimeForIsolationChoice", () => {
  test("switching to SSH+None asks the draft to refill the remembered directory", () => {
    expect(
      runtimeForIsolationChoice(
        { project: "ssh", workspace: "none" },
        contextFor({ mode: "local" })
      )
    ).toEqual({ mode: "ssh", host: "last-host", workspaceIsolation: "none", projectDir: "" });
  });

  test("staying on SSH+None keeps the host and the typed directory", () => {
    const current: ParsedRuntime = {
      mode: "ssh",
      host: "box",
      workspaceIsolation: "none",
      projectDir: "/srv/app",
    };
    expect(
      runtimeForIsolationChoice({ project: "ssh", workspace: "none" }, contextFor(current))
    ).toEqual({ mode: "ssh", host: "box", workspaceIsolation: "none", projectDir: "/srv/app" });
  });

  test("SSH with a worktree drops the SSH+None fields", () => {
    const current: ParsedRuntime = {
      mode: "ssh",
      host: "box",
      workspaceIsolation: "none",
      projectDir: "/srv/app",
    };
    expect(
      runtimeForIsolationChoice({ project: "ssh", workspace: "worktree" }, contextFor(current))
    ).toEqual({ mode: "ssh", host: "box" });
  });

  test("an unsupported pair snaps to the nearest pair of the picked project", () => {
    expect(
      runtimeForIsolationChoice(
        { project: "ssh", workspace: "docker" },
        contextFor({ mode: "local" })
      )
    ).toEqual({ mode: "ssh", host: "last-host" });
  });

  test("a pair Settings disable falls back to an enabled one", () => {
    const runtimeEnablement = { ...DEFAULT_RUNTIME_ENABLEMENT, ssh: false };
    expect(
      runtimeForIsolationChoice(
        { project: "ssh", workspace: "worktree" },
        contextFor({ mode: "local" }, { runtimeEnablement })
      )
    ).toEqual({ mode: "worktree" });
  });

  test("Coder applies only when its controls are available", () => {
    const coder = { project: "coder", workspace: "worktree" } as const;
    expect(
      runtimeForIsolationChoice(coder, contextFor({ mode: "local" }, { coderAvailable: false }))
    ).toBeNull();
    expect(runtimeForIsolationChoice(coder, contextFor({ mode: "local" }))).toEqual({
      mode: "ssh",
      host: CODER_RUNTIME_PLACEHOLDER,
      coder: coderConfigFallback,
    });
  });
});

describe("buildWorkspaceIsolationOptions", () => {
  // A non-git local project: SSH can't sync a worktree from it, but SSH x None needs no repo.
  const availabilityMap = {
    local: { available: true },
    worktree: { available: false, reason: "Requires git repository" },
    ssh: { available: false, reason: "Requires git repository" },
    docker: { available: false, reason: "Requires git repository" },
    devcontainer: { available: false, reason: "No devcontainer.json found" },
  } satisfies RuntimeAvailabilityMap;

  function disabledReasons(project: "local" | "ssh") {
    const options = buildWorkspaceIsolationOptions({
      current: { project, workspace: "none" },
      availabilityMap,
      runtimeAvailabilityState: { status: "loaded", data: availabilityMap },
      runtimeEnablement: DEFAULT_RUNTIME_ENABLEMENT,
      coderAvailability: { state: "available", shouldShowRuntimeButton: true },
    });
    return Object.fromEntries(options.map((option) => [option.value, option.disabledReason]));
  }

  test("SSH x None on a non-git project disables SSH x Worktree instead of moving to Local", () => {
    const reasons = disabledReasons("ssh");
    expect(reasons.none).toBeNull();
    expect(reasons.worktree).toBe("Requires git repository");
  });

  test("local pairs report their own availability", () => {
    const reasons = disabledReasons("local");
    expect(reasons.none).toBeNull();
    expect(reasons.worktree).toBe("Requires git repository");
  });
});
