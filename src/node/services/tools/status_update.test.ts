import { describe, expect, test } from "bun:test";
import type { Tool } from "ai";

import type { StatusUpdateToolResult } from "@/common/types/tools";
import { getToolsForModel } from "@/common/utils/tools/tools";
import type {
  StatusPageAgentQueue,
  StatusPageEnqueueInput,
  StatusPageEnqueueResult,
} from "@/node/services/statusPageAgentService";
import { createTestToolConfig, getTestDeps, mockToolCallOptions, TestTempDir } from "./testHelpers";

const WORKSPACE_ID = "status-update-workspace";
const TURN_MODEL = "anthropic:turn-model";

function fakeQueue(result: StatusPageEnqueueResult = { queued: true }) {
  const calls: Array<{ workspaceId: string } & StatusPageEnqueueInput> = [];
  const queue: StatusPageAgentQueue = {
    enqueue: (workspaceId, input) => {
      calls.push({ workspaceId, ...input });
      return result;
    },
  };
  return { queue, calls };
}

async function toolsFor(
  tempDir: string,
  statusPageAgent: StatusPageAgentQueue | undefined,
  statusPageAgentActive: boolean
): Promise<Record<string, Tool>> {
  return getToolsForModel(
    TURN_MODEL,
    {
      ...createTestToolConfig(tempDir, { workspaceId: WORKSPACE_ID }),
      statusPageAgent,
      statusPageAgentActive,
    },
    WORKSPACE_ID,
    getTestDeps().initStateManager
  );
}

async function execute(tool: Tool | undefined, update: string): Promise<StatusUpdateToolResult> {
  if (tool?.execute == null) throw new Error("status_update is not registered");
  return (await tool.execute({ update }, mockToolCallOptions)) as StatusUpdateToolResult;
}

describe("status_update tool", () => {
  test("is registered only with the queue while status page agent mode is active", async () => {
    using tempDir = new TestTempDir("status-update-gating");
    const { queue } = fakeQueue();

    expect((await toolsFor(tempDir.path, queue, false)).status_update).toBeUndefined();
    expect((await toolsFor(tempDir.path, undefined, true)).status_update).toBeUndefined();
    expect((await toolsFor(tempDir.path, queue, true)).status_update).toBeDefined();
  });

  test("queues the update with the turn's model as the fallback and returns at once", async () => {
    using tempDir = new TestTempDir("status-update-queue");
    const { queue, calls } = fakeQueue();
    const tools = await toolsFor(tempDir.path, queue, true);

    const result = await execute(tools.status_update, "  Started the build  ");

    expect(result).toEqual({ success: true, queued: true });
    expect(calls).toEqual([
      { workspaceId: WORKSPACE_ID, update: "Started the build", fallbackModel: TURN_MODEL },
    ]);
  });

  test("tells the main agent when the previous status page run failed", async () => {
    using tempDir = new TestTempDir("status-update-note");
    const { queue } = fakeQueue({ queued: true, previousError: "provider exploded" });
    const tools = await toolsFor(tempDir.path, queue, true);

    const result = await execute(tools.status_update, "Tests pass");

    expect(result.success).toBe(true);
    expect(result.success && result.note).toContain("provider exploded");
  });

  test("tells the main agent how many earlier updates were dropped unapplied", async () => {
    using tempDir = new TestTempDir("status-update-discarded");
    const { queue } = fakeQueue({ queued: true, previousError: "timeout", discardedUpdates: 3 });
    const tools = await toolsFor(tempDir.path, queue, true);

    const result = await execute(tools.status_update, "Tests pass");

    expect(result.success).toBe(true);
    // Both notes reach the main agent: neither may hide the other.
    expect(result.success && result.note).toContain("timeout");
    expect(result.success && result.note).toContain("3 earlier updates");
  });
});
