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
  const emits: Array<[string, number]> = [];
  const activity = new UsageRevisionActivity({
    emitUsageRevision: (workspaceId, usageRevision) => emits.push([workspaceId, usageRevision]),
  });
  const listed = (workspaceId: string) =>
    activity.withRevisions({ [workspaceId]: SNAPSHOT })[workspaceId].usageRevision;
  return { activity, emits, listed };
}

describe("UsageRevisionActivity", () => {
  test("emits a new revision on every usage change, and lists the latest", () => {
    const { activity, emits, listed } = createActivity();
    activity.onUsageChanged("ws");
    activity.onUsageChanged("ws");

    expect(emits.map(([workspaceId]) => workspaceId)).toEqual(["ws", "ws"]);
    expect(emits[1][1]).toBeGreaterThan(emits[0][1]);
    expect(listed("ws")).toBe(emits[1][1]);
  });

  test("lists a revision only for a workspace whose usage changed, until evicted", () => {
    const { activity, listed } = createActivity();
    activity.onUsageChanged("ws");

    expect(activity.withRevisions({ ws: SNAPSHOT, other: SNAPSHOT }).other).toBe(SNAPSHOT);
    expect(listed("ws")).toBeNumber();
    activity.evict("ws");
    expect(listed("ws")).toBeUndefined();
  });

  test("a backend started later never reissues a revision the earlier one sent", async () => {
    const earlier = createActivity();
    earlier.activity.onUsageChanged("ws");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const later = createActivity();
    later.activity.onUsageChanged("ws");

    expect(later.listed("ws")).toBeGreaterThan(earlier.listed("ws")!);
  });
});
