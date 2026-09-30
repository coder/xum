import * as path from "path";
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import type { Config } from "@/node/config";
import { type Workspace as WorkspaceConfigEntry } from "@/node/config";
import * as subagentGitPatchArtifacts from "@/node/services/subagentGitPatchArtifacts";
import {
  readSubagentReportArtifact,
  upsertSubagentReportArtifact,
} from "@/node/services/subagentReportArtifacts";
import {
  readSubagentFailureArtifact,
  upsertSubagentFailureArtifact,
} from "@/node/services/subagentFailureArtifacts";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { log } from "@/node/services/log";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { Ok, Err, type Result } from "@/common/types/result";
import { formatSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import type { AgentAiDefaults, AgentAiSubagentProfile } from "@/common/types/agentAiDefaults";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage } from "@/common/types/message";
import { isDynamicToolPart, type DynamicToolPart } from "@/common/types/toolParts";
import assert from "node:assert";
import {
  createAIServiceMocks,
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  mergeTestAgentAiDefaults,
  projectWorkspace,
  saveWorkspaces,
  streamEnd,
  streamError,
  stubStableIds,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  collectFullHistory,
  createAgentTask,
  createBestOfTaskServiceTestHarness,
  createConfigBackedRemoveMock,
  createNullInitLogger,
  createTaskServiceHarness,
  flushTerminalAttentionDrains,
  getTaskToolPart,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
  removeWorkspaceFromTestConfig,
  upsertTestSubagentReports,
  writePendingBestOfParentPartial,
} from "@/node/services/taskService.shared.testHarness";

