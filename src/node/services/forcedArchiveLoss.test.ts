import { describe, expect, test } from "bun:test";

import {
  describeForcedArchiveLoss,
  describeForcedLossBeforeFailure,
  forcedArchiveAcknowledgements,
  forcedArchivePaths,
  sameForcedArchiveLoss,
  type ForcedArchiveLoss,
} from "./forcedArchiveLoss";

function loss(overrides: Partial<ForcedArchiveLoss> = {}): ForcedArchiveLoss {
  return { targetPaths: [], subagents: [], deletedSubagentCheckouts: [], ...overrides };
}

describe("forcedArchiveAcknowledgements", () => {
  test("acknowledges exactly the listed files, per workspace", () => {
    expect(
      forcedArchiveAcknowledgements(
        loss({
          targetPaths: ["a.txt", "b.txt"],
          subagents: [
            { workspaceId: "sub-1", title: "One", paths: ["x.txt"] },
            { workspaceId: "sub-2", title: "Two", paths: ["y.txt", "z.txt"] },
          ],
        })
      )
    ).toEqual({
      targetPaths: ["a.txt", "b.txt"],
      options: {
        acknowledgedSubagentUntrackedPaths: { "sub-1": ["x.txt"], "sub-2": ["y.txt", "z.txt"] },
        acknowledgedSubagentCheckoutDeletions: [],
      },
    });
  });

  test("acknowledges a single listed file, for the target and for a sub-agent", () => {
    expect(
      forcedArchiveAcknowledgements(
        loss({
          targetPaths: ["a.txt"],
          subagents: [{ workspaceId: "sub-1", title: "One", paths: ["x.txt"] }],
        })
      )
    ).toEqual({
      targetPaths: ["a.txt"],
      options: {
        acknowledgedSubagentUntrackedPaths: { "sub-1": ["x.txt"] },
        acknowledgedSubagentCheckoutDeletions: [],
      },
    });
  });

  test("lists the sub-agents whose checkout may be deleted, so a later one is refused", () => {
    expect(
      forcedArchiveAcknowledgements(
        loss({
          deletedSubagentCheckouts: [{ workspaceId: "sub-1", title: "One", branch: "br-one" }],
        })
      )
    ).toEqual({
      targetPaths: undefined,
      options: { acknowledgedSubagentCheckoutDeletions: ["sub-1"] },
    });
  });

  test("acknowledges nothing when nothing was listed, so the sink refuses any file it finds", () => {
    expect(forcedArchiveAcknowledgements(loss())).toEqual({
      targetPaths: undefined,
      options: { acknowledgedSubagentCheckoutDeletions: [] },
    });
  });

  test("passes no acknowledgement for an archive that is not forced", () => {
    expect(forcedArchiveAcknowledgements(undefined)).toEqual({
      targetPaths: undefined,
      options: {},
    });
  });
});

describe("describeForcedArchiveLoss", () => {
  test("reports nothing when the archive deleted no saved state", () => {
    expect(describeForcedArchiveLoss(loss())).toEqual({});
  });

  test("lists the target's and the sub-agents' files with the sub-agent's workspace ID in front", () => {
    const described = describeForcedArchiveLoss(
      loss({
        targetPaths: ["a.txt"],
        subagents: [{ workspaceId: "sub-1", title: "One", paths: ["x.txt", "dir/y.txt"] }],
      })
    );

    expect(described.paths).toEqual(["a.txt", "sub-1: x.txt", "sub-1: dir/y.txt"]);
    expect(described.note).toBeDefined();
  });

  test("reports a single deleted file or a single deletion on its own", () => {
    expect(describeForcedArchiveLoss(loss({ targetPaths: ["a.txt"] })).paths).toEqual(["a.txt"]);
    expect(describeForcedArchiveLoss(loss({ targetPaths: ["a.txt"] })).note).toBeDefined();

    const remoteOnly = describeForcedArchiveLoss(loss({ deletedCoderWorkspaceName: "xum-box-7" }));
    expect(remoteOnly.paths).toBeUndefined();
    expect(remoteOnly.note).toContain("xum-box-7");
  });

  test("names every checkout and remote workspace the policies deleted, without listing files", () => {
    const described = describeForcedArchiveLoss(
      loss({
        deletedCheckout: { path: "/src/repo/feature", branch: "feature-branch" },
        deletedSubagentCheckouts: [{ workspaceId: "sub-1", title: "One", branch: "br-one" }],
        deletedCoderWorkspaceName: "xum-box-7",
      })
    );

    expect(described.paths).toBeUndefined();
    expect(described.note).toContain("/src/repo/feature");
    expect(described.note).toContain("feature-branch");
    expect(described.note).toContain("One (sub-1, branch br-one)");
    expect(described.note).toContain("xum-box-7");
  });
});

