import { describe, expect, test } from "bun:test";

import { pumpWorkspaceActivity, type WorkspaceActivityPumpClient } from "./workspaceActivityPump";
import type { UiWorkspaceActivity } from "./webview/protocol";

interface Activity {
  activeBashMonitorCount?: number;
  streaming?: boolean;
  activeWorkflowRunIds?: string[];
  transientGoalOnly?: boolean;
}
type ActivityEvent =
  | { type: "activity"; workspaceId: string; activity: Activity | null }
  | { type: "heartbeat" };

/** A subscription the test drives: events are delivered in order, then end or fail. */
function createFakeActivityClient(snapshot: Record<string, Activity> | null) {
  const calls: string[] = [];
  const queue: Array<{ event: ActivityEvent } | { end: true } | { error: unknown }> = [];
  let wake: (() => void) | null = null;
  const enqueue = (item: (typeof queue)[number]) => {
    queue.push(item);
    wake?.();
    wake = null;
  };

  async function* events(): AsyncGenerator<ActivityEvent> {
    for (;;) {
      const item = queue.shift();
      if (!item) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      if ("end" in item) return;
      if ("error" in item) throw item.error;
      yield item.event;
    }
  }

  const client: WorkspaceActivityPumpClient = {
    workspace: {
      activity: {
        subscribe: () => {
          calls.push("subscribe");
          return Promise.resolve(events());
        },
        list: () => {
          calls.push("list");
          return Promise.resolve(snapshot);
        },
      },
    },
  };

  return {
    client,
    calls,
    emit: (workspaceId: string, activeBashMonitorCount: number) =>
      enqueue({ event: { type: "activity", workspaceId, activity: { activeBashMonitorCount } } }),
    emitActivity: (workspaceId: string, activity: Activity | null) =>
      enqueue({ event: { type: "activity", workspaceId, activity } }),
    heartbeat: () => enqueue({ event: { type: "heartbeat" } }),
    end: () => enqueue({ end: true }),
    fail: (error: unknown) => enqueue({ error }),
  };
}

function startPump(
  fake: ReturnType<typeof createFakeActivityClient>,
  options: {
    isSelected?: (posted: readonly number[]) => boolean;
    onPost?: (controller: AbortController) => void;
    workspaceIds?: string[];
  } = {}
) {
  // The selected workspace's monitor count per post, and every posted map.
  const posted: number[] = [];
  const maps: Array<Record<string, UiWorkspaceActivity>> = [];
  const errors: unknown[] = [];
  const controller = new AbortController();
  const done = pumpWorkspaceActivity({
    client: fake.client,
    workspaceIds: options.workspaceIds ?? ["ws-1"],
    signal: controller.signal,
    isSelected: () => options.isSelected?.(posted) ?? true,
    post: (activity) => {
      posted.push(activity["ws-1"]?.activeBashMonitorCount ?? -1);
      maps.push(activity);
      options.onPost?.(controller);
    },
    onError: (error) => errors.push(error),
  });
  return { posted, maps, errors, controller, done };
}

describe("pumpWorkspaceActivity", () => {
  test("subscribes before listing, then posts only this workspace's changed counts", async () => {
    const fake = createFakeActivityClient({ "ws-1": { activeBashMonitorCount: 1 } });
    // Queued before the pump reads the snapshot: a change between subscribe and list.
    fake.emit("ws-1", 2);
    fake.emit("ws-other", 5);
    fake.heartbeat();
    fake.emit("ws-1", 2);
    fake.emit("ws-1", 0);
    fake.end();

    const pump = startPump(fake);
    await pump.done;

    expect(fake.calls).toEqual(["subscribe", "list"]);
    expect(pump.posted).toEqual([1, 2, 0]);
    expect(pump.errors).toEqual([]);
  });

  test("tracks descendants too, posting each workspace's monitors, stream and workflow runs (#5109)", async () => {
    const fake = createFakeActivityClient({
      "ws-1": { activeBashMonitorCount: 1 },
      "ws-child": { streaming: true, activeWorkflowRunIds: ["run-1"] },
      "ws-other": { streaming: true },
    });
    fake.emitActivity("ws-child", { streaming: false, activeWorkflowRunIds: ["run-1"] });
    // Goal-only events carry stale baseline fields and must not overwrite the child's state.
    fake.emitActivity("ws-child", { streaming: true, transientGoalOnly: true });
    fake.emitActivity("ws-other", { streaming: false });
    // A removed or idle workspace reports null.
    fake.emitActivity("ws-child", null);
    fake.end();

    const pump = startPump(fake, { workspaceIds: ["ws-1", "ws-child"] });
    await pump.done;

    const idle = { activeBashMonitorCount: 0, streaming: false, activeWorkflowRunIds: [] };
    const selected = { ...idle, activeBashMonitorCount: 1 };
    expect(pump.maps).toEqual([
      { "ws-1": selected, "ws-child": { ...idle, streaming: true, activeWorkflowRunIds: ["run-1"] } },
      { "ws-1": selected, "ws-child": { ...idle, activeWorkflowRunIds: ["run-1"] } },
      { "ws-1": selected, "ws-child": idle },
    ]);
  });

  test("a null snapshot keeps the current value until an event arrives", async () => {
    const fake = createFakeActivityClient(null);
    fake.emit("ws-1", 3);
    fake.end();

    const pump = startPump(fake);
    await pump.done;

    expect(pump.posted).toEqual([3]);
  });

  test("a missing workspace in the snapshot posts zero", async () => {
    const fake = createFakeActivityClient({});
    fake.end();

    const pump = startPump(fake);
    await pump.done;

    expect(pump.posted).toEqual([0]);
  });

  test("stops posting once the selection changes or the pump is aborted", async () => {
    const deselectedFake = createFakeActivityClient({ "ws-1": { activeBashMonitorCount: 1 } });
    deselectedFake.emit("ws-1", 2);
    deselectedFake.end();
    // The view selects another workspace right after the snapshot is posted.
    const deselected = startPump(deselectedFake, { isSelected: (posted) => posted.length === 0 });
    await deselected.done;
    expect(deselected.posted).toEqual([1]);

    const abortedFake = createFakeActivityClient({ "ws-1": { activeBashMonitorCount: 1 } });
    abortedFake.emit("ws-1", 2);
    abortedFake.end();
    const aborted = startPump(abortedFake, { onPost: (controller) => controller.abort() });
    await aborted.done;
    expect(aborted.posted).toEqual([1]);
  });

  test("reports subscription errors, except those caused by abort", async () => {
    const failing = createFakeActivityClient({});
    failing.fail(new Error("boom"));
    const live = startPump(failing);
    await live.done;
    expect(live.errors).toEqual([new Error("boom")]);

    const abortedFake = createFakeActivityClient({});
    const aborted = startPump(abortedFake);
    await Promise.resolve();
    aborted.controller.abort();
    abortedFake.fail(new Error("aborted"));
    await aborted.done;
    expect(aborted.errors).toEqual([]);
  });
});