describe("TaskService", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  test("parent stream-end rechecks cleanup for reported best-of children", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-cleanup-recheck";
    const childOneId = "child-best-of-cleanup-recheck-1";
    const childTwoId = "child-best-of-cleanup-recheck-2";
    const bestOf = { groupId: "best-of-cleanup-recheck", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: parentId,
      messageId: "assistant-parent-cleanup-recheck",
      metadata: { model: "test-model" },
      parts: [],
    });

    const parentHistory = await collectFullHistory(historyService, parentId);
    expect(JSON.stringify(parentHistory)).not.toContain("<mux_subagent_report>");

    const remainingTaskIds = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .map((workspace) => workspace.id)
      .filter((id): id is string => typeof id === "string");
    expect(remainingTaskIds).toContain(childOneId);
    expect(remainingTaskIds).toContain(childTwoId);

    expect(remove).not.toHaveBeenCalled();
  });

  test("parent stream-end targets the pending best-of group when older groups still exist", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-pending-group-target";
    const staleChildOneId = "child-best-of-pending-group-target-stale-1";
    const staleChildTwoId = "child-best-of-pending-group-target-stale-2";
    const currentChildOneId = "child-best-of-pending-group-target-current-1";
    const currentChildTwoId = "child-best-of-pending-group-target-current-2";
    const partialTimestamp = Date.now();
    const staleCreatedAt = new Date(partialTimestamp - 60_000).toISOString();
    const currentCreatedAt = new Date(partialTimestamp + 60_000).toISOString();

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "stale-1", staleChildOneId, {
          name: "agent_explore_stale_1",
          title: "Best of 2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: staleCreatedAt,
          bestOf: { groupId: "best-of-stale-group", index: 0, total: 2 },
        }),
        projectWorkspace(projectPath, "stale-2", staleChildTwoId, {
          name: "agent_explore_stale_2",
          title: "Best of 2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: staleCreatedAt,
          bestOf: { groupId: "best-of-stale-group", index: 1, total: 2 },
        }),
        projectWorkspace(projectPath, "current-1", currentChildOneId, {
          name: "agent_explore_current_1",
          title: "Best of 2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: currentCreatedAt,
          bestOf: { groupId: "best-of-current-group", index: 0, total: 2 },
        }),
        projectWorkspace(projectPath, "current-2", currentChildTwoId, {
          name: "agent_explore_current_2",
          title: "Best of 2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: currentCreatedAt,
          bestOf: { groupId: "best-of-current-group", index: 1, total: 2 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-pending-group-target",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: partialTimestamp },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-pending-group-target-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    for (const [childTaskId, reportMarkdown, title] of [
      [staleChildOneId, "Stale report one", "Stale option one"],
      [staleChildTwoId, "Stale report two", "Stale option two"],
      [currentChildOneId, "Current report one", "Current option one"],
      [currentChildTwoId, "Current report two", "Current option two"],
    ] as const) {
      await upsertSubagentReportArtifact({
        workspaceId: parentId,
        workspaceSessionDir: path.join(config.sessionsDir, parentId),
        childTaskId,
        parentWorkspaceId: parentId,
        ancestorWorkspaceIds: [parentId],
        reportMarkdown,
        title,
        nowMs: Date.now(),
      });
    }

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: parentId,
      messageId: "assistant-parent-pending-group-target",
      metadata: { model: "test-model" },
      parts: [],
    });

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (part) => isDynamicToolPart(part) && part.toolName === "task"
      ) as (DynamicToolPart & { state: string; output?: unknown }) | undefined;
      expect(toolPart?.state).toBe("output-available");
      const outputJson = JSON.stringify(toolPart?.output);
      expect(outputJson).toContain(currentChildOneId);
      expect(outputJson).toContain(currentChildTwoId);
      expect(outputJson).toContain("Current report one");
      expect(outputJson).toContain("Current report two");
      expect(outputJson).not.toContain(staleChildOneId);
      expect(outputJson).not.toContain(staleChildTwoId);
      expect(outputJson).not.toContain("Stale report one");
      expect(outputJson).not.toContain("Stale report two");
    }
  });

  test("parent stream-end ignores a stale single best-of group that predates the pending partial", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-stale-single-group";
    const childOneId = "child-best-of-stale-single-group-1";
    const childTwoId = "child-best-of-stale-single-group-2";
    const partialTimestamp = Date.now();
    const staleCreatedAt = new Date(partialTimestamp - 60_000).toISOString();
    const bestOf = { groupId: "best-of-stale-single-group", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          title: "Best of 2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: staleCreatedAt,
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          title: "Best of 2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: staleCreatedAt,
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-stale-single-group",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: partialTimestamp },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-stale-single-group-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    const parentSessionDir = path.join(config.sessionsDir, parentId);
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Stale report one",
      title: "Stale option one",
      nowMs: Date.now(),
    });
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childTwoId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Stale report two",
      title: "Stale option two",
      nowMs: Date.now(),
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: parentId,
      messageId: "assistant-parent-stale-single-group",
      metadata: { model: "test-model" },
      parts: [],
    });

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (part) => isDynamicToolPart(part) && part.toolName === "task"
      ) as (DynamicToolPart & { state: string; output?: unknown }) | undefined;
      expect(toolPart?.state).toBe("input-available");
      expect(toolPart?.output).toBeUndefined();
    }

    const parentHistory = await collectFullHistory(historyService, parentId);
    const serializedParentHistory = JSON.stringify(parentHistory);
    expect(serializedParentHistory).not.toContain("<mux_subagent_report>");
    expect(serializedParentHistory).not.toContain("Stale report one");
    expect(serializedParentHistory).not.toContain("Stale report two");
  });

  test("parent stream-end finalizes ready best-of partials before cleanup rechecks", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-finalize-ready";
    const childOneId = "child-best-of-finalize-ready-1";
    const childTwoId = "child-best-of-finalize-ready-2";
    const partialTimestamp = Date.now();
    const currentCreatedAt = new Date(partialTimestamp + 60_000).toISOString();
    const bestOf = { groupId: "best-of-finalize-ready", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: currentCreatedAt,
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: currentCreatedAt,
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-finalize-ready",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: partialTimestamp },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-finalize-ready-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    const parentSessionDir = path.join(config.sessionsDir, parentId);
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Report from child one",
      title: "Option one",
      nowMs: Date.now(),
    });
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childTwoId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Report from child two",
      title: "Option two",
      nowMs: Date.now(),
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: parentId,
      messageId: "assistant-parent-finalize-ready",
      metadata: { model: "test-model" },
      parts: [],
    });

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as
        | {
            toolName: string;
            state: string;
            output?: unknown;
          }
        | undefined;
      expect(toolPart?.toolName).toBe("task");
      expect(toolPart?.state).toBe("output-available");
      const outputJson = JSON.stringify(toolPart?.output);
      expect(outputJson).toContain(childOneId);
      expect(outputJson).toContain(childTwoId);
      expect(outputJson).toContain("Report from child one");
      expect(outputJson).toContain("Report from child two");
    }

    const remainingTaskIds = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .map((workspace) => workspace.id)
      .filter((id): id is string => typeof id === "string");
    expect(remainingTaskIds).toContain(childOneId);
    expect(remainingTaskIds).toContain(childTwoId);

    expect(remove).not.toHaveBeenCalled();
  });

  test("concurrent deferred best-of fallback delivery does not duplicate synthetic reports", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-concurrent-deferred-fallback";
    const childOneId = "child-best-of-concurrent-deferred-fallback-1";
    const childTwoId = "child-best-of-concurrent-deferred-fallback-2";
    const childThreeId = "child-best-of-concurrent-deferred-fallback-3";
    const bestOf = {
      groupId: "best-of-concurrent-deferred-fallback-group",
      index: 0,
      total: 3,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 1 },
        }),
        projectWorkspace(projectPath, "child-3", childThreeId, {
          name: "agent_explore_child_3",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 2 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-concurrent-deferred-fallback",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-concurrent-deferred-fallback-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 3",
            n: 3,
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Report from child one",
      title: "Option one",
      structuredOutput: { score: 1 },
      nowMs: Date.now(),
    });

    const internal = taskService as unknown as {
      deliverDeferredBestOfSiblingReports: (params: {
        parentWorkspaceId: string;
        groupId: string;
        total: number;
      }) => Promise<void>;
    };

    await Promise.all([
      internal.deliverDeferredBestOfSiblingReports({
        parentWorkspaceId: parentId,
        groupId: bestOf.groupId,
        total: bestOf.total,
      }),
      internal.deliverDeferredBestOfSiblingReports({
        parentWorkspaceId: parentId,
        groupId: bestOf.groupId,
        total: bestOf.total,
      }),
    ]);

    const parentHistory = await collectFullHistory(historyService, parentId);
    const serializedParentHistory = JSON.stringify(parentHistory);
    expect(serializedParentHistory).toContain("<mux_subagent_report>");
    expect(serializedParentHistory).toContain("Report from child one");
    expect(serializedParentHistory).toContain("structuredOutput");
    expect(serializedParentHistory).toContain("score");
    expect(
      serializedParentHistory.match(/child-best-of-concurrent-deferred-fallback-1/g)
    ).toHaveLength(1);
  });

  test("deferred fallback honors partial task outputs carrying unknown future fields", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-future-fields-fallback";
    const childOneId = "child-best-of-future-fields-fallback-1";
    const childTwoId = "child-best-of-future-fields-fallback-2";
    const childThreeId = "child-best-of-future-fields-fallback-3";
    const bestOf = {
      groupId: "best-of-future-fields-fallback-group",
      index: 0,
      total: 3,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 1 },
        }),
        projectWorkspace(projectPath, "child-3", childThreeId, {
          name: "agent_explore_child_3",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 2 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    // An output written by a newer release: extra fields fail the strict result schema, but
    // the referenced-task bookkeeping must still see these IDs or recovery would append a
    // duplicate fallback report after a downgrade.
    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-future-fields-fallback",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-future-fields-fallback-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 3",
            n: 3,
          },
          state: "output-available",
          output: {
            status: "running",
            taskIds: [childOneId, childTwoId, childThreeId],
            tasks: [
              { taskId: childOneId, status: "completed", futureRowField: "x" },
              { taskId: childTwoId, status: "running" },
              { taskId: childThreeId, status: "running" },
            ],
            note: "use task_await to monitor progress",
            futureTopLevelField: "y",
          },
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Report from child one",
      title: "Option one",
      nowMs: Date.now(),
    });

    const internal = taskService as unknown as {
      deliverDeferredBestOfSiblingReports: (params: {
        parentWorkspaceId: string;
        groupId: string;
        total: number;
      }) => Promise<void>;
    };

    await internal.deliverDeferredBestOfSiblingReports({
      parentWorkspaceId: parentId,
      groupId: bestOf.groupId,
      total: bestOf.total,
    });

    const parentHistory = await collectFullHistory(historyService, parentId);
    const serializedParentHistory = JSON.stringify(parentHistory);
    expect(serializedParentHistory).not.toContain("<mux_subagent_report>");
    expect(serializedParentHistory).not.toContain("Report from child one");
  });

  test("incremental best-of updates do not suppress deferred terminal reports", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-progress-fallback";
    const childOneId = "child-best-of-progress-fallback-1";
    const childTwoId = "child-best-of-progress-fallback-2";
    const bestOf = { groupId: "best-of-progress-fallback-group", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child-1", childOneId, {
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          bestOf,
        }),
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    expect(
      (
        await historyService.appendToHistory(
          parentId,
          createMuxMessage(
            "progress-report",
            "user",
            formatSubagentReportEnvelope({
              taskId: childOneId,
              agentType: "explore",
              status: "in_progress",
              title: "Finding",
              reportMarkdown: "Early finding",
            }),
            { timestamp: Date.now(), synthetic: true }
          )
        )
      ).success
    ).toBe(true);
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Terminal result",
      nowMs: Date.now(),
    });

    const internal = taskService as unknown as {
      deliverDeferredBestOfSiblingReports: (params: {
        parentWorkspaceId: string;
        groupId: string;
        total: number;
      }) => Promise<void>;
    };
    await internal.deliverDeferredBestOfSiblingReports({
      parentWorkspaceId: parentId,
      groupId: bestOf.groupId,
      total: bestOf.total,
    });

    const serialized = JSON.stringify(await collectFullHistory(historyService, parentId));
    expect(serialized).toContain("Early finding");
    expect(serialized).toContain("Terminal result");
  });

  test("completed best-of reports may quote the in-progress status tag without bypassing dedupe", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-status-quote";
    const childOneId = "child-best-of-status-quote-1";
    const childTwoId = "child-best-of-status-quote-2";
    const bestOf = { groupId: "best-of-status-quote-group", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child-1", childOneId, {
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          bestOf,
        }),
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const quoted = "Terminal report quoting <status>in_progress</status>.";
    expect(
      (
        await historyService.appendToHistory(
          parentId,
          createMuxMessage(
            "completed-report",
            "user",
            formatSubagentReportEnvelope({
              taskId: childOneId,
              agentType: "explore",
              status: "completed",
              title: "Result",
              reportMarkdown: quoted,
            }),
            { timestamp: Date.now(), synthetic: true }
          )
        )
      ).success
    ).toBe(true);
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: quoted,
      nowMs: Date.now(),
    });

    const internal = taskService as unknown as {
      deliverDeferredBestOfSiblingReports: (params: {
        parentWorkspaceId: string;
        groupId: string;
        total: number;
      }) => Promise<void>;
    };
    await internal.deliverDeferredBestOfSiblingReports({
      parentWorkspaceId: parentId,
      groupId: bestOf.groupId,
      total: bestOf.total,
    });

    const serialized = JSON.stringify(await collectFullHistory(historyService, parentId));
    expect(serialized.match(/Terminal report quoting/g)).toHaveLength(1);
  });

  test("concurrent direct and deferred best-of fallback delivery does not duplicate reports", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-concurrent-direct-fallback";
    const childOneId = "child-best-of-concurrent-direct-fallback-1";
    const childTwoId = "child-best-of-concurrent-direct-fallback-2";
    const bestOf = {
      groupId: "best-of-concurrent-direct-fallback-group",
      index: 0,
      total: 2,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-concurrent-direct-fallback",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-concurrent-direct-fallback-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Report from child one",
      title: "Option one",
      nowMs: Date.now(),
    });

    const cfg = config.loadConfigOrDefault();
    const childOneEntry = Array.from(cfg.projects.entries())
      .flatMap(([projectPathEntry, project]) =>
        project.workspaces.map((workspace) => ({ projectPath: projectPathEntry, workspace }))
      )
      .find((entry) => entry.workspace.id === childOneId);
    if (!childOneEntry) {
      throw new Error("Expected child one entry to exist");
    }

    const internal = taskService as unknown as {
      deliverReportToParent: (
        parentWorkspaceId: string,
        childWorkspaceId: string,
        childEntry: { projectPath: string; workspace: unknown },
        report: { reportMarkdown: string; title?: string }
      ) => Promise<void>;
      deliverDeferredBestOfSiblingReports: (params: {
        parentWorkspaceId: string;
        groupId: string;
        total: number;
      }) => Promise<void>;
    };

    await Promise.all([
      internal.deliverReportToParent(parentId, childOneId, childOneEntry, {
        reportMarkdown: "Report from child one",
        title: "Option one",
      }),
      internal.deliverDeferredBestOfSiblingReports({
        parentWorkspaceId: parentId,
        groupId: bestOf.groupId,
        total: bestOf.total,
      }),
    ]);

    const parentHistory = await collectFullHistory(historyService, parentId);
    const serializedParentHistory = JSON.stringify(parentHistory);
    expect(serializedParentHistory).toContain("<mux_subagent_report>");
    expect(serializedParentHistory).toContain("Report from child one");
    expect(
      serializedParentHistory.match(/child-best-of-concurrent-direct-fallback-1/g)
    ).toHaveLength(1);
  });

  test("initialize finalizes ready best-of partials before cleanup rechecks", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-initialize-finalize-ready";
    const childOneId = "child-best-of-initialize-finalize-ready-1";
    const childTwoId = "child-best-of-initialize-finalize-ready-2";
    const partialTimestamp = Date.now();
    const currentCreatedAt = new Date(partialTimestamp + 60_000).toISOString();
    const bestOf = { groupId: "best-of-initialize-finalize-ready", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: currentCreatedAt,
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: currentCreatedAt,
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-initialize-finalize-ready",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: partialTimestamp },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-initialize-finalize-ready-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    const parentSessionDir = path.join(config.sessionsDir, parentId);
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Report from child one",
      title: "Option one",
      nowMs: Date.now(),
    });
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childTwoId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Report from child two",
      title: "Option two",
      nowMs: Date.now(),
    });

    await taskService.initialize();

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as
        | {
            toolName: string;
            state: string;
            output?: unknown;
          }
        | undefined;
      expect(toolPart?.toolName).toBe("task");
      expect(toolPart?.state).toBe("output-available");
      const outputJson = JSON.stringify(toolPart?.output);
      expect(outputJson).toContain(childOneId);
      expect(outputJson).toContain(childTwoId);
      expect(outputJson).toContain("Report from child one");
      expect(outputJson).toContain("Report from child two");
    }

    const remainingTaskIds = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .map((workspace) => workspace.id)
      .filter((id): id is string => typeof id === "string");
    expect(remainingTaskIds).toContain(childOneId);
    expect(remainingTaskIds).toContain(childTwoId);

    expect(remove).not.toHaveBeenCalled();
  });

  test("startup best-of finalization defers while a reawakened sibling is executing again", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-reawakened-sibling";
    const childOneId = "child-best-of-reawakened-sibling-1";
    const childTwoId = "child-best-of-reawakened-sibling-2";
    const partialTimestamp = Date.now();
    const currentCreatedAt = new Date(partialTimestamp + 60_000).toISOString();
    const bestOf = {
      groupId: "best-of-reawakened-sibling",
      index: 0,
      total: 2,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: currentCreatedAt,
          bestOf,
        },
        {
          // Reported, then reawakened by a client: its old artifact is about to be replaced.
          path: path.join(projectPath, "child-2"),
          id: childTwoId,
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          taskExecutionStatus: "running",
          taskExecutionId: "wst_reawakened_child_2",
          createdAt: currentCreatedAt,
          bestOf: { ...bestOf, index: 1 },
        },
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-reawakened-sibling",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: partialTimestamp },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-reawakened-sibling-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    const parentSessionDir = path.join(config.sessionsDir, parentId);
    for (const [childTaskId, reportMarkdown] of [
      [childOneId, "Report from child one"],
      [childTwoId, "Report from child two (pre-continuation)"],
    ] as const) {
      await upsertSubagentReportArtifact({
        workspaceId: parentId,
        workspaceSessionDir: parentSessionDir,
        childTaskId,
        parentWorkspaceId: parentId,
        ancestorWorkspaceIds: [parentId],
        reportMarkdown,
        nowMs: Date.now(),
      });
    }

    await taskService.runStartupHousekeeping();

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    const toolPart = updatedParentPartial?.parts.find(
      (part) => isDynamicToolPart(part) && part.toolName === "task"
    );
    expect(toolPart && "state" in toolPart ? toolPart.state : undefined).toBe("input-available");
  });

  test("startup best-of finalization never lands on a partial a live parent turn replaced", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-superseded";
    const childOneId = "child-best-of-superseded-1";
    const childTwoId = "child-best-of-superseded-2";
    const partialTimestamp = Date.now();
    const currentCreatedAt = new Date(partialTimestamp + 60_000).toISOString();
    const bestOf = { groupId: "best-of-superseded", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child-1", childOneId, {
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: currentCreatedAt,
          bestOf,
        }),
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: currentCreatedAt,
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const crashPartial = createMuxMessage(
      "assistant-parent-best-of-superseded-crash",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: partialTimestamp },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-superseded-call",
          toolName: "task",
          input: { subagent_type: "explore", prompt: "compare options", title: "Best of 2", n: 2 },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, crashPartial)).success).toBe(true);
    const parentSessionDir = path.join(config.sessionsDir, parentId);
    for (const [childTaskId, reportMarkdown] of [
      [childOneId, "Report from child one"],
      [childTwoId, "Report from child two"],
    ] as const) {
      await upsertSubagentReportArtifact({
        workspaceId: parentId,
        workspaceSessionDir: parentSessionDir,
        childTaskId,
        parentWorkspaceId: parentId,
        ancestorWorkspaceIds: [parentId],
        reportMarkdown,
        nowMs: Date.now(),
      });
    }

    // A parent turn that starts while finalization is still assembling the grouped output
    // commits the crash partial and writes its own under a new message id. Finalization reads
    // the crash partial once to resolve the group and once more to finalize; the turn lands
    // right after that second read.
    const liveTurnPartial = createMuxMessage(
      "assistant-parent-best-of-superseded-live-turn",
      "assistant",
      "Working on the follow-up…",
      { timestamp: partialTimestamp + 120_000 },
      []
    );
    const originalReadPartial = partialService.readPartial.bind(partialService);
    let crashPartialReads = 0;
    const readPartialSpy = spyOn(partialService, "readPartial").mockImplementation(
      async (workspaceId: string) => {
        const current = await originalReadPartial(workspaceId);
        if (workspaceId === parentId && current?.id === crashPartial.id) {
          crashPartialReads += 1;
          if (crashPartialReads === 2) {
            await partialService.writePartial(parentId, liveTurnPartial);
          }
        }
        return current;
      }
    );
    try {
      await taskService.runStartupHousekeeping();
    } finally {
      readPartialSpy.mockRestore();
    }

    const parentPartial = await partialService.readPartial(parentId);
    expect(parentPartial?.id).toBe(liveTurnPartial.id);
    expect(
      parentPartial?.parts.some((p) => (p as { type?: unknown }).type === "dynamic-tool")
    ).toBe(false);
  });

  test("initialize finalizes ready legacy variants partials", async () => {
    const parentId = "parent-legacy-variants-initialize";
    const childOneId = "child-legacy-variants-initialize-1";
    const childTwoId = "child-legacy-variants-initialize-2";
    const groupId = "legacy-variants-initialize-group";
    const partialTimestamp = Date.now();
    const createdAt = new Date(partialTimestamp + 60_000).toISOString();

    const { config, partialService, taskService } = await createBestOfTaskServiceTestHarness({
      rootDir,
      parentId,
      children: [
        {
          id: childOneId,
          name: "agent_explore_frontend",
          title: "Split review",
          taskStatus: "reported",
          createdAt,
          bestOf: { groupId, index: 0, total: 2 },
        },
        {
          id: childTwoId,
          name: "agent_explore_backend",
          title: "Split review",
          taskStatus: "reported",
          createdAt,
          bestOf: { groupId, index: 1, total: 2 },
        },
      ],
    });

    const configFile = path.join(config.rootDir, "config.json");
    const rawConfig = JSON.parse(await fsPromises.readFile(configFile, "utf-8")) as {
      projects: Array<[string, { workspaces: Array<Record<string, unknown>> }]>;
    };
    for (const [, project] of rawConfig.projects) {
      for (const workspace of project.workspaces) {
        if (workspace.id === childOneId) {
          workspace.bestOf = {
            groupId,
            index: 0,
            total: 2,
            kind: "variants",
            label: "frontend",
          };
        }
        if (workspace.id === childTwoId) {
          workspace.bestOf = {
            groupId,
            index: 1,
            total: 2,
            kind: "variants",
            label: "backend",
          };
        }
      }
    }
    await fsPromises.writeFile(configFile, JSON.stringify(rawConfig, null, 2));

    await writePendingBestOfParentPartial({
      partialService,
      parentId,
      messageId: "assistant-parent-legacy-variants-initialize",
      toolCallId: "task-legacy-variants-initialize-call",
      title: "Split review",
      legacyVariants: ["frontend", "backend"],
      prompt: "Review ${variant} for regressions",
      timestamp: partialTimestamp,
    });
    await upsertTestSubagentReports({
      config,
      parentId,
      reports: [
        { childTaskId: childOneId, reportMarkdown: "Frontend findings", title: "Frontend" },
        { childTaskId: childTwoId, reportMarkdown: "Backend findings", title: "Backend" },
      ],
    });

    await taskService.initialize();

    const toolPart = getTaskToolPart(await partialService.readPartial(parentId));
    expect(toolPart?.state).toBe("output-available");
    const serializedOutput = JSON.stringify(toolPart?.output);
    expect(serializedOutput).toContain("Frontend findings");
    expect(serializedOutput).toContain("Backend findings");
  });

  async function setupPlanModeStreamEndHarness(options?: {
    childAgentId?: string;
    childTaskStatus?: WorkspaceConfigEntry["taskStatus"];
    childAiSettingsByAgent?: WorkspaceConfigEntry["aiSettingsByAgent"];
    workflowTask?: WorkspaceConfigEntry["workflowTask"];
    projectName?: string;
    maxTaskNestingDepth?: number;
    parentAiSettingsByAgent?: Record<string, { model: string; thinkingLevel: ThinkingLevel }>;
    agentAiDefaults?: AgentAiDefaults;
    subagentAiDefaults?: Record<string, AgentAiSubagentProfile>;
    sendMessageOverride?: ReturnType<typeof mock>;
    aiServiceOverrides?: Parameters<typeof createAIServiceMocks>[1];
  }) {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-plan-222";
    const childAgentId = options?.childAgentId ?? "plan";
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const parentWorkspacePath = path.join(projectPath, "parent");
    const childWorkspacePath = path.join(projectPath, "child-plan");

    if (childAgentId !== "plan") {
      const customAgentDir = path.join(parentWorkspacePath, ".mux", "agents");
      await fsPromises.mkdir(customAgentDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(customAgentDir, `${childAgentId}.md`),
        [
          "---",
          "name: Custom Plan Agent",
          "base: plan",
          "subagent:",
          "  runnable: true",
          "---",
          "Custom plan-like subagent used by taskService tests.",
          "",
        ].join("\n")
      );
    }

    const agentAiDefaults = mergeTestAgentAiDefaults(
      options?.agentAiDefaults,
      options?.subagentAiDefaults
    );

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentWorkspacePath,
          id: parentId,
          name: "parent",
          runtimeConfig,
          aiSettingsByAgent: options?.parentAiSettingsByAgent,
        },
        {
          path: childWorkspacePath,
          id: childId,
          name: "agent_plan_child",
          parentWorkspaceId: parentId,
          agentId: childAgentId,
          agentType: childAgentId,
          taskStatus: options?.childTaskStatus ?? "running",
          workflowTask: options?.workflowTask,
          aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "max" },
          aiSettingsByAgent: options?.childAiSettingsByAgent,
          taskModelString: "openai:gpt-4o-mini",
          runtimeConfig,
        },
      ],
      {
        taskSettings: {
          maxParallelAgentTasks: 3,
          maxTaskNestingDepth: options?.maxTaskNestingDepth ?? 3,
        },
        agentAiDefaults,
      }
    );

    const getInfo = mock(() => ({
      id: childId,
      name: "agent_plan_child",
      projectName: options?.projectName ?? "repo",
      projectPath,
      runtimeConfig,
      namedWorkspacePath: childWorkspacePath,
    }));
    const replaceHistory = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      getInfo,
      replaceHistory,
      sendMessage: options?.sendMessageOverride,
    });

    const { aiService, createModel } = createAIServiceMocks(config, options?.aiServiceOverrides);
    const { taskService } = createTaskServiceHarness(config, { workspaceService, aiService });

    return {
      config,
      projectPath,
      childId,
      sendMessage,
      replaceHistory,
      createModel,
      taskService,
    };
  }

  function makeSuccessfulProposePlanStreamEndEvent(workspaceId: string): StreamEndEvent {
    return {
      type: "stream-end",
      workspaceId,
      messageId: "assistant-plan-output",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "propose-plan-call-1",
          toolName: "propose_plan",
          state: "output-available",
          output: { success: true, planPath: "/tmp/test-plan.md" },
          input: { plan: "test plan" },
        },
      ],
    };
  }

  test("stream-end with propose_plan success triggers handoff instead of awaiting_report reminder", async () => {
    const { config, childId, sendMessage, replaceHistory, taskService } =
      await setupPlanModeStreamEndHarness();

    await streamEnd(taskService, makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(replaceHistory).toHaveBeenCalledWith(
      childId,
      expect.anything(),
      expect.objectContaining({ mode: "append-compaction-boundary" })
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Implement the plan"),
      expect.objectContaining({
        agentId: "exec",
        model: "openai:gpt-4o-mini",
        // Thinking inherits field-wise from the plan workspace's persisted
        // settings ("max"), clamped by the resolved kickoff model's policy.
        thinkingLevel: "high",
      }),
      expect.objectContaining({ synthetic: true })
    );

    const kickoffMessage = (sendMessage as unknown as { mock: { calls: Array<[string, string]> } })
      .mock.calls[0]?.[1];
    expect(kickoffMessage).not.toContain("agent_report");

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);

    expect(updatedTask?.agentId).toBe("exec");
    expect(updatedTask?.taskStatus).toBe("running");
  });

  test("plan handoff uses the transitioning workspace Exec choice, not its parent", async () => {
    const { config, childId, sendMessage, taskService } = await setupPlanModeStreamEndHarness({
      childAiSettingsByAgent: { exec: { model: "openai:gpt-5.2", thinkingLevel: "high" } },
      parentAiSettingsByAgent: { exec: { model: "openai:gpt-5.3-codex", thinkingLevel: "medium" } },
      agentAiDefaults: { exec: { modelString: "anthropic:claude-opus-4-6" } },
    });
    await streamEnd(taskService, makeSuccessfulProposePlanStreamEndEvent(childId));
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.any(String),
      expect.objectContaining({ agentId: "exec", model: "openai:gpt-5.2", thinkingLevel: "high" }),
      expect.objectContaining({ synthetic: true })
    );
    expect(findWorkspaceInConfig(config, childId)?.taskModelString).toBe("openai:gpt-5.2");
  });

  test("plan handoff preserves a pro mode persisted under the plan agent bucket", async () => {
    // A PRO toggle during the plan phase lands in aiSettingsByAgent.plan;
    // legacy workspace.aiSettings still holds the original standard setting.
    const { config, childId, sendMessage, taskService } = await setupPlanModeStreamEndHarness({
      childAiSettingsByAgent: {
        plan: { model: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "pro" },
      },
    });

    await streamEnd(taskService, makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Implement the plan"),
      expect.objectContaining({ agentId: "exec", reasoningMode: "pro" }),
      expect.objectContaining({ synthetic: true })
    );

    // The rewritten exec-phase settings persist it too.
    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(updatedTask?.aiSettings?.reasoningMode).toBe("pro");
  });

  test("plan handoff applies a configured exec reasoning default when the plan phase ran standard", async () => {
    const { childId, sendMessage, taskService } = await setupPlanModeStreamEndHarness({
      subagentAiDefaults: {
        exec: { reasoningMode: "pro" },
      },
    });

    await streamEnd(taskService, makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Implement the plan"),
      expect.objectContaining({ agentId: "exec", reasoningMode: "pro" }),
      expect.objectContaining({ synthetic: true })
    );
  });

  test("stream-end with propose_plan success uses global exec defaults for handoff", async () => {
    const { config, childId, sendMessage, taskService } = await setupPlanModeStreamEndHarness({
      parentAiSettingsByAgent: {
        exec: {
          model: "anthropic:claude-sonnet-4-5",
          thinkingLevel: "low",
        },
      },
      agentAiDefaults: {
        exec: {
          modelString: "openai:gpt-5.3-codex",
          thinkingLevel: "xhigh",
        },
      },
    });

    await streamEnd(taskService, makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Implement the plan"),
      expect.objectContaining({
        agentId: "exec",
        model: "openai:gpt-5.3-codex",
        thinkingLevel: "xhigh",
      }),
      expect.objectContaining({ synthetic: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);

    expect(updatedTask?.agentId).toBe("exec");
    expect(updatedTask?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(updatedTask?.taskThinkingLevel).toBe("xhigh");
  });

  test("stream-end with propose_plan success uses subagent exec defaults before global exec defaults", async () => {
    const { config, childId, sendMessage, taskService } = await setupPlanModeStreamEndHarness({
      agentAiDefaults: {
        exec: {
          modelString: "openai:gpt-5.2",
          thinkingLevel: "medium",
        },
      },
      subagentAiDefaults: {
        exec: {
          modelString: "openai:gpt-5.3-codex",
          thinkingLevel: "xhigh",
        },
      },
    });

    await streamEnd(taskService, makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Implement the plan"),
      expect.objectContaining({
        agentId: "exec",
        model: "openai:gpt-5.3-codex",
        thinkingLevel: "xhigh",
      }),
      expect.objectContaining({ synthetic: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);

    expect(updatedTask?.agentId).toBe("exec");
    expect(updatedTask?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(updatedTask?.taskThinkingLevel).toBe("xhigh");
  });

  test("stream-end handoff ignores a whitespace inherited task model", async () => {
    const { config, childId, sendMessage, taskService } = await setupPlanModeStreamEndHarness();

    const preCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(preCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childEntry).toBeTruthy();
    if (!childEntry) return;

    childEntry.taskModelString = "   ";
    await config.editConfig(() => preCfg);

    await streamEnd(taskService, makeSuccessfulProposePlanStreamEndEvent(childId));

    // The whitespace frozen model must not be used verbatim; resolution falls
    // through to the plan workspace's own persisted settings.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Implement the plan"),
      expect.objectContaining({
        agentId: "exec",
        model: "anthropic:claude-opus-4-6",
      }),
      expect.objectContaining({ synthetic: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);

    expect(updatedTask?.taskModelString).toBe("anthropic:claude-opus-4-6");
  });

  test("stream-end with propose_plan success triggers handoff for custom plan-like agents", async () => {
    const { config, childId, sendMessage, replaceHistory, taskService } =
      await setupPlanModeStreamEndHarness({
        childAgentId: "custom_plan_runner",
      });

    await streamEnd(taskService, makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(replaceHistory).toHaveBeenCalledWith(
      childId,
      expect.anything(),
      expect.objectContaining({ mode: "append-compaction-boundary" })
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Implement the plan"),
      expect.objectContaining({ agentId: "exec" }),
      expect.objectContaining({ synthetic: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);

    expect(updatedTask?.agentId).toBe("exec");
    expect(updatedTask?.taskStatus).toBe("running");
  });

  test("workflow-owned plan propose_plan finalizes with plan markdown instead of exec handoff", async () => {
    const projectName = `repo-${path.basename(rootDir)}`;
    const planPath = path.join(os.homedir(), ".xum", "plans", projectName, "agent_plan_child.md");
    await fsPromises.mkdir(path.dirname(planPath), { recursive: true });
    await fsPromises.writeFile(
      planPath,
      "# Proposed workflow plan\n\nDo the tiny safe change.\n",
      "utf-8"
    );

    const debugSpy = spyOn(log, "debug").mockImplementation(() => undefined);
    try {
      const { config, childId, sendMessage, replaceHistory, taskService } =
        await setupPlanModeStreamEndHarness({
          projectName,
          workflowTask: { runId: "wfr_plan_step", stepId: "plan" },
        });

      const waiter = taskService.waitForAgentReport(childId, { timeoutMs: 5_000 });

      await streamEnd(taskService, makeSuccessfulProposePlanStreamEndEvent(childId));

      const report = await waiter;
      expect(report).toEqual({
        reportMarkdown: "# Proposed workflow plan\n\nDo the tiny safe change.\n",
        title: "Proposed plan",
        planFilePath: planPath,
        model: "openai:gpt-4o-mini",
      });
      expect(debugSpy).toHaveBeenCalledWith(
        "Workflow plan completion using canonical plan file path",
        expect.objectContaining({
          canonicalPlanPath: planPath,
          proposedPlanPath: "/tmp/test-plan.md",
        })
      );
      expect(replaceHistory).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();

      const updatedTask = findWorkspaceInConfig(config, childId);
      expect(updatedTask?.agentId).toBe("plan");
      expect(updatedTask?.taskStatus).toBe("reported");
    } finally {
      debugSpy.mockRestore();
      await fsPromises.rm(planPath, { force: true });
    }
  });

  test("workflow-owned plan propose_plan with missing plan file keeps requiring propose_plan", async () => {
    const projectName = `repo-missing-${path.basename(rootDir)}`;
    const planPath = path.join(os.homedir(), ".xum", "plans", projectName, "agent_plan_child.md");
    await fsPromises.rm(planPath, { force: true });

    const workflowRunId = "wfr_plan_missing";
    const { config, childId, sendMessage, replaceHistory, taskService } =
      await setupPlanModeStreamEndHarness({
        projectName,
        workflowTask: { runId: workflowRunId, stepId: "plan" },
      });
    const parentId = findWorkspaceInConfig(config, childId)?.parentWorkspaceId;
    assert(parentId, "workflow-owned plan test requires a parent workspace id");
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "plan-missing",
        description: "Plan missing",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });

    await streamEnd(taskService, makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(replaceHistory).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const reminderMessage = (sendMessage as unknown as { mock: { calls: Array<[string, string]> } })
      .mock.calls[0]?.[1];
    expect(reminderMessage).toContain("propose_plan");
    expect(reminderMessage).not.toContain("agent_report");

    const updatedTask = findWorkspaceInConfig(config, childId);
    expect(updatedTask?.agentId).toBe("plan");
    expect(updatedTask?.taskStatus).toBe("awaiting_report");
  });

  test("interrupted workflow-owned plan with successful propose_plan resolves as plan output", async () => {
    const projectName = `repo-interrupted-${path.basename(rootDir)}`;
    const planPath = path.join(os.homedir(), ".xum", "plans", projectName, "agent_plan_child.md");
    await fsPromises.mkdir(path.dirname(planPath), { recursive: true });
    await fsPromises.writeFile(
      planPath,
      "# Interrupted workflow plan\n\nStill complete.\n",
      "utf-8"
    );

    try {
      const { config, childId, replaceHistory, sendMessage, taskService } =
        await setupPlanModeStreamEndHarness({
          projectName,
          childTaskStatus: "interrupted",
          workflowTask: { runId: "wfr_plan_interrupted", stepId: "plan" },
        });

      await streamEnd(taskService, makeSuccessfulProposePlanStreamEndEvent(childId));

      const report = await taskService.waitForAgentReport(childId, { timeoutMs: 5_000 });
      expect(report).toEqual({
        reportMarkdown: "# Interrupted workflow plan\n\nStill complete.\n",
        title: "Proposed plan",
        planFilePath: planPath,
        model: "openai:gpt-4o-mini",
      });
      expect(replaceHistory).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    } finally {
      await fsPromises.rm(planPath, { force: true });
    }
  });

  test("workflow-owned plan with output schema fails instead of retrying propose_plan", async () => {
    const { config, childId, replaceHistory, sendMessage, taskService } =
      await setupPlanModeStreamEndHarness({
        workflowTask: {
          runId: "wfr_plan_schema_fallback",
          stepId: "plan",
          outputSchema: { type: "object" },
        },
      });

    const waiter = taskService
      .waitForAgentReport(childId, { timeoutMs: 5_000 })
      .catch((error: unknown) => error);

    await streamEnd(taskService, makeSuccessfulProposePlanStreamEndEvent(childId));

    const waiterError = await waiter;
    expect(waiterError).toBeInstanceOf(Error);
    expect((waiterError as Error).message).toContain(
      "Workflow plan agents return { reportMarkdown, planFilePath }"
    );
    expect(replaceHistory).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const updatedTask = findWorkspaceInConfig(config, childId);
    expect(updatedTask?.taskStatus).toBe("interrupted");
    expect(updatedTask?.taskLaunchError).toContain(
      "Workflow plan agents return { reportMarkdown, planFilePath }"
    );
  });

  test("plan-to-exec auto-handoff resets the persisted recovery budget", async () => {
    const { config, childId, taskService } = await setupPlanModeStreamEndHarness();

    // Budget consumed by propose_plan recovery prompts during the plan phase.
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const workspace = project.workspaces.find((ws) => ws.id === childId);
        if (workspace) {
          workspace.taskRecoveryAttempts = 4;
        }
      }
      return cfg;
    });

    await streamEnd(taskService, makeSuccessfulProposePlanStreamEndEvent(childId));

    // A successful propose_plan is a successful completion-tool outcome: the
    // exec phase starts with a fresh budget instead of inheriting the plan's.
    const updatedTask = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(updatedTask?.agentId).toBe("exec");
    expect(updatedTask?.taskRecoveryAttempts).toBeUndefined();
  });

  test.each([
    { name: "new-style", pins: { model: "openai:gpt-5.2", thinkingLevel: "high" as const } },
    { name: "legacy", pins: undefined },
  ])("plan-to-exec auto-handoff clears plan-phase pins ($name)", async (row) => {
    const { config, childId, taskService } = await setupPlanModeStreamEndHarness();
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const workspace = project.workspaces.find((ws) => ws.id === childId);
        if (workspace) {
          workspace.taskAiPins = row.pins;
        }
      }
      return cfg;
    });

    await streamEnd(taskService, makeSuccessfulProposePlanStreamEndEvent(childId));

    const updatedTask = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(updatedTask?.agentId).toBe("exec");
    // The Exec phase starts unpinned but stays refreshable; legacy tasks stay legacy.
    expect(updatedTask?.taskAiPins).toEqual(row.pins == null ? undefined : {});
  });

  test("plan task stream-end with final assistant text still requires propose_plan", async () => {
    const { config, childId, sendMessage, taskService } = await setupPlanModeStreamEndHarness();

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-plan-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [{ type: "text", text: "Here is the final plan in prose, but no propose_plan call." }],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const reminderMessage = (sendMessage as unknown as { mock: { calls: Array<[string, string]> } })
      .mock.calls[0]?.[1];
    expect(reminderMessage).toContain("propose_plan");
    expect(reminderMessage).not.toContain("agent_report");

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(updatedTask?.taskStatus).toBe("awaiting_report");
  });

  test("plan task stream-end without propose_plan sends propose_plan reminder (not agent_report)", async () => {
    const { config, childId, sendMessage, taskService } = await setupPlanModeStreamEndHarness();

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-plan-output",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);

    const reminderMessage = (sendMessage as unknown as { mock: { calls: Array<[string, string]> } })
      .mock.calls[0]?.[1];
    expect(reminderMessage).toContain("propose_plan");
    expect(reminderMessage).not.toContain("agent_report");

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(updatedTask?.taskStatus).toBe("awaiting_report");
  });

  test("awaiting_report tasks keep retrying agent_report after recovery errors instead of fabricating fallback reports", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.5-pro",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child",
      metadata: { model: "openai:gpt-5.5-pro" },
      parts: [],
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await streamError(taskService, {
        type: "error",
        workspaceId: childId,
        messageId: `assistant-error-${attempt}`,
        error: "The model ended the stream before producing any assistant-visible output.",
        errorType: "empty_output",
      });
    }

    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      childId,
      expect.stringContaining("Your stream ended without a final assistant response"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      childId,
      expect.stringContaining(
        "The previous final assistant response attempt failed (last error: empty_output)"
      ),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );

    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report).toBeNull();

    const postCfg = config.loadConfigOrDefault();
    const childWorkspace = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("awaiting_report");
  });

  test("awaiting_report tasks interrupt instead of retrying forever after non-retryable errors", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.5-pro",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage, resumeStream } = createWorkspaceServiceMocks();
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child",
      metadata: { model: "openai:gpt-5.5-pro" },
      parts: [],
    });

    await streamError(taskService, {
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-auth",
      error: "Authentication failed",
      errorType: "authentication",
    });

    // The child gets one recovery prompt; terminal failure resumes the parent directly from history.
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      childId,
      expect.stringContaining("Your stream ended without a final assistant response"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(resumeStream).toHaveBeenCalledWith(parentId, expect.any(Object), {
      acceptanceOrigin: "automatic",
      agentInitiated: true,
    });
    // The failure details travel via the durable synthetic history message,
    // not the generic wake-up prompt.
    const serializedParentHistory = JSON.stringify(
      await collectFullHistory(historyService, parentId)
    );
    expect(serializedParentHistory).toContain("<mux_subagent_failure>");
    expect(serializedParentHistory).toContain("Authentication failed");

    const postCfg = config.loadConfigOrDefault();
    const childWorkspace = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("interrupted");
  });

  // reasoning_rejected joins model_refusal in RUNNING_TASK_TERMINAL_STREAM_ERRORS:
  // the child's StreamManager already spent its one in-stream repair, so the
  // rejected replay cannot recover in-session either.
  for (const terminal of [
    {
      errorType: "model_refusal" as const,
      message:
        "The model refused to continue (finishReason: content-filter): anthropic:claude-fable-5.",
    },
    {
      errorType: "reasoning_rejected" as const,
      message: "The encrypted content for item rs_1 could not be verified.",
    },
  ]) {
    test(`running tasks settle terminally on ${terminal.errorType} without any recovery prompt`, async () => {
      const config = await createTestConfig(rootDir);

      const projectPath = path.join(rootDir, "repo");
      const parentId = "parent-111";
      const childId = "child-222";

      await saveWorkspaces(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "parent", parentId),
          projectWorkspace(projectPath, "child", childId, {
            name: "agent_explore_child",
            parentWorkspaceId: parentId,
            agentType: "explore",
            taskStatus: "running",
            taskModelString: "anthropic:claude-fable-5",
          }),
        ],
        testTaskSettings(1, 3)
      );

      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      const refusalMessage = terminal.message;

      // Waiter registered before the failure must reject promptly with the refusal
      // text — not block until the 10-minute report timeout.
      const waiterOutcome = taskService
        .waitForAgentReport(childId, { timeoutMs: 10_000, requestingWorkspaceId: parentId })
        .then(
          () => null,
          (error: unknown) => error
        );

      await streamError(taskService, {
        type: "error",
        workspaceId: childId,
        messageId: "assistant-error-refusal",
        error: refusalMessage,
        errorType: terminal.errorType,
      });

      const rejection = await waiterOutcome;
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe(refusalMessage);

      // Terminal settlement: no agent_report recovery prompt is sent afterwards.
      expect(sendMessage).not.toHaveBeenCalled();

      const postCfg = config.loadConfigOrDefault();
      const childWorkspace = Array.from(postCfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === childId);
      expect(childWorkspace?.taskStatus).toBe("interrupted");
      expect(childWorkspace?.taskLaunchError).toBe(refusalMessage);

      // Durable failure artifact persisted in the parent's session dir.
      const failure = await readSubagentFailureArtifact(
        path.join(config.sessionsDir, parentId),
        childId
      );
      expect(failure).not.toBeNull();
      expect(failure?.errorType).toBe(terminal.errorType);
      expect(failure?.errorMessage).toBe(refusalMessage);
    });
  }

  test("awaiting_report tasks settle terminally on model_refusal", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: "anthropic:claude-fable-5",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage, resumeStream } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const refusalMessage =
      "The model refused to continue (finishReason: content-filter): anthropic:claude-fable-5.";

    await streamError(taskService, {
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-refusal",
      error: refusalMessage,
      errorType: "model_refusal",
    });

    // No recovery prompt goes to the child; the parent resumes from the durable failure row.
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(resumeStream).toHaveBeenCalledWith(parentId, expect.any(Object), {
      acceptanceOrigin: "automatic",
      agentInitiated: true,
    });

    const postCfg = config.loadConfigOrDefault();
    const childWorkspace = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("interrupted");
    expect(childWorkspace?.taskLaunchError).toBe(refusalMessage);
  });

  test("running tasks are NOT settled by aborted, context_exceeded, or retryable stream errors", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.5-pro",
        }),
      ],
      testTaskSettings(1, 3)
    );

    // In-session context recovery recorded a started retry for the
    // context_exceeded event below, so the task must keep running.
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      waitForPendingStreamErrorRecoveryDecision: mock(() => Promise.resolve("retry-started")),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    // A user interrupt (aborted) is a steerable pause: the user can still send a
    // follow-up message, so the task must not be terminally interrupted.
    await streamError(taskService, {
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-abort",
      error: "Aborted",
      errorType: "aborted",
    });

    // context_exceeded is non-retryable but has in-session recovery (compaction
    // retry) listening on the same error event; while that recovery is preparing
    // a retry, settling here would interrupt a child that was about to continue.
    await streamError(taskService, {
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-context",
      error: "Prompt is too long: 250000 tokens > 200000 maximum",
      errorType: "context_exceeded",
    });

    // Retryable transport errors stay owned by the agent session's retry loop.
    await streamError(taskService, {
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-network",
      error: "fetch failed",
      errorType: "network",
    });

    expect(sendMessage).not.toHaveBeenCalled();

    const postCfg = config.loadConfigOrDefault();
    const childWorkspace = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("running");
    expect(childWorkspace?.taskLaunchError).toBeUndefined();
  });

  test("settles a running task on context_exceeded once in-session recovery declines", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.5-pro",
        }),
      ],
      testTaskSettings(1, 3)
    );

    // Recovery decision resolved terminal: compaction retries declined and the
    // turn failed with no later stream-end. An unrelated queued message on the
    // child must NOT keep the task running — the terminal error path never
    // dispatches the queue.
    const { workspaceService, sendMessage, resumeStream } = createWorkspaceServiceMocks({
      waitForPendingStreamErrorRecoveryDecision: mock(() => Promise.resolve("terminal")),
      hasQueuedMessages: mock((workspaceId: string) => workspaceId === childId),
      hasPendingQueuedOrPreparingTurn: mock((workspaceId: string) => workspaceId === childId),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const contextMessage = "Prompt is too long: 250000 tokens > 200000 maximum";
    await streamError(taskService, {
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-context",
      error: contextMessage,
      errorType: "context_exceeded",
    });

    // No stream-end follows a terminal handleStreamError, so the task must be
    // settled here; otherwise the parent's waitForAgentReport blocks until timeout.
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(resumeStream).toHaveBeenCalledWith(parentId, expect.any(Object), {
      acceptanceOrigin: "automatic",
      agentInitiated: true,
    });

    const postCfg = config.loadConfigOrDefault();
    const childWorkspace = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("interrupted");
    expect(childWorkspace?.taskLaunchError).toBe(contextMessage);
  });

  test("background task refusal stays observable after cleanup and restart via failure artifact", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    const childWorkspaceEntry = projectWorkspace(projectPath, "child", childId, {
      name: "agent_explore_child",
      parentWorkspaceId: parentId,
      agentType: "explore",
      taskStatus: "running",
      taskModelString: "anthropic:claude-fable-5",
    });

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "parent", parentId), childWorkspaceEntry],
      testTaskSettings(1, 3)
    );

    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const refusalMessage =
      "The model refused to continue (finishReason: content-filter): anthropic:claude-fable-5.";

    // No foreground waiter exists (background child) when the refusal lands.
    await streamError(taskService, {
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-refusal",
      error: refusalMessage,
      errorType: "model_refusal",
    });

    // Restart simulation: a fresh service instance over the same config still
    // surfaces the terminal failure from config status + taskLaunchError.
    const { taskService: restartedTaskService } = createTaskServiceHarness(config, {
      workspaceService: createWorkspaceServiceMocks().workspaceService,
    });
    const lateAwaitError = await restartedTaskService
      .waitForAgentReport(childId, { timeoutMs: 5_000, requestingWorkspaceId: parentId })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(lateAwaitError).toBeInstanceOf(Error);
    expect((lateAwaitError as Error).message).toBe(refusalMessage);

    // Cleanup simulation: the child workspace entry is gone, so only the
    // persisted failure artifact can explain the terminal outcome.
    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "parent", parentId)],
      testTaskSettings(1, 3)
    );

    const postCleanupError = await restartedTaskService
      .waitForAgentReport(childId, { timeoutMs: 5_000, requestingWorkspaceId: parentId })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(postCleanupError).toBeInstanceOf(Error);
    expect((postCleanupError as Error).message).toBe(refusalMessage);
  });

  test("terminal background-child failure wakes the idle parent once the last child settles", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childAId = "child-222";
    const childBId = "child-333";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child-a", childAId, {
          name: "agent_explore_child_a",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "anthropic:claude-fable-5",
        }),
        projectWorkspace(projectPath, "child-b", childBId, {
          name: "agent_explore_child_b",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "anthropic:claude-fable-5",
        }),
      ],
      testTaskSettings(2, 3)
    );

    const { workspaceService, sendMessage, resumeStream } = createWorkspaceServiceMocks();
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    const refusalMessage =
      "The model refused to continue (finishReason: content-filter): anthropic:claude-fable-5.";

    const readParentFailureMessages = async () => {
      const history = await collectFullHistory(historyService, parentId);
      return history
        .filter((message) => message.role === "user")
        .map((message) => JSON.stringify(message))
        .filter((serialized) => serialized.includes("<mux_subagent_failure>"));
    };

    // First background child refuses while a sibling is still active: the
    // parent is NOT woken yet (the last settlement owns the wake-up), but the
    // failure details are already delivered durably into the parent context so
    // a later sibling REPORT cannot present the fanout as fully successful.
    await streamError(taskService, {
      type: "error",
      workspaceId: childAId,
      messageId: "assistant-error-refusal-a",
      error: refusalMessage,
      errorType: "model_refusal",
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(resumeStream).not.toHaveBeenCalled();
    const messagesAfterFirstFailure = await readParentFailureMessages();
    expect(messagesAfterFirstFailure).toHaveLength(1);
    expect(messagesAfterFirstFailure[0]).toContain(childAId);
    expect(messagesAfterFirstFailure[0]).toContain("model_refusal");
    expect(messagesAfterFirstFailure[0]).toContain(refusalMessage);

    // Last background child refuses with no foreground waiter: its failure is appended too,
    // and the idle parent resumes once from the durable failure rows.
    await streamError(taskService, {
      type: "error",
      workspaceId: childBId,
      messageId: "assistant-error-refusal-b",
      error: refusalMessage,
      errorType: "model_refusal",
    });

    const messagesAfterSecondFailure = await readParentFailureMessages();
    expect(messagesAfterSecondFailure).toHaveLength(2);
    expect(messagesAfterSecondFailure[1]).toContain(childBId);

    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(resumeStream).toHaveBeenCalledTimes(1);
    expect(resumeStream).toHaveBeenCalledWith(parentId, expect.any(Object), {
      acceptanceOrigin: "automatic",
      agentInitiated: true,
    });
  });

  test("terminal workflow-owned child failure does not nudge the parent with a generic handoff", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "anthropic:claude-fable-5",
          // Workflow-owned: failures propagate through the WorkflowRunner step
          // result, mirroring the report path's auto-resume skip.
          workflowTask: { runId: "wfr_refusal", stepId: "verify" },
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    await streamError(taskService, {
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-refusal",
      error: "The model refused to continue (finishReason: refusal): anthropic:claude-fable-5.",
      errorType: "model_refusal",
    });

    // Neither a wake-up send nor a synthetic failure message: the workflow
    // journal owns failure delivery for workflow-owned children.
    expect(sendMessage).not.toHaveBeenCalled();
    const serializedParentHistory = JSON.stringify(
      await collectFullHistory(historyService, parentId)
    );
    expect(serializedParentHistory).not.toContain("<mux_subagent_failure>");

    const childWorkspace = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("interrupted");
  });

  test("recovery circuit breaker interrupts the task once the persisted attempt budget is exhausted", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-5.5-pro",
          // Budget already consumed by prior recovery prompts (persisted, so
          // restarts cannot launder the count back to zero).
          taskRecoveryAttempts: 5,
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage, resumeStream } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    // A retryable error that would normally trigger yet another recovery prompt.
    await streamError(taskService, {
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-empty",
      error: "The model ended the stream before producing any assistant-visible output.",
      errorType: "empty_output",
    });

    // Breaker tripped: no further recovery prompt; the parent resumes from the failure row.
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(resumeStream).toHaveBeenCalledWith(parentId, expect.any(Object), {
      acceptanceOrigin: "automatic",
      agentInitiated: true,
    });

    const postCfg = config.loadConfigOrDefault();
    const childWorkspace = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("interrupted");
    expect(childWorkspace?.taskLaunchError).toContain("recovery attempts");
    expect(childWorkspace?.taskLaunchError).toContain("empty_output");

    // The terminal failure is durable: artifact carries the discriminated errorType.
    const failure = await readSubagentFailureArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(failure?.errorType).toBe("task_recovery_limit");

    // Waiters observe the same descriptive failure instead of timing out.
    const awaitError = await taskService
      .waitForAgentReport(childId, { timeoutMs: 5_000, requestingWorkspaceId: parentId })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(awaitError).toBeInstanceOf(Error);
    expect((awaitError as Error).message).toBe(childWorkspace?.taskLaunchError ?? "");
  });

  test("recovery prompts increment a persisted counter that survives service restarts", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.5-pro",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    // Stream ends without a report: first recovery prompt consumes budget.
    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child",
      metadata: { model: "openai:gpt-5.5-pro" },
      parts: [],
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const readAttempts = () =>
      Array.from(config.loadConfigOrDefault().projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === childId)?.taskRecoveryAttempts;
    expect(readAttempts()).toBe(1);

    // Restart simulation: a fresh service instance keeps counting from disk
    // instead of starting over at zero.
    const restartedMocks = createWorkspaceServiceMocks();
    const { taskService: restartedTaskService } = createTaskServiceHarness(config, {
      workspaceService: restartedMocks.workspaceService,
    });
    await streamError(restartedTaskService, {
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-empty",
      error: "The model ended the stream before producing any assistant-visible output.",
      errorType: "empty_output",
    });
    expect(restartedMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(readAttempts()).toBe(2);
  });

  test("a successful agent_report resets the persisted recovery counter", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-5.5-pro",
          taskRecoveryAttempts: 3,
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-report",
      metadata: { model: "openai:gpt-5.5-pro", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "All done", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "All done" },
      ],
    });

    const postCfg = config.loadConfigOrDefault();
    const childWorkspace = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("reported");
    expect(childWorkspace?.taskRecoveryAttempts).toBeUndefined();
  });

  test("recovery prompt consumes budget before sending so a failed send still counts", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-5.5-pro",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const readAttempts = () =>
      Array.from(config.loadConfigOrDefault().projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === childId)?.taskRecoveryAttempts;

    // Capture the persisted counter at send time: the budget must already be
    // consumed BEFORE the send so a crash mid-send cannot launder the attempt.
    let attemptsAtSendTime: number | undefined;
    const sendMessage = mock((): Promise<Result<void>> => {
      attemptsAtSendTime = readAttempts();
      return Promise.resolve(Err("send failed"));
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await streamError(taskService, {
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-empty",
      error: "The model ended the stream before producing any assistant-visible output.",
      errorType: "empty_output",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(attemptsAtSendTime).toBe(1);
    expect(readAttempts()).toBe(1);

    // A failed recovery send is not a terminal settlement: the task keeps
    // awaiting its report (restart recovery can retry with budget intact).
    const childWorkspace = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("awaiting_report");
    expect(childWorkspace?.taskLaunchError).toBeUndefined();
  });

  test("user resume of an interrupted task clears the persisted recovery budget", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          // Breaker previously tripped; a user-initiated resume is a fresh
          // chance and must not instantly re-fail on its first recovery prompt.
          taskRecoveryAttempts: 5,
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);

    const childWorkspace = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("running");
    expect(childWorkspace?.taskRecoveryAttempts).toBeUndefined();
  });

  test("waitForAgentReport prefers the persisted report when a failure artifact also exists", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    // Both artifacts exist for the same child (e.g. a refusal settled the task
    // while a racing stream-end still finalized agent_report). Report
    // monotonicity: a completed report must win over the failure.
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "real report",
      title: "done",
      nowMs: Date.now(),
    });
    await upsertSubagentFailureArtifact({
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      errorType: "model_refusal",
      errorMessage: "Model refused (finishReason: refusal): anthropic:claude-fable-5",
    });

    // Exercise the post-cleanup lookup path, where both artifacts are consulted.
    await config.removeWorkspace(childId);

    const report = await taskService.waitForAgentReport(childId, {
      timeoutMs: 10,
      requestingWorkspaceId: parentId,
    });
    expect(report).toEqual({ reportMarkdown: "real report", title: "done" });
  });

  test("handoff kickoff sendMessage failure keeps task status as running for restart recovery", async () => {
    const sendMessageFailure = mock(
      (): Promise<Result<void>> => Promise.resolve(Err("kickoff failed"))
    );
    const { config, childId, taskService } = await setupPlanModeStreamEndHarness({
      sendMessageOverride: sendMessageFailure,
    });

    await streamEnd(taskService, makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(sendMessageFailure).toHaveBeenCalledTimes(1);

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);

    // Task stays "running" so initialize() can retry the kickoff on next startup,
    // rather than "awaiting_report" which could finalize it prematurely.
    expect(updatedTask?.taskStatus).toBe("running");
  });

  test("falls back to default trunk when parent branch does not exist locally", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });

    const initLogger = createNullInitLogger();

    // Create a worktree for the parent on main
    const parentName = "parent";
    const parentCreate = await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });
    expect(parentCreate.success).toBe(true);

    const parentId = "1111111111";
    const parentPath = runtime.getWorkspacePath(projectPath, parentName);

    // Register parent with a name that does NOT exist as a local branch.
    // This simulates the case where parent workspace name (e.g., from SSH)
    // doesn't correspond to a local branch in the project repository.
    const nonExistentBranchName = "non-existent-branch-xyz";
    await config.editConfig(() => ({
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              {
                path: parentPath,
                id: parentId,
                name: nonExistentBranchName, // This branch doesn't exist locally
                createdAt: new Date().toISOString(),
                runtimeConfig,
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    }));
    const { taskService } = createTaskServiceHarness(config);

    // Creating a task should succeed by falling back to "main" as trunkBranch
    // instead of failing with "fatal: 'non-existent-branch-xyz' is not a commit"
    const created = await createAgentTask(taskService, parentId, "explore this repo");
    expect(created.success).toBe(true);
    if (!created.success) return;

    // Verify the child workspace was created
    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.taskId);
    expect(childEntry).toBeTruthy();
    expect(childEntry?.runtimeConfig?.type).toBe("worktree");
  }, 20_000);

  test("reported leaf cleanup preserves user-owned children and siblings", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "parent-222";
    const childTaskAId = "child-a-333";
    const childTaskBId = "child-b-444";

    await config.editConfig(() => ({
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              projectWorkspace(projectPath, "root", rootWorkspaceId),
              projectWorkspace(projectPath, "parent-task", parentTaskId, {
                name: "agent_exec_parent",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "exec",
                taskStatus: "reported",
              }),
              projectWorkspace(projectPath, "child-task-a", childTaskAId, {
                name: "agent_explore_child_a",
                parentWorkspaceId: parentTaskId,
                agentType: "explore",
                taskStatus: "reported",
              }),
              projectWorkspace(projectPath, "child-task-b", childTaskBId, {
                name: "agent_explore_child_b",
                parentWorkspaceId: parentTaskId,
                agentType: "explore",
                taskStatus: "reported",
              }),
            ],
          },
        ],
      ]),
      taskSettings: testTaskSettings(),
      migrations: { persistentSubagentsDefaulted: true },
    }));

    const isStreaming = mock(() => false);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const internal = taskService as unknown as {
      cleanupReportedLeafTask: (workspaceId: string) => Promise<void>;
    };

    await internal.cleanupReportedLeafTask(childTaskAId);

    expect(remove).not.toHaveBeenCalled();

    const postCfg = config.loadConfigOrDefault();
    const remainingWorkspaceIds = new Set(
      Array.from(postCfg.projects.values())
        .flatMap((project) => project.workspaces)
        .map((workspace) => workspace.id)
    );
    expect(remainingWorkspaceIds.has(parentTaskId)).toBe(true);
    expect(remainingWorkspaceIds.has(childTaskAId)).toBe(true);
    expect(remainingWorkspaceIds.has(childTaskBId)).toBe(true);
  });

  test("reported cleanup does not cascade through persistent ancestors", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const grandparentTaskId = "grandparent-000";
    const parentTaskId = "parent-222";
    const childTaskId = "child-a-333";

    await config.editConfig(() => ({
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              projectWorkspace(projectPath, "root", rootWorkspaceId),
              projectWorkspace(projectPath, "grandparent-task", grandparentTaskId, {
                name: "agent_exec_grandparent",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "exec",
                taskStatus: "reported",
              }),
              projectWorkspace(projectPath, "parent-task", parentTaskId, {
                name: "agent_exec_parent",
                parentWorkspaceId: grandparentTaskId,
                agentType: "exec",
                taskStatus: "reported",
              }),
              projectWorkspace(projectPath, "child-task-a", childTaskId, {
                name: "agent_explore_child_a",
                parentWorkspaceId: parentTaskId,
                agentType: "explore",
                taskStatus: "reported",
              }),
            ],
          },
        ],
      ]),
      taskSettings: testTaskSettings(),
      migrations: { persistentSubagentsDefaulted: true },
    }));

    const isStreaming = mock(() => false);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const internal = taskService as unknown as {
      cleanupReportedLeafTask: (workspaceId: string) => Promise<void>;
    };

    await internal.cleanupReportedLeafTask(childTaskId);

    const isStreamingCalls = (isStreaming as unknown as { mock: { calls: Array<[string]> } }).mock
      .calls;
    const checkedWorkspaceIds = new Set(isStreamingCalls.map((call) => call[0]));
    expect(checkedWorkspaceIds).toEqual(new Set([childTaskId]));
    expect(remove).not.toHaveBeenCalled();

    const postCfg = config.loadConfigOrDefault();
    const remainingWorkspaceIds = new Set(
      Array.from(postCfg.projects.values())
        .flatMap((project) => project.workspaces)
        .map((workspace) => workspace.id)
    );
    expect(remainingWorkspaceIds).toEqual(
      new Set([rootWorkspaceId, grandparentTaskId, parentTaskId, childTaskId])
    );
  });

  test("cleanupReportedLeafTask preserves interrupted user tasks with completed reports", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const grandparentTaskId = "grandparent-000";
    const parentTaskId = "parent-222";
    const childTaskId = "child-a-333";
    const completedAt = "2026-03-09T11:05:58.780Z";

    await config.editConfig(() => ({
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              projectWorkspace(projectPath, "root", rootWorkspaceId),
              projectWorkspace(projectPath, "grandparent-task", grandparentTaskId, {
                name: "agent_exec_grandparent",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "exec",
                taskStatus: "interrupted",
                reportedAt: completedAt,
              }),
              projectWorkspace(projectPath, "parent-task", parentTaskId, {
                name: "agent_exec_parent",
                parentWorkspaceId: grandparentTaskId,
                agentType: "exec",
                taskStatus: "interrupted",
                reportedAt: completedAt,
              }),
              projectWorkspace(projectPath, "child-task-a", childTaskId, {
                name: "agent_explore_child_a",
                parentWorkspaceId: parentTaskId,
                agentType: "explore",
                taskStatus: "interrupted",
                reportedAt: completedAt,
              }),
            ],
          },
        ],
      ]),
      taskSettings: testTaskSettings(),
      migrations: { persistentSubagentsDefaulted: true },
    }));

    const isStreaming = mock(() => false);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const internal = taskService as unknown as {
      cleanupReportedLeafTask: (workspaceId: string) => Promise<void>;
    };

    await internal.cleanupReportedLeafTask(childTaskId);

    const isStreamingCalls = (isStreaming as unknown as { mock: { calls: Array<[string]> } }).mock
      .calls;
    const checkedWorkspaceIds = new Set(isStreamingCalls.map((call) => call[0]));
    expect(checkedWorkspaceIds).toEqual(new Set([childTaskId]));
    expect(remove).not.toHaveBeenCalled();

    const postCfg = config.loadConfigOrDefault();
    const remainingWorkspaceIds = new Set(
      Array.from(postCfg.projects.values())
        .flatMap((project) => project.workspaces)
        .map((workspace) => workspace.id)
    );
    expect(remainingWorkspaceIds).toEqual(
      new Set([rootWorkspaceId, grandparentTaskId, parentTaskId, childTaskId])
    );
  });

  describe("persistent sub-agent cleanup", () => {
    interface ReportedTaskNode {
      id: string;
      directoryName: string;
      name: string;
      agentType: string;
      taskStatus?: WorkspaceConfigEntry["taskStatus"];
      reportedAt?: string;
      taskSticky?: boolean;
      workflowTask?: WorkspaceConfigEntry["workflowTask"];
    }

    type TaskCleanupEligibility =
      | { ok: true; parentWorkspaceId: string }
      | { ok: false; reason: string };

    interface TaskServiceCleanupInternals {
      canCleanupReportedTask: (workspaceId: string) => Promise<TaskCleanupEligibility>;
      cleanupReportedLeafTask: (workspaceId: string) => Promise<void>;
    }

    async function archiveWorkspaceInTestConfig(
      config: Config,
      workspaceId: string,
      archivedAt = "2026-03-10T00:00:00.000Z"
    ): Promise<void> {
      let archived = false;
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const workspace = project.workspaces.find((entry) => entry.id === workspaceId);
          if (!workspace) {
            continue;
          }

          workspace.archivedAt = archivedAt;
          workspace.unarchivedAt = undefined;
          archived = true;
          break;
        }
        return cfg;
      });
      assert(archived, `Expected workspace ${workspaceId} to exist in test config`);
    }

    async function setupReportedTaskChain(options?: {
      preserveSubagentsUntilArchive?: boolean;
      taskChain?: ReportedTaskNode[];
    }) {
      const config = await createTestConfig(rootDir);

      const projectPath = path.join(rootDir, "repo");
      const rootWorkspaceId = "root-111";
      const taskChain = options?.taskChain ?? [
        {
          id: "parent-222",
          directoryName: "parent-task",
          name: "agent_exec_parent",
          agentType: "exec",
          taskStatus: "reported" as const,
        },
        {
          id: "child-333",
          directoryName: "child-task",
          name: "agent_explore_child",
          agentType: "explore",
          taskStatus: "reported" as const,
        },
      ];

      const workspaces: WorkspaceConfigEntry[] = [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
      ];
      let parentWorkspaceId = rootWorkspaceId;
      for (const task of taskChain) {
        workspaces.push({
          path: path.join(projectPath, task.directoryName),
          id: task.id,
          name: task.name,
          parentWorkspaceId,
          agentType: task.agentType,
          taskStatus: task.taskStatus ?? "reported",
          reportedAt: task.reportedAt,
          taskSticky: task.taskSticky,
          ...(task.workflowTask !== undefined ? { workflowTask: task.workflowTask } : {}),
        });
        parentWorkspaceId = task.id;
      }

      await saveWorkspaces(config, projectPath, workspaces, {
        taskSettings: {
          ...testTaskSettings(3, 5),
          preserveSubagentsUntilArchive: options?.preserveSubagentsUntilArchive ?? true,
        },
      });

      const isStreaming = mock(() => false);
      const remove = createConfigBackedRemoveMock(config);
      const { aiService } = createAIServiceMocks(config, { isStreaming });
      const { workspaceService } = createWorkspaceServiceMocks({ remove });
      const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
      const internal = taskService as unknown as TaskServiceCleanupInternals;

      return {
        config,
        taskService,
        remove,
        rootWorkspaceId,
        taskChain,
        internal,
      };
    }

    test("cleanup is blocked when toggle is on and no ancestor is archived", async () => {
      const { config, remove, taskChain, internal } = await setupReportedTaskChain();
      const childTaskId = taskChain[1]?.id;
      expect(childTaskId).toBe("child-333");
      if (!childTaskId) {
        return;
      }

      const cleanupEligibility = await internal.canCleanupReportedTask(childTaskId);
      expect(cleanupEligibility).toEqual({ ok: false, reason: "preserved" });

      await internal.cleanupReportedLeafTask(childTaskId);

      expect(remove).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childTaskId)).toBeTruthy();
    });

    test("workflow-owned completed descendants bypass preserve-until-archive cleanup", async () => {
      const workflowTaskId = "workflow-222";
      const childTaskId = "child-333";
      const { config, remove, internal } = await setupReportedTaskChain({
        taskChain: [
          {
            id: workflowTaskId,
            directoryName: "workflow-task",
            name: "agent_explore_workflow",
            agentType: "explore",
            taskStatus: "reported",
            workflowTask: { runId: "wfr_cleanup", stepId: "review" },
          },
          {
            id: childTaskId,
            directoryName: "child-task",
            name: "agent_exec_child",
            agentType: "exec",
            taskStatus: "reported",
          },
        ],
      });

      expect(await internal.canCleanupReportedTask(childTaskId)).toEqual({
        ok: true,
        parentWorkspaceId: workflowTaskId,
      });
      await internal.cleanupReportedLeafTask(childTaskId);

      expect(remove.mock.calls.map((call) => call[0])).toEqual([childTaskId, workflowTaskId]);
      expect(findWorkspaceInConfig(config, childTaskId)).toBeUndefined();
      expect(findWorkspaceInConfig(config, workflowTaskId)).toBeUndefined();
    });

    test("startup recovery leaves preserved descendants alone before archive", async () => {
      const { config, taskService, remove, taskChain } = await setupReportedTaskChain();
      const childTaskId = taskChain[1]?.id;
      expect(childTaskId).toBe("child-333");
      if (!childTaskId) {
        return;
      }

      await taskService.initialize();

      expect(remove).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childTaskId)).toBeTruthy();
    });

    test("archiving an ancestor keeps persistent descendants until explicit removal", async () => {
      const grandparentTaskId = "grandparent-000";
      const parentTaskId = "parent-222";
      const childTaskId = "child-333";
      const { config, remove, internal } = await setupReportedTaskChain({
        taskChain: [
          {
            id: grandparentTaskId,
            directoryName: "grandparent-task",
            name: "agent_exec_grandparent",
            agentType: "exec",
            taskStatus: "reported",
          },
          {
            id: parentTaskId,
            directoryName: "parent-task",
            name: "agent_exec_parent",
            agentType: "exec",
            taskStatus: "reported",
          },
          {
            id: childTaskId,
            directoryName: "child-task",
            name: "agent_explore_child",
            agentType: "explore",
            taskStatus: "reported",
          },
        ],
      });

      await archiveWorkspaceInTestConfig(config, grandparentTaskId);

      const cleanupEligibility = await internal.canCleanupReportedTask(childTaskId);
      expect(cleanupEligibility).toEqual({ ok: false, reason: "preserved" });

      await internal.cleanupReportedLeafTask(childTaskId);

      expect(remove).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childTaskId)).toBeTruthy();
      expect(findWorkspaceInConfig(config, parentTaskId)).toBeTruthy();
      expect(findWorkspaceInConfig(config, grandparentTaskId)).toBeTruthy();
    });

    test("persistent tasks skip patch reads even when their artifact is pending", async () => {
      const { config, remove, rootWorkspaceId, taskChain, internal } =
        await setupReportedTaskChain();
      const parentTaskId = taskChain[0]?.id;
      const childTaskId = taskChain[1]?.id;
      expect(parentTaskId).toBe("parent-222");
      expect(childTaskId).toBe("child-333");
      if (!parentTaskId || !childTaskId) {
        return;
      }

      await archiveWorkspaceInTestConfig(config, rootWorkspaceId);

      const pendingArtifact: Awaited<
        ReturnType<typeof subagentGitPatchArtifacts.readSubagentGitPatchArtifact>
      > = {
        childTaskId,
        parentWorkspaceId: parentTaskId,
        createdAtMs: 1,
        status: "pending",
        projectArtifacts: [
          {
            projectPath: path.join(rootDir, "repo"),
            projectName: "repo",
            storageKey: "repo",
            status: "pending",
          },
        ],
        readyProjectCount: 0,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 0,
      };
      const patchArtifactSpy = spyOn(
        subagentGitPatchArtifacts,
        "readSubagentGitPatchArtifact"
      ).mockResolvedValue(pendingArtifact);

      try {
        const cleanupEligibility = await internal.canCleanupReportedTask(childTaskId);
        expect(patchArtifactSpy).not.toHaveBeenCalled();
        expect(cleanupEligibility).toEqual({ ok: false, reason: "preserved" });

        await internal.cleanupReportedLeafTask(childTaskId);

        expect(remove).not.toHaveBeenCalled();
        expect(findWorkspaceInConfig(config, childTaskId)).toBeTruthy();
      } finally {
        patchArtifactSpy.mockRestore();
      }
    });

    test("legacy retention false is ignored by the uniform persistent lifecycle", async () => {
      const { config, remove, taskChain, internal } = await setupReportedTaskChain({
        preserveSubagentsUntilArchive: false,
      });
      const parentTaskId = taskChain[0]?.id;
      const childTaskId = taskChain[1]?.id;
      expect(parentTaskId).toBe("parent-222");
      expect(childTaskId).toBe("child-333");
      if (!parentTaskId || !childTaskId) {
        return;
      }

      await internal.cleanupReportedLeafTask(childTaskId);

      expect(remove).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childTaskId)).toBeTruthy();
      expect(findWorkspaceInConfig(config, parentTaskId)).toBeTruthy();
    });

    test("archiving a root keeps its persistent descendant tree intact", async () => {
      const childTaskId = "child-222";
      const grandchildTaskId = "grandchild-333";
      const { config, remove, rootWorkspaceId, internal } = await setupReportedTaskChain({
        taskChain: [
          {
            id: childTaskId,
            directoryName: "child-task",
            name: "agent_exec_child",
            agentType: "exec",
            taskStatus: "reported",
          },
          {
            id: grandchildTaskId,
            directoryName: "grandchild-task",
            name: "agent_explore_grandchild",
            agentType: "explore",
            taskStatus: "reported",
          },
        ],
      });

      await archiveWorkspaceInTestConfig(config, rootWorkspaceId);
      await internal.cleanupReportedLeafTask(grandchildTaskId);

      expect(remove).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childTaskId)).toBeTruthy();
      expect(findWorkspaceInConfig(config, grandchildTaskId)).toBeTruthy();
    });
  });

  describe("parent auto-resume flood protection", () => {
    async function setupParentWithActiveChild(rootDirPath: string) {
      const config = await createTestConfig(rootDirPath);
      const projectPath = path.join(rootDirPath, "repo");
      await fsPromises.mkdir(projectPath, { recursive: true });

      const rootWorkspaceId = "root-resume-111";
      const childTaskId = "child-resume-222";

      await config.editConfig(() => ({
        projects: new Map([
          [
            projectPath,
            {
              trusted: true,
              workspaces: [
                projectWorkspace(projectPath, "root", rootWorkspaceId, {
                  aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" as const },
                }),
                projectWorkspace(projectPath, "child-task", childTaskId, {
                  parentWorkspaceId: rootWorkspaceId,
                  agentType: "explore",
                  taskStatus: "running" as const,
                  taskModelString: "openai:gpt-5.2",
                }),
              ],
            },
          ],
        ]),
        taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
      }));

      const { aiService } = createAIServiceMocks(config);
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, {
        aiService,
        workspaceService,
      });

      const makeStreamEndEvent = (): StreamEndEvent => ({
        type: "stream-end",
        workspaceId: rootWorkspaceId,
        messageId: `assistant-${Date.now()}`,
        metadata: { model: "openai:gpt-5.2" },
        parts: [],
      });

      return {
        config,
        taskService,
        sendMessage,
        rootWorkspaceId,
        childTaskId,
        projectPath,
        makeStreamEndEvent,
      };
    }

    test("stops auto-resuming after MAX_CONSECUTIVE_PARENT_AUTO_RESUMES (3)", async () => {
      const { taskService, sendMessage, makeStreamEndEvent } =
        await setupParentWithActiveChild(rootDir);

      // First 3 calls should trigger sendMessage (limit is 3)
      for (let i = 0; i < 3; i++) {
        await streamEnd(taskService, makeStreamEndEvent());
      }
      expect(sendMessage).toHaveBeenCalledTimes(3);

      // 4th call should NOT trigger sendMessage (limit exceeded)
      await streamEnd(taskService, makeStreamEndEvent());
      expect(sendMessage).toHaveBeenCalledTimes(3); // still 3
    });

    test("resetAutoResumeCount allows more resumes after limit", async () => {
      const { sendMessage, taskService, rootWorkspaceId, makeStreamEndEvent } =
        await setupParentWithActiveChild(rootDir);

      // Exhaust the auto-resume limit
      for (let i = 0; i < 3; i++) {
        await streamEnd(taskService, makeStreamEndEvent());
      }
      expect(sendMessage).toHaveBeenCalledTimes(3);

      // Blocked (limit reached)
      await streamEnd(taskService, makeStreamEndEvent());
      expect(sendMessage).toHaveBeenCalledTimes(3);

      // User sends a message → resets the counter
      taskService.resetAutoResumeCount(rootWorkspaceId);

      // Now auto-resume should work again
      await streamEnd(taskService, makeStreamEndEvent());
      expect(sendMessage).toHaveBeenCalledTimes(4);
    });

    test("workflow-only quiescence resets the auto-resume budget", async () => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      await fsPromises.mkdir(projectPath, { recursive: true });

      const rootWorkspaceId = "root-workflow-budget";
      const firstRunId = "wfr_budget_first";
      const secondRunId = "wfr_budget_second";
      await config.editConfig(() => ({
        projects: new Map([
          [
            projectPath,
            {
              trusted: true,
              workspaces: [projectWorkspace(projectPath, "root", rootWorkspaceId)],
            },
          ],
        ]),
        taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
      }));

      const runStore = new WorkflowRunStore({
        sessionDir: path.join(config.sessionsDir, rootWorkspaceId),
      });
      await runStore.createRun({
        id: firstRunId,
        workspaceId: rootWorkspaceId,
        workflow: {
          name: "first-workflow",
          description: "First workflow",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
        args: {},
        now: "2026-06-04T00:00:00.000Z",
      });
      await runStore.appendStatus(firstRunId, "running", "2026-06-04T00:00:01.000Z");
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, rootWorkspaceId),
        runId: firstRunId,
        createdAtMs: 1_000,
      });

      const { aiService } = createAIServiceMocks(config);
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
      const makeStreamEndEvent = (): StreamEndEvent => ({
        type: "stream-end",
        workspaceId: rootWorkspaceId,
        messageId: `assistant-${Date.now()}`,
        metadata: { model: "openai:gpt-5.2" },
        parts: [],
      });

      for (let i = 0; i < 3; i++) {
        await streamEnd(taskService, makeStreamEndEvent());
      }
      expect(sendMessage).toHaveBeenCalledTimes(3);
      await streamEnd(taskService, makeStreamEndEvent());
      expect(sendMessage).toHaveBeenCalledTimes(3);

      await runStore.appendStatus(firstRunId, "completed", "2026-06-04T00:00:02.000Z");
      await streamEnd(taskService, makeStreamEndEvent());
      expect(sendMessage).toHaveBeenCalledTimes(3);

      await runStore.createRun({
        id: secondRunId,
        workspaceId: rootWorkspaceId,
        workflow: {
          name: "second-workflow",
          description: "Second workflow",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
        args: {},
        now: "2026-06-04T00:00:03.000Z",
      });
      await runStore.appendStatus(secondRunId, "running", "2026-06-04T00:00:04.000Z");
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, rootWorkspaceId),
        runId: secondRunId,
        createdAtMs: 3_000,
      });

      await streamEnd(taskService, makeStreamEndEvent());
      expect(sendMessage).toHaveBeenCalledTimes(4);
      expect(sendMessage).toHaveBeenLastCalledWith(
        rootWorkspaceId,
        expect.stringContaining(secondRunId),
        expect.anything(),
        expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
      );
    });

    test("markParentWorkspaceInterrupted suppresses parent auto-resume until reset", async () => {
      const { sendMessage, taskService, rootWorkspaceId, makeStreamEndEvent } =
        await setupParentWithActiveChild(rootDir);

      taskService.markParentWorkspaceInterrupted(rootWorkspaceId);

      await streamEnd(taskService, makeStreamEndEvent());
      expect(sendMessage).not.toHaveBeenCalled();

      taskService.resetAutoResumeCount(rootWorkspaceId);

      await streamEnd(taskService, makeStreamEndEvent());
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    test("counter is per-workspace (different workspaces are independent)", async () => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      await fsPromises.mkdir(projectPath, { recursive: true });

      const rootA = "root-A";
      const rootB = "root-B";
      const childA = "child-A";
      const childB = "child-B";

      await config.editConfig(() => ({
        projects: new Map([
          [
            projectPath,
            {
              trusted: true,
              workspaces: [
                projectWorkspace(projectPath, "root-a", rootA, {
                  aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" as const },
                }),
                projectWorkspace(projectPath, "child-a", childA, {
                  parentWorkspaceId: rootA,
                  taskStatus: "running" as const,
                  taskModelString: "openai:gpt-5.2",
                }),
                projectWorkspace(projectPath, "root-b", rootB, {
                  aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" as const },
                }),
                projectWorkspace(projectPath, "child-b", childB, {
                  parentWorkspaceId: rootB,
                  taskStatus: "running" as const,
                  taskModelString: "openai:gpt-5.2",
                }),
              ],
            },
          ],
        ]),
        taskSettings: { maxParallelAgentTasks: 5, maxTaskNestingDepth: 3 },
      }));

      const { aiService } = createAIServiceMocks(config);
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, {
        aiService,
        workspaceService,
      });

      // Exhaust limit on workspace A
      for (let i = 0; i < 3; i++) {
        await streamEnd(taskService, {
          type: "stream-end",
          workspaceId: rootA,
          messageId: `a-${i}`,
          metadata: { model: "openai:gpt-5.2" },
          parts: [],
        });
      }
      expect(sendMessage).toHaveBeenCalledTimes(3);

      // Workspace A is now blocked
      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: rootA,
        messageId: "a-blocked",
        metadata: { model: "openai:gpt-5.2" },
        parts: [],
      });
      expect(sendMessage).toHaveBeenCalledTimes(3); // still 3

      // Workspace B should still work (independent counter)
      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: rootB,
        messageId: "b-0",
        metadata: { model: "openai:gpt-5.2" },
        parts: [],
      });
      expect(sendMessage).toHaveBeenCalledTimes(4); // B worked
    });
  });
});
