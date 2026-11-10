import { describe, expect, it } from "bun:test";
import {
  PROJECT_ISOLATIONS,
  WORKSPACE_ISOLATIONS,
  isIsolationSupported,
  isolationFromRuntimeId,
  nearestSupportedIsolation,
  normalizeIsolationChoice,
  resolveDefaultIsolation,
  runtimeIdFromIsolation,
} from "./isolation";
import { RUNTIME_ENABLEMENT_IDS } from "./runtime";

describe("isolation ↔ runtime id mapping", () => {
  it.each(RUNTIME_ENABLEMENT_IDS.map((id) => [id]))("round-trips %s", (id) => {
    const choice = isolationFromRuntimeId(id);
    expect(isIsolationSupported(choice)).toBe(true);
    expect(runtimeIdFromIsolation(choice)).toBe(id);
  });

  it("maps every supported pair to a distinct runtime id that maps back to the pair", () => {
    const seen = new Set<string>();
    for (const project of PROJECT_ISOLATIONS) {
      for (const workspace of WORKSPACE_ISOLATIONS) {
        const id = runtimeIdFromIsolation({ project, workspace });
        if (id === null) continue;
        expect(seen.has(id)).toBe(false);
        seen.add(id);
        expect(isolationFromRuntimeId(id)).toEqual({ project, workspace });
      }
    }
    expect([...seen].sort()).toEqual([...RUNTIME_ENABLEMENT_IDS].sort());
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
