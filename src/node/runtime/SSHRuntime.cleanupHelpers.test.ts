import { describe, expect, it } from "bun:test";
import { buildOrphanedBranchDeleteScript, describeForkFinalizeFailure } from "./SSHRuntime";

describe("buildOrphanedBranchDeleteScript", () => {
  const base = {
    baseRepoPathArg: "'/home/u/mux/proj/.mux-base.git'",
    branch: "feature",
    noHooksPrefix: "NHP ",
  };

  it("neutralizes HEAD before deleting the branch in a Xum-managed base repo", () => {
    const lines = buildOrphanedBranchDeleteScript({
      ...base,
      baseRepoPath: "/home/u/mux/proj/.mux-base.git",
    }).split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("symbolic-ref HEAD");
    expect(lines[1]).toStartWith("NHP git -C");
    expect(lines[1]).toContain("branch -D 'feature'");
  });

  it("never rewrites HEAD of a repo that is not a managed base repo", () => {
    // A worktree can resolve its common dir to a user's real checkout; its HEAD must stay put.
    const script = buildOrphanedBranchDeleteScript({
      ...base,
      baseRepoPath: "/home/u/code/proj/.git",
    });

    expect(script).not.toContain("symbolic-ref");
    expect(script).toContain("branch -D 'feature'");
  });
});

describe("describeForkFinalizeFailure", () => {
  const labels = { step: "mv", subject: "workspace" };

  it("reports a collision so the user picks another name", () => {
    const failure = describeForkFinalizeFailure(
      { stdout: "MUX_FORK_COLLISION\n", stderr: "ignored" },
      "/srv/proj/feat",
      labels
    );

    expect(failure.cleanupReason).toContain("finalize collision");
    expect(failure.error).toContain("/srv/proj/feat was created by another process");
  });

  it("reports the move's stderr, falling back to stdout", () => {
    const fromStderr = describeForkFinalizeFailure(
      { stdout: "out", stderr: " permission denied \n" },
      "/srv/proj/feat",
      { step: "worktree move", subject: "worktree" }
    );
    expect(fromStderr.cleanupReason).toBe("worktree move failed: permission denied");
    expect(fromStderr.error).toBe("Failed to finalize forked worktree:  permission denied \n");

    const fromStdout = describeForkFinalizeFailure(
      { stdout: "MUX_FORK_MV_FAILED", stderr: "" },
      "/srv/proj/feat",
      labels
    );
    expect(fromStdout.cleanupReason).toBe("mv failed: MUX_FORK_MV_FAILED");
    expect(fromStdout.error).toBe("Failed to finalize forked workspace: MUX_FORK_MV_FAILED");
  });
});
