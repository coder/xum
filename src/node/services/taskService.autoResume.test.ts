import * as path from "path";
import { describe, test, expect, mock, spyOn } from "bun:test";
import { sandboxHostService } from "@/node/services/sandbox/sandboxHostService";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import { Ok, Err, type Result } from "@/common/types/result";
import { createMuxMessage } from "@/common/types/message";
import { BACKGROUND_WORK_WAKE_OPENINGS } from "@/common/utils/machineTurnPrompts";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import {
  buildWorkflowRunCardMessage,
  WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE,
} from "@/common/utils/workflowRunMessages";
import assert from "node:assert";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  projectWorkspace,
  saveLocalParentWorkspace,
  saveWorkspaces,
  streamEnd,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  collectFullHistory,
  createTaskServiceHarness,
  registerTaskServiceTestRoot,
  rootDir,
} from "@/node/services/taskService.shared.testHarness";

describe("TaskService", () => {
  registerTaskServiceTestRoot();

  test("auto-resumes a parent workspace until background tasks finish", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(childTaskId),
      expect.objectContaining({
        model: "openai:gpt-5.2",
        thinkingLevel: "medium",
      }),
      // Auto-resume skips counter reset
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("auto-resumes a parent workspace until background workflow runs finish", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_background";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, rootWorkspaceId),
    });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, rootWorkspaceId),
      runId: workflowRunId,
      createdAtMs: Date.now(),
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(workflowRunId),
      expect.objectContaining({
        model: "openai:gpt-5.2",
        thinkingLevel: "medium",
      }),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
    const prompt = (sendMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1];
    assert(typeof prompt === "string", "expected workflow auto-resume prompt");
    expect(prompt).toContain(`task_ids: ["${workflowRunId}"]`);
    expect(prompt).toContain("task_await");
  });

  test("queues parent auto-resume if stream-end cleanup is still busy", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );

    const sendMessage = mock(
      (
        _workspaceId: string,
        _message: string,
        _options: unknown,
        internal?: { requireIdle?: boolean }
      ): Promise<Result<void, { type: string; raw: string }>> => {
        if (internal?.requireIdle === true) {
          return Promise.resolve(
            Err({ type: "unknown", raw: "Workspace is busy; idle-only send was skipped." })
          );
        }
        return Promise.resolve(Ok(undefined));
      }
    );
    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      rootWorkspaceId,
      expect.stringContaining(childTaskId),
      expect.anything(),
      expect.objectContaining({ requireIdle: true })
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      rootWorkspaceId,
      expect.stringContaining(childTaskId),
      expect.anything(),
      expect.not.objectContaining({ requireIdle: true })
    );
  });

  test("does not queue parent auto-resume if follow-up turn appears during idle fallback", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );

    const sendMessage = mock(
      (
        _workspaceId: string,
        _message: string,
        _options: unknown,
        internal?: { requireIdle?: boolean }
      ): Promise<Result<void, { type: string; raw: string }>> => {
        if (internal?.requireIdle === true) {
          return Promise.resolve(
            Err({ type: "unknown", raw: "Workspace is busy; idle-only send was skipped." })
          );
        }
        return Promise.resolve(Ok(undefined));
      }
    );
    let queueChecks = 0;
    // handleStreamEnd consumes one extra read at entry for the queue-cut
    // attribution snapshot; the follow-up turn must appear on the idle
    // fallback's own re-check (the fourth read overall).
    const hasPendingQueuedOrPreparingTurn = mock(() => {
      queueChecks += 1;
      return queueChecks >= 4;
    });
    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage,
      hasPendingQueuedOrPreparingTurn,
    });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      rootWorkspaceId,
      expect.stringContaining(childTaskId),
      expect.anything(),
      expect.objectContaining({ requireIdle: true })
    );
  });

  test("does not auto-resume for an agent workflow superseded by a manual user turn", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_superseded";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, rootWorkspaceId),
    });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, rootWorkspaceId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const appendManualUser = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage("manual-user", "user", "Ignore the old workflow", { timestamp: 2_000 })
    );
    expect(appendManualUser.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("does not auto-resume for an agent workflow superseded by a context reset", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_reset_superseded";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, rootWorkspaceId),
    });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, rootWorkspaceId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const appendReset = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage("reset-boundary", "assistant", "Context reset", {
        timestamp: 2_000,
        contextBoundaryKind: "reset",
      })
    );
    expect(appendReset.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("does not trust persisted workflow refs at the same timestamp as manual supersession", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_same_ms_superseded";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, rootWorkspaceId),
    });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, rootWorkspaceId),
      runId: workflowRunId,
      createdAtMs: 2_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const appendManualUser = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage("manual-user", "user", "Ignore the old workflow", { timestamp: 2_000 })
    );
    expect(appendManualUser.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("ignores current workflow_run parts from a stream superseded in history", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_current_parts_stale";
    const assistantMessageId = "assistant-before-slash";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, rootWorkspaceId),
    });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    expect(
      (
        await historyService.appendToHistory(
          rootWorkspaceId,
          createMuxMessage(assistantMessageId, "assistant", "", { timestamp: 1_000 })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          rootWorkspaceId,
          createMuxMessage("workflow-slash-trigger", "user", "/research new topic", {
            timestamp: 2_000,
          })
        )
      ).success
    ).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: assistantMessageId,
      metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "workflow-call-stale",
          toolName: "workflow_run",
          state: "output-available",
          input: { name: "background-research", args: {}, run_in_background: true },
          output: { status: "running", runId: workflowRunId, result: null },
        },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("workflow_resume parts emitted after supersession re-establish provenance", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_resumed_after_supersession";
    const assistantMessageId = "assistant-after-supersession";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, rootWorkspaceId),
    });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    expect(
      (
        await historyService.appendToHistory(
          rootWorkspaceId,
          createMuxMessage("manual-user", "user", "Ignore the old workflow", { timestamp: 1_000 })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          rootWorkspaceId,
          createMuxMessage(assistantMessageId, "assistant", "", { timestamp: 2_000 })
        )
      ).success
    ).toBe(true);

    // The stream ends after the superseding user turn, so its workflow_resume output re-attaches
    // the agent to the run and the auto-resume nudge must be delivered.
    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: assistantMessageId,
      metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "workflow-resume-1",
          toolName: "workflow_resume",
          state: "output-available",
          input: { run_id: workflowRunId, mode: "resume", run_in_background: true },
          output: { status: "running", runId: workflowRunId, result: null },
        },
      ],
    });

    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(workflowRunId),
      expect.anything(),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("does not trust persisted workflow refs after timestamp-less manual user turns", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_timestampless_superseded";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, rootWorkspaceId),
    });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, rootWorkspaceId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const appendManualUser = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage("manual-user", "user", "Ignore the old workflow")
    );
    expect(appendManualUser.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("keeps workflow refs current across mid-stream auto-compaction", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_midstream_compaction_current";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, rootWorkspaceId),
    });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, rootWorkspaceId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const appendCompaction = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage("midstream-auto-compaction", "user", "Compacting to continue", {
        timestamp: 2_000,
        synthetic: true,
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: {
            followUpContent: {
              text: "Continue",
              model: "openai:gpt-5.2",
              agentId: "exec",
              dispatchOptions: { source: "internal-resume" },
            },
          },
          source: "auto-compaction",
        },
      })
    );
    expect(appendCompaction.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(workflowRunId),
      expect.anything(),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("does not auto-resume after on-send compaction supersedes an agent workflow", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_auto_compact_superseded";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, rootWorkspaceId),
    });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, rootWorkspaceId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const appendCompaction = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage("auto-compaction", "user", "Compacting before a new user prompt", {
        timestamp: 2_000,
        synthetic: true,
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: {},
          source: "auto-compaction",
        },
      })
    );
    expect(appendCompaction.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("does not auto-resume a parent for slash-command workflow run cards", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_slash_background";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, rootWorkspaceId),
    });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const slashCard = buildWorkflowRunCardMessage(
      { name: "background-research", args: {} },
      { runId: workflowRunId, status: "running", result: null },
      Date.now()
    );
    slashCard.metadata = {
      ...slashCard.metadata,
      muxMetadata: { type: WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE, runId: workflowRunId },
    };
    const appendCard = await historyService.appendToHistory(rootWorkspaceId, slashCard);
    expect(appendCard.success).toBe(true);

    const appendTaskAwaitDiscovery = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage(
        "assistant-task-await-discovery",
        "assistant",
        "",
        { timestamp: Date.now() },
        [
          {
            type: "dynamic-tool",
            toolCallId: "task-await-1",
            toolName: "task_await",
            state: "output-available",
            input: {},
            output: { results: [{ taskId: workflowRunId, status: "running" }] },
          },
        ]
      )
    );
    expect(appendTaskAwaitDiscovery.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("does not auto-resume a parent for workflow-owned descendants", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowTaskId = "task-workflow";
    const workflowChildTaskId = "task-workflow-child";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "workflow-task", workflowTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
          workflowTask: { runId: "wfr_target", stepId: "scope" },
        }),
        projectWorkspace(projectPath, "workflow-child", workflowChildTaskId, {
          parentWorkspaceId: workflowTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("does not auto-resume a parent while a follow-up turn is already queued or preparing", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const hasPendingQueuedOrPreparingTurn = mock(() => true);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      hasPendingQueuedOrPreparingTurn,
    });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(hasPendingQueuedOrPreparingTurn).toHaveBeenCalledWith(rootWorkspaceId);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("does not auto-resume for queue-backgrounded descendants", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const waitPromise = taskService.waitForAgentReport(childTaskId, {
      requestingWorkspaceId: rootWorkspaceId,
      backgroundOnMessageQueued: true,
    });
    expect(taskService.backgroundForegroundWaitsForWorkspace(rootWorkspaceId)).toBe(1);
    const waitError = await waitPromise.catch((error: unknown) => error);
    expect(waitError).toBeInstanceOf(ForegroundWaitBackgroundedError);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("notify_on_terminal child does not force await across multiple stream-ends", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-notify";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task-notify", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
          taskAttentionPolicy: "notify_on_terminal",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    for (const messageId of ["assistant-root-1", "assistant-root-2"]) {
      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: rootWorkspaceId,
        messageId,
        metadata: { model: "openai:gpt-5.2" },
        parts: [],
      });
    }

    // notify_on_terminal is durable: neither stream-end forces a task_await nudge.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("notify_on_terminal child subtree does not leak blocking grandchildren to owner", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-notify";
    const grandchildTaskId = "task-grandchild";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task-notify", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskAttentionPolicy: "notify_on_terminal",
        }),
        projectWorkspace(projectPath, "grandchild-task", grandchildTaskId, {
          name: "agent_explore_grandchild",
          parentWorkspaceId: childTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("queue-backgrounded foreground wait stays suppressed across multiple stream-ends", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-bg";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task-bg", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const waitPromise = taskService.waitForAgentReport(childTaskId, {
      requestingWorkspaceId: rootWorkspaceId,
      backgroundOnMessageQueued: true,
    });
    expect(taskService.backgroundForegroundWaitsForWorkspace(rootWorkspaceId)).toBe(1);
    const waitError = await waitPromise.catch((error: unknown) => error);
    expect(waitError).toBeInstanceOf(ForegroundWaitBackgroundedError);

    for (const messageId of ["assistant-root-1", "assistant-root-2"]) {
      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: rootWorkspaceId,
        messageId,
        metadata: { model: "openai:gpt-5.2" },
        parts: [],
      });
    }

    // Detaching a foreground wait via a queued message now persists notify_on_terminal,
    // so neither stream-end re-forces a task_await nudge (durable, not one-shot).
    expect(sendMessage).not.toHaveBeenCalled();

    // The persisted policy is durable.
    const persisted = config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((w) => w.id === childTaskId);
    expect(persisted?.taskAttentionPolicy).toBe("notify_on_terminal");
  });

  test("multiple queue-backgrounded tasks stay durably non-blocking", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const taskAId = "task-bg-a";
    const taskBId = "task-bg-b";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task-bg-a", taskAId, {
          name: "agent_explore_a",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
        projectWorkspace(projectPath, "child-task-bg-b", taskBId, {
          name: "agent_explore_b",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const waitAPromise = taskService.waitForAgentReport(taskAId, {
      requestingWorkspaceId: rootWorkspaceId,
      backgroundOnMessageQueued: true,
    });
    const waitBPromise = taskService.waitForAgentReport(taskBId, {
      requestingWorkspaceId: rootWorkspaceId,
      backgroundOnMessageQueued: true,
    });
    expect(taskService.backgroundForegroundWaitsForWorkspace(rootWorkspaceId)).toBe(2);

    const [waitAError, waitBError] = await Promise.all([
      waitAPromise.catch((error: unknown) => error),
      waitBPromise.catch((error: unknown) => error),
    ]);
    expect(waitAError).toBeInstanceOf(ForegroundWaitBackgroundedError);
    expect(waitBError).toBeInstanceOf(ForegroundWaitBackgroundedError);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root-1",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root-2",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    // Both detached waits persist notify_on_terminal, so a later stream-end never re-forces await.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("markBackgroundWorkNotifyOnTerminal makes a timed-out wait durably non-blocking", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-timeout";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task-timeout", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    // Simulate the task tool's timeout-detach: the foreground wait exceeded its budget but the task
    // keeps running, so it is marked notify_on_terminal.
    await taskService.markBackgroundWorkNotifyOnTerminal(childTaskId, rootWorkspaceId);

    const persisted = config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((w) => w.id === childTaskId);
    expect(persisted?.taskAttentionPolicy).toBe("notify_on_terminal");

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("renewed foreground wait does not re-promote durable notify policy to blocking", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-bg";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task-bg", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const firstWaitPromise = taskService.waitForAgentReport(childTaskId, {
      requestingWorkspaceId: rootWorkspaceId,
      backgroundOnMessageQueued: true,
    });
    expect(taskService.backgroundForegroundWaitsForWorkspace(rootWorkspaceId)).toBe(1);
    const firstWaitError = await firstWaitPromise.catch((error: unknown) => error);
    expect(firstWaitError).toBeInstanceOf(ForegroundWaitBackgroundedError);

    const secondWaitPromise = taskService.waitForAgentReport(childTaskId, {
      requestingWorkspaceId: rootWorkspaceId,
      backgroundOnMessageQueued: true,
      timeoutMs: 10,
    });
    const secondWaitError = await secondWaitPromise.catch((error: unknown) => error);
    expect(secondWaitError).toBeInstanceOf(Error);
    if (secondWaitError instanceof Error) {
      expect(secondWaitError.message).toBe("Timed out waiting for agent_report");
    }

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root-renewed",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    // The first detachment persisted notify_on_terminal durably. A later explicit foreground
    // wait (even though it times out) must NOT re-promote the work to blocking, so no nudge fires.
    expect(sendMessage).not.toHaveBeenCalled();

    const persisted = config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((w) => w.id === childTaskId);
    expect(persisted?.taskAttentionPolicy).toBe("notify_on_terminal");
  });

  test("mixed descendants — nudges only for non-queue-backgrounded tasks", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const backgroundTaskId = "task-bg";
    const blockingTaskId = "task-blocking";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task-bg", backgroundTaskId, {
          name: "agent_explore_bg",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
        projectWorkspace(projectPath, "child-task-blocking", blockingTaskId, {
          name: "agent_explore_blocking",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const waitPromise = taskService.waitForAgentReport(backgroundTaskId, {
      requestingWorkspaceId: rootWorkspaceId,
      backgroundOnMessageQueued: true,
    });
    expect(taskService.backgroundForegroundWaitsForWorkspace(rootWorkspaceId)).toBe(1);
    const waitError = await waitPromise.catch((error: unknown) => error);
    expect(waitError).toBeInstanceOf(ForegroundWaitBackgroundedError);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(blockingTaskId),
      expect.objectContaining({
        model: "openai:gpt-5.2",
        thinkingLevel: "medium",
      }),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(backgroundTaskId),
      expect.anything(),
      expect.anything()
    );
  });

  test("auto-resume preserves parent agentId from stream-end event metadata", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2", agentId: "plan" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(childTaskId),
      expect.objectContaining({
        agentId: "plan",
      }),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("auto-resume preserves parent agentId from history when stream-end metadata omits agentId", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const appendResult = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage(
        "assistant-root-history",
        "assistant",
        "Parent is currently running in plan mode.",
        { timestamp: Date.now(), agentId: "plan" }
      )
    );
    expect(appendResult.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(childTaskId),
      expect.objectContaining({
        agentId: "plan",
      }),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("auto-resume falls back to exec agentId when metadata and history lack agentId", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(childTaskId),
      expect.objectContaining({
        agentId: "exec",
      }),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("terminal report resumes the parent from history without a handoff prompt", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        {
          path: path.join(projectPath, "child-task"),
          id: childTaskId,
          name: "agent_explore_child",
          parentWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        },
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage, resumeStream } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const appendResult = await historyService.appendToHistory(
      parentWorkspaceId,
      createMuxMessage(
        "assistant-parent-history",
        "assistant",
        "Parent is currently running in plan mode.",
        { timestamp: Date.now(), agentId: "plan" }
      )
    );
    expect(appendResult.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Hello from child",
            title: "Result",
          },
          state: "output-available",
          output: {
            success: true,
            report: {
              reportMarkdown: "Hello from child",
              title: "Result",
              structuredOutput: { claims: ["fast handoff"] },
            },
          },
        },
        { type: "text", text: "Hello from child" },
      ],
    });

    // The terminal report resumes the parent through the async attention drain.
    await Promise.all([
      ...(taskService as unknown as { pendingTerminalAttentionDrains: Set<Promise<void>> })
        .pendingTerminalAttentionDrains,
    ]);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(resumeStream).toHaveBeenCalledWith(
      parentWorkspaceId,
      expect.objectContaining({ agentId: "plan" }),
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );

    const parentHistory = await collectFullHistory(historyService, parentWorkspaceId);
    const serializedParentHistory = JSON.stringify(parentHistory);
    expect(serializedParentHistory).toContain("<mux_subagent_report>");
    expect(serializedParentHistory).toContain("structuredOutput");
    expect(serializedParentHistory).toContain("claims");
    expect(serializedParentHistory).not.toContain("Background sub-agent task(s) have completed");
  });

  test("terminal report cuts a busy parent's turn with one coalesced tool-end wake", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-busy-111";
    const childTaskId = "task-busy-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        {
          path: path.join(projectPath, "child-task"),
          id: childTaskId,
          name: "agent_explore_child",
          parentWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        },
      ],
      testTaskSettings()
    );

    // The parent is mid-turn (for example blocked in a task_await on other tasks).
    let parentStreaming = true;
    const { aiService } = createAIServiceMocks(config, {
      isStreaming: mock(
        (workspaceId: string) => workspaceId === parentWorkspaceId && parentStreaming
      ),
    });
    const liveTurn = Symbol("parent-turn");
    const { workspaceService, sendMessage, resumeStream } = createWorkspaceServiceMocks({
      getActiveTurnGeneration: mock(() => (parentStreaming ? liveTurn : undefined)),
    });
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    // The launch turn disabled bash. The wake starts a fresh turn at a time the child's report
    // chooses, so it must keep that restriction like the idle drain's wake does.
    const restrictedPolicy = [{ regex_match: "^bash$", action: "disable" as const }];
    await historyService.appendToHistory(
      parentWorkspaceId,
      createMuxMessage("manual-restricted", "user", "coordinate the children", {
        timestamp: 1_000,
        toolPolicy: restrictedPolicy,
      })
    );
    const drainAll = async () => {
      await Promise.all([
        ...(taskService as unknown as { pendingTerminalAttentionDrains: Set<Promise<void>> })
          .pendingTerminalAttentionDrains,
      ]);
    };

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: {
            success: true,
            report: { reportMarkdown: "Hello from child", title: "Result" },
          },
        },
        { type: "text", text: "Hello from child" },
      ],
    });
    await drainAll();

    // The report is durable in history, and a tool-end wake is queued instead of waiting for idle.
    const parentHistory = JSON.stringify(
      await collectFullHistory(historyService, parentWorkspaceId)
    );
    expect(parentHistory).toContain("<mux_subagent_report>");
    expect(resumeStream).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      parentWorkspaceId,
      // The shared opening is what classifies the row as a background wake in the UI/timeline.
      expect.stringContaining(BACKGROUND_WORK_WAKE_OPENINGS.subagentsCompleted),
      expect.objectContaining({ queueDispatchMode: "tool-end", toolPolicy: restrictedPolicy }),
      expect.objectContaining({
        synthetic: true,
        agentInitiated: true,
        promoteAheadOfHiddenTurnEnd: true,
        yieldToPreflightSends: true,
      })
    );
    // Keyed so reports arriving before the wake dispatches coalesce into one queued turn.
    const wakeInternal = sendMessage.mock.calls[0]?.[3] as { queueDedupeKey?: unknown } | undefined;
    expect(typeof wakeInternal?.queueDedupeKey).toBe("string");

    // Edge-triggered: later busy drains (sweeps, other stream-ends) do not re-cut for the same report.
    taskService.scheduleTerminalAttentionDrain(parentWorkspaceId);
    await drainAll();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Once idle, the normal drain still owns delivery for reports no turn has answered yet.
    parentStreaming = false;
    taskService.scheduleTerminalAttentionDrain(parentWorkspaceId);
    await drainAll();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(resumeStream).toHaveBeenCalledWith(
      parentWorkspaceId,
      expect.anything(),
      expect.objectContaining({ acceptanceOrigin: "automatic" })
    );
  });

  for (const [name, wakeWouldLead, replaceTurnAfterDelivery, expectCut] of [
    // Hidden turn-end entries (peer messages, heartbeats) are overtaken by the promoted wake.
    ["only hidden turn-end work is queued", true, false, true],
    // Security: a queued user-authored message may carry stricter restrictions not yet in
    // history, and the wake could not overtake it.
    ["user input is already queued", false, false, false],
    // The delivery-time turn ended and a successor (which loaded the report) is streaming.
    ["the delivery-time turn was replaced", true, true, false],
  ] satisfies Array<[string, boolean, boolean, boolean]>) {
    test(`busy parent cut when ${name}: ${expectCut ? "cuts" : "defers to idle"}`, async () => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      const parentWorkspaceId = "parent-nocut-111";
      const childTaskId = "task-nocut-222";
      await saveWorkspaces(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "parent", parentWorkspaceId, {
            aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
          }),
          {
            path: path.join(projectPath, "child-task"),
            id: childTaskId,
            name: "agent_explore_child",
            parentWorkspaceId,
            agentType: "explore",
            taskStatus: "running",
            taskModelString: "openai:gpt-5.2",
            taskThinkingLevel: "medium",
          },
        ],
        testTaskSettings()
      );
      const { aiService } = createAIServiceMocks(config, {
        isStreaming: mock((workspaceId: string) => workspaceId === parentWorkspaceId),
      });
      const deliveryTurn = Symbol("delivery-turn");
      const successorTurn = Symbol("successor-turn");
      let replaced = false;
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
        getActiveTurnGeneration: mock(() => (replaced ? successorTurn : deliveryTurn)),
        hasQueuedMessages: mock(() => true),
        promotedToolEndWouldLeadQueue: mock(() => wakeWouldLead),
        // The parent never goes idle in this test; without this the busy drain would re-poll.
        waitForIdleAndNoQueuedMessages: mock(() => new Promise<void>(() => undefined)),
      });
      const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
      // Swap the live turn right after the notification is enqueued (and its turn captured),
      // before the drain it schedules can cut.
      const enqueue = taskService.enqueueTerminalAttention.bind(taskService);
      spyOn(taskService, "enqueueTerminalAttention").mockImplementation(async (params) => {
        await enqueue(params);
        replaced = replaceTurnAfterDelivery;
      });

      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: childTaskId,
        messageId: "assistant-child-output",
        metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
        parts: [{ type: "text", text: "Hello from child" }],
      });
      await Promise.all([
        ...(taskService as unknown as { pendingTerminalAttentionDrains: Set<Promise<void>> })
          .pendingTerminalAttentionDrains,
      ]);

      expect(sendMessage).toHaveBeenCalledTimes(expectCut ? 1 : 0);
    });
  }

  test("a report left pending from an earlier delivery never cuts a later busy turn", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { aiService } = createAIServiceMocks(config, {
      isStreaming: mock((workspaceId: string) => workspaceId === parentId),
    });
    const { workspaceService, sendMessage, resumeStream } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    // Pending on disk but not delivered by this process (e.g. across a restart, or correlated
    // with an older delegated continuation): the idle drain owns it, not a mid-turn cut.
    const notification = await new TerminalAttentionStore(config).enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "earlier-child",
    });
    assert(notification);
    taskService.scheduleTerminalAttentionDrain(parentId);
    await Promise.all([
      ...(taskService as unknown as { pendingTerminalAttentionDrains: Set<Promise<void>> })
        .pendingTerminalAttentionDrains,
    ]);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(resumeStream).not.toHaveBeenCalled();
  });

  // Track 2 r5: mux.events() in the parent's persistent sandbox mount depends on
  // finalizeAgentTaskReport invoking the sandbox host hook — without it, spawned-task
  // completions never reach the guest queue in production.
  test("terminal report posts a task-terminal event to the parent's sandbox mount", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-sandbox-evt";
    const childTaskId = "task-sandbox-evt";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    // Real impl runs (no live mount for this scope => harmless no-op); calls are recorded.
    const postSpy = spyOn(sandboxHostService, "postTaskTerminalEvent");
    try {
      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: childTaskId,
        messageId: "assistant-child-output",
        metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "agent-report-call-1",
            toolName: "agent_report",
            input: { reportMarkdown: "Spawned child done", title: "Result" },
            state: "output-available",
            output: {
              success: true,
              report: { reportMarkdown: "Spawned child done", title: "Result" },
            },
          },
          // The terminal report requires a final assistant text response
          // (resolveFinalAgentReportArgs derives reportMarkdown from it).
          { type: "text", text: "Spawned child done" },
        ],
      });

      expect(postSpy).toHaveBeenCalledTimes(1);
      expect(postSpy).toHaveBeenCalledWith(parentWorkspaceId, {
        taskId: childTaskId,
        status: "completed",
        reportMarkdown: "Spawned child done",
      });
    } finally {
      postSpy.mockRestore();
    }
  });

  test("foreground waiter suppresses the sandbox task-terminal event", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-sandbox-fg";
    const childTaskId = "task-sandbox-fg";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const postSpy = spyOn(sandboxHostService, "postTaskTerminalEvent");
    try {
      // Blocking consumption (mux.task / task_await) already delivers the report
      // directly; the guest queue must not double-deliver it.
      const waitPromise = taskService.waitForAgentReport(childTaskId, {
        requestingWorkspaceId: parentWorkspaceId,
      });

      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: childTaskId,
        messageId: "assistant-child-output",
        metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "agent-report-call-1",
            toolName: "agent_report",
            input: { reportMarkdown: "Awaited child done", title: "Result" },
            state: "output-available",
            output: {
              success: true,
              report: { reportMarkdown: "Awaited child done", title: "Result" },
            },
          },
          { type: "text", text: "Awaited child done" },
        ],
      });

      const report = await waitPromise;
      expect(report.reportMarkdown).toBe("Awaited child done");
      expect(postSpy).not.toHaveBeenCalled();
    } finally {
      postSpy.mockRestore();
    }
  });

  test("waitForAgentReport surfaces the child's report-time AI settings", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-report-settings";
    const childTaskId = "task-report-settings";

    // The persisted settings at report time differ from any launch-time snapshot a
    // caller may hold (e.g. after a plan-to-exec handoff rewrote them).
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        {
          path: path.join(projectPath, "child-task"),
          id: childTaskId,
          name: "agent_exec_child",
          parentWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "anthropic:claude-opus-5",
          taskThinkingLevel: "high",
        },
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "assistant-child-report-settings",
      metadata: { model: "anthropic:claude-opus-5", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-settings-call",
          toolName: "agent_report",
          input: { reportMarkdown: "Done", title: "Result" },
          state: "output-available",
          output: {
            success: true,
            report: { reportMarkdown: "Done", title: "Result" },
          },
        },
        { type: "text", text: "Done" },
      ],
    });

    const report = await taskService.waitForAgentReport(childTaskId, {
      requestingWorkspaceId: parentWorkspaceId,
    });
    expect(report.model).toBe("anthropic:claude-opus-5");
    expect(report.thinkingLevel).toBe("high");
  });

  test("workflow-owned child reports do not resume the parent directly", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-workflow-report";
    const childTaskId = "task-workflow-report";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "workflow-child", childTaskId, {
          parentWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
          workflowTask: { runId: "wfr_report_handoff", stepId: "collect" },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "assistant-workflow-child-output",
      metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Workflow step report",
            title: "Workflow Step",
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Workflow step report" },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const parentHistory = await collectFullHistory(historyService, parentWorkspaceId);
    expect(JSON.stringify(parentHistory)).not.toContain("<mux_subagent_report>");
  });
});
