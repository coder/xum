import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import { getAvailableTools } from "@/common/utils/tools/toolDefinitions";
import { getToolsForModel } from "@/common/utils/tools/tools";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { TimelineService } from "@/node/services/timelineService";
import { createTestToolConfig, getTestDeps } from "./testHelpers";
import { createTimelineEventTool } from "./timeline_event";

const WORKSPACE_ID = "timeline-event-workspace";

function options(toolCallId: string): ToolExecutionOptions<unknown> {
  return { toolCallId, messages: [], context: undefined };
}

describe("timeline_event tool", () => {
  let timelineService: TimelineService;
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testHistory = await createTestHistoryService();
    tempDir = testHistory.tempDir;
    cleanup = testHistory.cleanup;
    timelineService = new TimelineService(testHistory.config, testHistory.historyService, {
      isExperimentEnabled: () => true,
    });
  });

  afterEach(async () => {
    await timelineService.flush();
    await cleanup();
  });

  test("appends an agent event", async () => {
    const tool = createTimelineEventTool({
      ...createTestToolConfig(tempDir, { workspaceId: WORKSPACE_ID }),
      timelineService,
    });

    const result: unknown = await tool.execute!(
      { description: "Committed the backend slice", category: "milestone" },
      options("event-1")
    );
    await timelineService.flush();

    expect(result).toEqual({ success: true, recorded: true });
    const page = await timelineService.list(WORKSPACE_ID, {});
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      kind: "agent.event",
      source: { system: "agent", key: "timeline-event:event-1" },
      anchor: { toolCallId: "event-1" },
      data: {
        description: "Committed the backend slice",
        category: "milestone",
      },
    });
  });

  test("throttles duplicates and over-limit events across toolset rebuilds", async () => {
    const config = {
      ...createTestToolConfig(tempDir, { workspaceId: WORKSPACE_ID }),
      timelineService,
    };
    const tool = createTimelineEventTool(config);

    const first: unknown = await tool.execute!({ description: "One" }, options("event-1"));
    const duplicate: unknown = await tool.execute!({ description: "One" }, options("event-2"));
    for (let index = 2; index <= 10; index++) {
      await tool.execute!({ description: `Event ${index}` }, options(`event-${index}`));
    }

    // The model-fallback path rebuilds the toolset mid-turn; the budget must not reset with it.
    const rebuilt = createTimelineEventTool(config);
    const afterRebuild: unknown = await tool.execute!(
      { description: "Over limit" },
      options("event-over")
    );
    const afterRebuiltInstance: unknown = await rebuilt.execute!(
      { description: "Over limit via rebuilt tool" },
      options("event-over-rebuilt")
    );
    await timelineService.flush();

    expect(first).toEqual({ success: true, recorded: true });
    expect(duplicate).toEqual({ success: true, recorded: false });
    expect(afterRebuild).toEqual({ success: true, recorded: false });
    expect(afterRebuiltInstance).toEqual({ success: true, recorded: false });
    expect((await timelineService.list(WORKSPACE_ID, {})).events).toHaveLength(10);
  });

  test("counts repeats toward the window limit, not just distinct descriptions", async () => {
    const tool = createTimelineEventTool({
      ...createTestToolConfig(tempDir, { workspaceId: WORKSPACE_ID }),
      timelineService,
    });
    let now = Date.UTC(2026, 0, 1);
    const nowSpy = spyOn(Date, "now").mockImplementation(() => now);

    try {
      // Nine distinct descriptions, then advance past the duplicate window so repeats are allowed.
      // Counting distinct descriptions would leave room for unlimited repeats.
      for (let index = 1; index <= 9; index++) {
        await tool.execute!({ description: `Event ${index}` }, options(`event-${index}`));
      }
      now += 31_000;
      const tenth: unknown = await tool.execute!({ description: "Event 1" }, options("repeat-1"));
      const eleventh: unknown = await tool.execute!(
        { description: "Event 2" },
        options("repeat-2")
      );
      await timelineService.flush();

      expect(tenth).toEqual({ success: true, recorded: true });
      expect(eleventh).toEqual({ success: true, recorded: false });
      expect((await timelineService.list(WORKSPACE_ID, {})).events).toHaveLength(10);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("is absent from getToolsForModel when the experiment is off", async () => {
    const config = {
      ...createTestToolConfig(tempDir, { workspaceId: WORKSPACE_ID }),
      timelineService,
      experiments: { timeline: false },
    };
    const { initStateManager } = getTestDeps();

    const tools = await getToolsForModel(
      "anthropic:claude-sonnet-4-20250514",
      config,
      WORKSPACE_ID,
      initStateManager
    );
    expect(tools.timeline_event).toBeUndefined();
  });

  test("is absent from the allowlist when disabled", () => {
    expect(
      getAvailableTools("anthropic:claude-sonnet-4-20250514", {
        enableTimelineEvent: false,
      })
    ).not.toContain("timeline_event");
  });
});