describe("describeForcedLossBeforeFailure", () => {
  const forced = loss({
    targetPaths: ["own.txt"],
    subagents: [
      { workspaceId: "sub-1", title: "One", paths: ["x.txt"] },
      { workspaceId: "sub-2", title: "Two", paths: ["y.txt"] },
    ],
    deletedSubagentCheckouts: [
      { workspaceId: "sub-1", title: "One", branch: "br-one" },
      { workspaceId: "sub-3", title: "Three", branch: "br-three" },
    ],
    deletedCheckout: { path: "/src/repo/target", branch: "target-branch" },
    deletedCoderWorkspaceName: "xum-box-7",
  });

  test("reports nothing when no sub-agent was archived before the failure", () => {
    expect(describeForcedLossBeforeFailure(forced, () => false)).toBeUndefined();
  });

  test("names the files and checkouts of the sub-agents that were archived, not the target's", () => {
    const note = describeForcedLossBeforeFailure(forced, (id) => id === "sub-1");

    expect(note).toContain("sub-1: x.txt");
    expect(note).toContain("One (sub-1, branch br-one)");
    expect(note).not.toContain("sub-2");
    expect(note).not.toContain("sub-3");
    expect(note).not.toContain("own.txt");
    expect(note).not.toContain("/src/repo/target");
    expect(note).not.toContain("xum-box-7");
  });

  test("names a sub-agent whose checkout alone went", () => {
    const note = describeForcedLossBeforeFailure(forced, (id) => id === "sub-3");

    expect(note).toContain("Three (sub-3, branch br-three)");
    expect(note).not.toContain("x.txt");
  });
});

describe("sameForcedArchiveLoss", () => {
  const listed = loss({
    targetPaths: ["a.txt"],
    subagents: [{ workspaceId: "sub-1", title: "One", paths: ["x.txt"] }],
    deletedSubagentCheckouts: [{ workspaceId: "sub-2", title: "Two", branch: "br-two" }],
  });
  const same = () =>
    loss({
      targetPaths: ["a.txt"],
      subagents: [{ workspaceId: "sub-1", title: "One", paths: ["x.txt"] }],
      deletedSubagentCheckouts: [{ workspaceId: "sub-2", title: "Two", branch: "br-two" }],
    });

  test("is true for two listings of the same files and checkouts", () => {
    expect(sameForcedArchiveLoss(listed, same())).toBe(true);
  });

  test("is false when a file of the target, of a sub-agent, or a checkout was added or removed", () => {
    expect(sameForcedArchiveLoss(listed, { ...same(), targetPaths: ["a.txt", "late.txt"] })).toBe(
      false
    );
    expect(
      sameForcedArchiveLoss(listed, {
        ...same(),
        subagents: [{ workspaceId: "sub-1", title: "One", paths: ["x.txt", "late.txt"] }],
      })
    ).toBe(false);
    expect(sameForcedArchiveLoss(listed, { ...same(), subagents: [] })).toBe(false);
    expect(sameForcedArchiveLoss(listed, { ...same(), deletedSubagentCheckouts: [] })).toBe(false);
  });
});

describe("forcedArchivePaths", () => {
  test("lists the target's files, then each sub-agent's with its workspace ID in front", () => {
    expect(
      forcedArchivePaths(
        loss({
          targetPaths: ["a.txt"],
          subagents: [{ workspaceId: "sub-1", title: "One", paths: ["x.txt"] }],
        })
      )
    ).toEqual(["a.txt", "sub-1: x.txt"]);
  });
});
