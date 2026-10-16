import { describe, expect, it } from "bun:test";

import type { GitHubPRLinkWithStatus, GitHubPRStatus } from "@/common/types/links";
import { getStatusColorClass, getTooltipContent } from "./PRLinkBadge";

function makePRLink(statusOverrides: Partial<GitHubPRStatus> = {}): GitHubPRLinkWithStatus {
  return {
    type: "github-pr",
    url: "https://github.com/coder/mux/pull/1",
    owner: "coder",
    repo: "mux",
    number: 1,
    detectedAt: 0,
    occurrenceCount: 1,
    status: {
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      title: "Test PR",
      isDraft: false,
      headRefName: "feature",
      baseRefName: "main",
      fetchedAt: Date.now(),
      ...statusOverrides,
    },
  };
}

describe("getStatusColorClass", () => {
  it("returns warning when PR is in merge queue", () => {
    const pr = makePRLink({ mergeQueueEntry: { state: "QUEUED", position: 0 } });

    expect(getStatusColorClass(pr)).toBe("text-warning");
  });

  it("keeps draft color priority even when merge queue data exists", () => {
    const pr = makePRLink({
      isDraft: true,
      mergeQueueEntry: { state: "QUEUED", position: 0 },
    });

    expect(getStatusColorClass(pr)).toBe("text-muted");
  });

  it("uses non-queue status colors when merge queue entry is null", () => {
    const pr = makePRLink({ mergeStateStatus: "CLEAN", mergeQueueEntry: null });

    expect(getStatusColorClass(pr)).toBe("text-success-text");
  });
});

describe("getTooltipContent", () => {
  it("shows 1-indexed queue position for merge queue entries", () => {
    const pr = makePRLink({ mergeQueueEntry: { state: "QUEUED", position: 0 } });

    expect(getTooltipContent(pr)).toContain("In merge queue (position 1)");
  });

  it("shows merge queue text without position when queue position is unavailable", () => {
    const pr = makePRLink({ mergeQueueEntry: { state: "QUEUED", position: null } });

    const tooltip = getTooltipContent(pr);
    expect(tooltip).toContain("In merge queue");
    expect(tooltip).not.toContain("position");
  });

  it("does not mention merge queue when entry is absent", () => {
    const pr = makePRLink({ mergeStateStatus: "CLEAN" });

    expect(getTooltipContent(pr)).not.toContain("merge queue");
  });
});
