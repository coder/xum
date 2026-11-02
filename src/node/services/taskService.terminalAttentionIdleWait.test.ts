import * as path from "path";
import type { EventEmitter } from "node:events";
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import assert from "node:assert";
import { createAgentSessionHarness } from "@/node/services/agentSession.testHarness";
import { createWorkspaceServiceForTest } from "@/node/services/workspaceService.testHarness";
import { waitForCondition } from "@/node/services/testDispatchHelpers";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  projectWorkspace,
  saveWorkspaces,
  streamEnd,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  collectFullHistory,
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  flushTerminalAttentionDrains,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const REPORT_COUNT = 3;

describe("TaskService terminal attention idle waits", () => {
  let rootDir: string;
  const cleanups: Array<() => Promise<void>> = [];
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await removeTaskServiceTestRoot(rootDir);
  });

  test("reports deferred by one busy parent share one idle wait and are delivered once, in order", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-idle-wait";
    const childIds = Array.from({ length: REPORT_COUNT }, (_, index) => `child-idle-wait-${index}`);
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        ...childIds.map((id) => ({
          path: path.join(projectPath, id),
          id,
          name: `agent_explore_${id}`,
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running" as const,
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium" as const,
        })),
      ],
      testTaskSettings()
    );

    // The parent's real session and the real WorkspaceService idle wait: each wait subscribes to
    // the session's chat-event, so the listener count is the number of live idle waiters. The
    // mocks resolve the real service at call time, so it can share the harness's HistoryService.
    const holder: { real?: ReturnType<typeof createWorkspaceServiceForTest> } = {};
    const real = () => {
      assert(holder.real, "the real WorkspaceService is created before any report");
      return holder.real;
    };
    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, resumeStream } = createWorkspaceServiceMocks({
      hasQueuedMessages: mock((workspaceId: string) => real().hasQueuedMessages(workspaceId)),
      waitForIdleAndNoQueuedMessages: mock((workspaceId: string) =>
        real().waitForIdleAndNoQueuedMessages(workspaceId)
      ),
    });
    const { taskService, historyService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const parent = await createAgentSessionHarness({
      workspaceId: parentId,
      config,
      historyService,
    });
    holder.real = createWorkspaceServiceForTest({ config, historyService });
    holder.real.registerSession(parentId, parent.session);
    cleanups.push(async () => {
      await real().disposeSession(parentId);
      await parent.session.dispose();
    });
    // Idle with queued input: busy for terminal attention until the queue clears.
    parent.session.queueMessage("queued while the parent works");
    const emitter = Reflect.get(parent.session, "emitter") as EventEmitter;
    const chatListeners = () => emitter.listenerCount("chat-event");
    const baseline = chatListeners();

    const drainChains = (
      taskService as unknown as {
        terminalAttention: { pendingTerminalAttentionDrainsByOwner: Map<string, Promise<void>> };
      }
    ).terminalAttention.pendingTerminalAttentionDrainsByOwner;

    for (const [index, childId] of childIds.entries()) {
      const reportMarkdown = `Report ${index} from ${childId}`;
      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: childId,
        messageId: `assistant-${childId}`,
        metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: `agent-report-${childId}`,
            toolName: "agent_report",
            input: { reportMarkdown, title: "Result" },
            state: "output-available",
            output: { success: true, report: { reportMarkdown, title: "Result" } },
          },
          { type: "text", text: reportMarkdown },
        ],
      });
    }
    // Every busy drain has run and deferred to the idle wait.
    await waitForCondition(() => !drainChains.has(parentId), { timeoutMs: 10_000 });

    expect(chatListeners()).toBe(baseline + 1);
    expect(resumeStream).not.toHaveBeenCalled();

    parent.session.clearQueue();
    await flushTerminalAttentionDrains(taskService);

    expect(chatListeners()).toBe(baseline);
    expect(resumeStream).toHaveBeenCalledTimes(1);
    const parentHistory = JSON.stringify(await collectFullHistory(historyService, parentId));
    const positions = childIds.map((childId, index) => {
      const report = `Report ${index} from ${childId}`;
      expect(parentHistory.split(report).length - 1).toBe(1);
      return parentHistory.indexOf(report);
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
