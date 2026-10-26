import { describe, expect, test } from "bun:test";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import { BashMonitorActivity } from "@/node/services/bashMonitorActivity";

const SNAPSHOT = { recency: 1, streaming: false } as unknown as WorkspaceActivitySnapshot;

function createActivity() {
  const state = { count: 0, failSnapshot: false };
  const emits: Array<{ workspaceId: string; count: number }> = [];
  const activity = new BashMonitorActivity({
    getActiveBashMonitorCount: () => state.count,
    // Like ExtensionMetadataService: a failed sidecar reconcile throws only in strict mode.
    getSnapshot: (_workspaceId, options) => {
      if (!state.failSnapshot) return Promise.resolve(SNAPSHOT);
      return options.throwOnError ? Promise.reject(new Error("sidecar")) : Promise.resolve(null);
    },
    emitWorkspaceActivity: (workspaceId) => emits.push({ workspaceId, count: state.count }),
  });
  return { activity, state, emits };
}

// The emit runs after the snapshot read settles.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("BashMonitorActivity", () => {
  test("skips the re-emit while the delivered count holds", async () => {
    const { activity, state, emits } = createActivity();
    state.count = 1;
    activity.onProcessChange("ws");
    await settle();
    activity.onProcessChange("ws");
    await settle();
    expect(emits).toEqual([{ workspaceId: "ws", count: 1 }]);

    state.count = 0;
    activity.onProcessChange("ws");
    await settle();
    expect(emits).toEqual([
      { workspaceId: "ws", count: 1 },
      { workspaceId: "ws", count: 0 },
    ]);
  });

  test("an unknown count never dedupes, even at zero", async () => {
    const { activity, emits } = createActivity();
    activity.onProcessChange("ws");
    await settle();
    expect(emits).toEqual([{ workspaceId: "ws", count: 0 }]);
  });

  test("a failed snapshot read leaves the count unknown, so the next change re-emits", async () => {
    const { activity, state, emits } = createActivity();
    state.count = 1;
    activity.onProcessChange("ws");
    await settle();
    state.failSnapshot = true;
    state.count = 2;
    activity.onProcessChange("ws");
    await settle();
    expect(emits).toHaveLength(1);

    state.failSnapshot = false;
    activity.onProcessChange("ws");
    await settle();
    expect(emits).toEqual([
      { workspaceId: "ws", count: 1 },
      { workspaceId: "ws", count: 2 },
    ]);
  });

  test("a failed emit forgets the count delivered before it", async () => {
    const { activity, state, emits } = createActivity();
    state.count = 1;
    activity.onProcessChange("ws");
    await settle();
    // The stop's emit fails, so the renderer's last delivered count is unknown.
    state.count = 0;
    state.failSnapshot = true;
    activity.onProcessChange("ws");
    await settle();
    // Back at the old count: it must not dedupe against the value from before the failure.
    state.count = 1;
    state.failSnapshot = false;
    activity.onProcessChange("ws");
    await settle();
    expect(emits).toEqual([
      { workspaceId: "ws", count: 1 },
      { workspaceId: "ws", count: 1 },
    ]);
  });

  test("records the live count after the emit, not the one that triggered it", async () => {
    const { activity, state, emits } = createActivity();
    state.count = 1;
    activity.onProcessChange("ws");
    // The count moves while the snapshot read is in flight; the emit merges the live value.
    state.count = 2;
    await settle();
    activity.onProcessChange("ws");
    await settle();
    expect(emits).toEqual([{ workspaceId: "ws", count: 2 }]);
  });

  test("a workspace counts as seen once any armed monitor was observed", async () => {
    const { activity, state } = createActivity();
    activity.onProcessChange("ws-idle");
    await settle();
    expect(activity.hasSeen("ws-idle")).toBe(false);

    state.count = 1;
    activity.onProcessChange("ws");
    activity.markSeen("ws-listed");
    expect(activity.hasSeen("ws")).toBe(true);
    expect([...activity.seenWorkspaceIds()].sort()).toEqual(["ws", "ws-listed"]);

    // A stop does not clear it: the tombstone must survive until the workspace is evicted.
    state.count = 0;
    activity.onProcessChange("ws");
    await settle();
    expect(activity.hasSeen("ws")).toBe(true);
    activity.evictSeenWorkspace("ws");
    expect(activity.hasSeen("ws")).toBe(false);
  });
});
