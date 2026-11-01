import { describe, expect, test } from "bun:test";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import { UsageRevisionActivity } from "@/node/services/usageRevisionActivity";

const SNAPSHOT: WorkspaceActivitySnapshot = {
  recency: 1,
  streaming: true,
  lastModel: null,
  lastThinkingLevel: null,
};

function createActivity() {
  const reads: Array<{
    resolve: (snapshot: WorkspaceActivitySnapshot | null) => void;
    reject: (error: Error) => void;
  }> = [];
  const emits: Array<number | undefined> = [];
  const activity: UsageRevisionActivity = new UsageRevisionActivity({
    getSnapshot: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    // Like WorkspaceService.emitWorkspaceActivity, which merges the revision as it sends.
    emitWorkspaceActivity: (workspaceId, snapshot) =>
      emits.push(snapshot ? activity.withRevision(workspaceId, snapshot).usageRevision : undefined),
  });
  const revision = (workspaceId: string) =>
    activity.withRevision(workspaceId, SNAPSHOT).usageRevision;
  return { activity, reads, emits, revision };
}

// The emit runs after the snapshot read settles.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("UsageRevisionActivity", () => {
  test("one emit carries every usage change made during its snapshot read", async () => {
    const { activity, reads, emits, revision } = createActivity();
    activity.onUsageChanged("ws");
    activity.onUsageChanged("ws");
    activity.onUsageChanged("ws");
    expect(reads).toHaveLength(1);

    reads[0].resolve(SNAPSHOT);
    await settle();
    expect(emits).toEqual([revision("ws")]);

    activity.onUsageChanged("ws");
    expect(reads).toHaveLength(2);
    reads[1].resolve(SNAPSHOT);
    await settle();
    expect(emits).toHaveLength(2);
    expect(emits[1]).toBeGreaterThan(emits[0]!);
  });

  test("keeps one emit in flight per workspace", () => {
    const { activity, reads } = createActivity();
    activity.onUsageChanged("a");
    activity.onUsageChanged("b");
    expect(reads).toHaveLength(2);
  });

  test("a failed or empty snapshot read emits nothing and lets the next change emit", async () => {
    const { activity, reads, emits } = createActivity();
    activity.onUsageChanged("ws");
    reads[0].reject(new Error("sidecar reconcile failed"));
    await settle();
    activity.onUsageChanged("ws");
    reads[1].resolve(null);
    await settle();
    expect(emits).toEqual([]);

    activity.onUsageChanged("ws");
    expect(reads).toHaveLength(3);
  });

  test("merges a revision only for a workspace whose usage changed, until evicted", () => {
    const { activity, revision } = createActivity();
    expect(activity.withRevision("ws", SNAPSHOT)).toBe(SNAPSHOT);
    activity.onUsageChanged("ws");
    expect(revision("ws")).toBeNumber();
    expect(revision("other")).toBeUndefined();

    activity.evict("ws");
    expect(activity.withRevision("ws", SNAPSHOT)).toBe(SNAPSHOT);
  });

  test("a backend started later never reissues a revision the earlier one sent", async () => {
    const earlier = createActivity();
    earlier.activity.onUsageChanged("ws");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const later = createActivity();
    later.activity.onUsageChanged("ws");

    expect(later.revision("ws")).toBeGreaterThan(earlier.revision("ws")!);
  });
});
