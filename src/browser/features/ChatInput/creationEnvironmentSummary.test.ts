import { describe, expect, test } from "bun:test";
import type { IsolationChoice } from "@/common/types/isolation";
import type { ParsedRuntime } from "@/common/types/runtime";
import {
  describeEnvironment,
  summarizeEnvironment,
  type EnvironmentSummaryInput,
} from "./creationEnvironmentSummary";

function input(
  selectedRuntime: ParsedRuntime,
  isolation: IsolationChoice,
  overrides: Partial<EnvironmentSummaryInput> = {}
): EnvironmentSummaryInput {
  return {
    selectedRuntime,
    isolation,
    trunkBranch: "main",
    branchLoad: "loaded",
    isNonGitRepo: false,
    fieldError: null,
    ...overrides,
  };
}

const WORKTREE: IsolationChoice = { project: "local", workspace: "worktree" };
const LOCAL: IsolationChoice = { project: "local", workspace: "none" };
const SSH_WORKTREE: IsolationChoice = { project: "ssh", workspace: "worktree" };
const SSH_NONE: IsolationChoice = { project: "ssh", workspace: "none" };
const SSH_NONE_RUNTIME: ParsedRuntime = {
  mode: "ssh",
  host: "devbox",
  workspaceIsolation: "none",
  projectDir: "~/app",
};

describe("summarizeEnvironment", () => {
  test("a runtime that builds no checkout hides the base branch", () => {
    expect(summarizeEnvironment(input({ mode: "local" }, LOCAL)).branch).toEqual({
      kind: "hidden",
    });
    expect(summarizeEnvironment(input(SSH_NONE_RUNTIME, SSH_NONE)).branch).toEqual({
      kind: "hidden",
    });
  });

  test("a project without git hides the base branch even for a worktree", () => {
    const summary = summarizeEnvironment(
      input({ mode: "worktree" }, WORKTREE, { isNonGitRepo: true })
    );
    expect(summary.branch).toEqual({ kind: "hidden" });
  });

  test("the base branch follows the list's load state", () => {
    const branchFor = (overrides: Partial<EnvironmentSummaryInput>) =>
      summarizeEnvironment(input({ mode: "worktree" }, WORKTREE, overrides)).branch;
    expect(branchFor({ branchLoad: "loading" })).toEqual({ kind: "loading" });
    // A failed list must not look like a selected branch: Send stays off (#6055).
    expect(branchFor({ branchLoad: "failed" })).toEqual({ kind: "failed" });
    expect(branchFor({})).toEqual({ kind: "selected", name: "main" });
    expect(branchFor({ trunkBranch: "" })).toEqual({ kind: "loading" });
  });

  test("SSH shows its host once one is entered, and the shared directory without isolation", () => {
    expect(summarizeEnvironment(input({ mode: "ssh", host: "" }, SSH_WORKTREE)).where).toBe("SSH");
    expect(summarizeEnvironment(input({ mode: "ssh", host: " devbox " }, SSH_WORKTREE)).where).toBe(
      "devbox"
    );
    expect(summarizeEnvironment(input(SSH_NONE_RUNTIME, SSH_NONE)).isolation).toBe("~/app");
    expect(
      summarizeEnvironment(input({ ...SSH_NONE_RUNTIME, projectDir: "" }, SSH_NONE)).isolation
    ).toBe("Directory on host");
  });

  test("an SSH field error on Coder names the Coder form, not a host", () => {
    const coder: ParsedRuntime = { mode: "ssh", host: "coder", coder: {} };
    expect(
      summarizeEnvironment(
        input(coder, { project: "coder", workspace: "worktree" }, { fieldError: "ssh" })
      ).error
    ).toBe("Coder workspace incomplete");
    expect(
      summarizeEnvironment(input({ mode: "ssh", host: "" }, SSH_WORKTREE, { fieldError: "ssh" }))
        .error
    ).toBe("SSH host missing");
  });
});

describe("describeEnvironment", () => {
  test("names the branch only when one applies and is selected", () => {
    expect(describeEnvironment(input({ mode: "worktree" }, WORKTREE))).toBe(
      "New workspaces run on this machine, in a separate git worktree, branched from main."
    );
    expect(describeEnvironment(input({ mode: "local" }, LOCAL))).toBe(
      "New workspaces run on this machine, directly in the project directory."
    );
    expect(
      describeEnvironment(input({ mode: "worktree" }, WORKTREE, { branchLoad: "failed" }))
    ).toBe("New workspaces run on this machine, in a separate git worktree.");
  });
});
