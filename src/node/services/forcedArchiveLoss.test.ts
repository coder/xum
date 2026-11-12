import { describe, expect, test } from "bun:test";

import {
  describeForcedArchiveLoss,
  forcedArchiveAcknowledgements,
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
      subagentPaths: { "sub-1": ["x.txt"], "sub-2": ["y.txt", "z.txt"] },
    });
  });

  test("acknowledges nothing when nothing was listed, so the sink refuses any file it finds", () => {
    expect(forcedArchiveAcknowledgements(loss())).toEqual({
      targetPaths: undefined,
      subagentPaths: undefined,
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

  test("names every checkout and remote workspace the policies deleted, without listing files", () => {
    const described = describeForcedArchiveLoss(
      loss({
        deletedCheckoutPath: "/src/repo/feature",
        deletedSubagentCheckouts: [{ workspaceId: "sub-1", title: "One" }],
        deletedCoderWorkspaceName: "xum-box-7",
      })
    );

    expect(described.paths).toBeUndefined();
    expect(described.note).toContain("/src/repo/feature");
    expect(described.note).toContain("One (sub-1)");
    expect(described.note).toContain("xum-box-7");
  });
});
