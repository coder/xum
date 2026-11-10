import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ISOLATION,
  PROJECT_ISOLATIONS,
  WORKSPACE_ISOLATIONS,
  isIsolationSupported,
  isolationFromRuntimeConfig,
  isolationFromRuntimeId,
  nearestSupportedIsolation,
  normalizeIsolationChoice,
  resolveDefaultIsolation,
  resolveEnabledIsolation,
  runtimeIdFromIsolation,
} from "./isolation";
import { DEFAULT_RUNTIME_ENABLEMENT, RUNTIME_ENABLEMENT_IDS } from "./runtime";

describe("resolveEnabledIsolation", () => {
  it("keeps the project axis and skips workspace isolations Settings disable", () => {
    const withoutWorktree = { ...DEFAULT_RUNTIME_ENABLEMENT, worktree: false };
    // Worktree is SSH's preferred pair, but it is disabled, so SSH+None is what gets created.
    expect(
      resolveEnabledIsolation({ project: "ssh", workspace: "docker" }, withoutWorktree)
    ).toEqual({ project: "ssh", workspace: "none" });
  });

  it("falls back to a Local pair when the project isolation has nothing enabled", () => {
    const coderNeedsWorktree = { ...DEFAULT_RUNTIME_ENABLEMENT, worktree: false };
    expect(
      resolveEnabledIsolation({ project: "coder", workspace: "worktree" }, coderNeedsWorktree)
    ).toEqual({ project: "local", workspace: "none" });
    expect(
      resolveEnabledIsolation(
        { project: "ssh", workspace: "worktree" },
        { ...DEFAULT_RUNTIME_ENABLEMENT, ssh: false }
      )
    ).toEqual({ project: "local", workspace: "worktree" });
  });
});

describe("isolation ↔ runtime id mapping", () => {
  it.each(RUNTIME_ENABLEMENT_IDS.map((id) => [id]))("round-trips %s", (id) => {
    const choice = isolationFromRuntimeId(id);
    expect(isIsolationSupported(choice)).toBe(true);
    expect(runtimeIdFromIsolation(choice)).toBe(id);
  });

  it("maps every supported pair to a runtime id on the same project axis", () => {
    const seen = new Set<string>();
    for (const project of PROJECT_ISOLATIONS) {
      for (const workspace of WORKSPACE_ISOLATIONS) {
        const id = runtimeIdFromIsolation({ project, workspace });
        if (id === null) continue;
        seen.add(id);
        // SSH+None shares the "ssh" runtime id; the id maps back to the pre-split default.
        expect(isolationFromRuntimeId(id).project).toBe(project);
      }
    }
    expect([...seen].sort()).toEqual([...RUNTIME_ENABLEMENT_IDS].sort());
    expect(isolationFromRuntimeId("ssh")).toEqual({ project: "ssh", workspace: "worktree" });
    expect(isIsolationSupported({ project: "ssh", workspace: "none" })).toBe(true);
  });
});

describe("isolationFromRuntimeConfig", () => {
  it("reads both axes from persisted runtime configs", () => {
    expect(isolationFromRuntimeConfig(undefined)).toEqual(DEFAULT_ISOLATION);
    expect(isolationFromRuntimeConfig({ type: "local" })).toEqual({
      project: "local",
      workspace: "none",
    });
    // Legacy worktree configs were written as "local" with a srcBaseDir.
    expect(isolationFromRuntimeConfig({ type: "local", srcBaseDir: "~/.mux/src" })).toEqual({
      project: "local",
      workspace: "worktree",
    });
    expect(isolationFromRuntimeConfig({ type: "ssh", host: "h", srcBaseDir: "~/mux" })).toEqual({
      project: "ssh",
      workspace: "worktree",
    });
    expect(
      isolationFromRuntimeConfig({
        type: "ssh",
        host: "h",
        srcBaseDir: "~/mux",
        workspaceIsolation: "none",
        projectDir: "~/src/app",
      })
    ).toEqual({ project: "ssh", workspace: "none" });
    expect(
      isolationFromRuntimeConfig({
        type: "ssh",
        host: "coder://",
        srcBaseDir: "~/mux",
        coder: { existingWorkspace: false },
      })
    ).toEqual({ project: "coder", workspace: "worktree" });
  });
});

describe("nearestSupportedIsolation", () => {
  it("keeps a supported pair unchanged", () => {
    expect(nearestSupportedIsolation({ project: "local", workspace: "docker" })).toEqual({
      project: "local",
      workspace: "docker",
    });
  });

  it("keeps the project axis and picks a supported workspace for unsupported pairs", () => {
    for (const project of PROJECT_ISOLATIONS) {
      for (const workspace of WORKSPACE_ISOLATIONS) {
        const nearest = nearestSupportedIsolation({ project, workspace });
        expect(nearest.project).toBe(project);
        expect(isIsolationSupported(nearest)).toBe(true);
      }
    }
    expect(nearestSupportedIsolation({ project: "ssh", workspace: "docker" })).toEqual({
      project: "ssh",
      workspace: "worktree",
    });
    expect(nearestSupportedIsolation({ project: "coder", workspace: "none" })).toEqual({
      project: "coder",
      workspace: "worktree",
    });
  });
});

describe("normalizeIsolationChoice", () => {
  it("accepts a known pair and drops extra keys", () => {
    expect(normalizeIsolationChoice({ project: "ssh", workspace: "worktree", extra: 1 })).toEqual({
      project: "ssh",
      workspace: "worktree",
    });
  });

  it.each([
    [undefined],
    [null],
    ["worktree"],
    [42],
    [[{ project: "local", workspace: "none" }]],
    [{}],
    [{ project: "local" }],
    [{ workspace: "none" }],
    [{ project: "mars", workspace: "none" }],
    [{ project: "local", workspace: "vm" }],
    [{ project: "LOCAL", workspace: "none" }],
    [{ project: 1, workspace: "none" }],
  ])("rejects %j", (value) => {
    expect(normalizeIsolationChoice(value)).toBeUndefined();
  });
});

describe("resolveDefaultIsolation", () => {
  it("prefers a valid isolation pair over the legacy runtime id", () => {
    expect(resolveDefaultIsolation({ project: "local", workspace: "none" }, "ssh")).toEqual({
      project: "local",
      workspace: "none",
    });
  });

  it("keeps an unsupported but well-formed pair", () => {
    expect(resolveDefaultIsolation({ project: "ssh", workspace: "docker" }, "worktree")).toEqual({
      project: "ssh",
      workspace: "docker",
    });
  });

  it("falls back to the legacy runtime id when the pair is missing or malformed", () => {
    expect(resolveDefaultIsolation(undefined, "ssh")).toEqual({
      project: "ssh",
      workspace: "worktree",
    });
    expect(resolveDefaultIsolation({ project: "mars", workspace: "none" }, "local")).toEqual({
      project: "local",
      workspace: "none",
    });
  });

  it("returns undefined when neither field is set", () => {
    expect(resolveDefaultIsolation(undefined, undefined)).toBeUndefined();
    expect(resolveDefaultIsolation("garbage", null)).toBeUndefined();
  });
});
