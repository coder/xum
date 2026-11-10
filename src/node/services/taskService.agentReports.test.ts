import * as path from "path";
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import { execSync } from "node:child_process";
import type { Config } from "@/node/config";
import type { HistoryService } from "@/node/services/historyService";
import type { MutexMap } from "@/node/utils/concurrency/mutexMap";
import {
  getSubagentGitPatchMboxPath,
  readSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { readSubagentReportArtifact } from "@/node/services/subagentReportArtifacts";
import type { TaskService } from "@/node/services/taskService";
import { Ok, type Result } from "@/common/types/result";
import type { StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage } from "@/common/types/message";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  initGitRepo,
  projectWorkspace,
  saveWorkspaces,
  streamEnd,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  collectFullHistory,
  createBestOfTaskServiceTestHarness,
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

  test("agent_report posts report to parent, finalizes pending task tool output, and triggers cleanup", async () => {
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
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage, resumeStream, emit } = createWorkspaceServiceMocks({
      remove,
    });
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "explore", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    // Seed child history with the initial prompt + assistant placeholder so committing the final
    // partial updates the existing assistant message (matching real streaming behavior).
    const childPrompt = createMuxMessage("user-child-prompt", "user", "do the thing", {
      timestamp: Date.now(),
    });
    const appendChildPrompt = await historyService.appendToHistory(childId, childPrompt);
    expect(appendChildPrompt.success).toBe(true);

    const childAssistantPlaceholder = createMuxMessage("assistant-child-partial", "assistant", "", {
      timestamp: Date.now(),
    });
    const appendChildPlaceholder = await historyService.appendToHistory(
      childId,
      childAssistantPlaceholder
    );
    expect(appendChildPlaceholder.success).toBe(true);

    const childHistorySequence = childAssistantPlaceholder.metadata?.historySequence;
    if (typeof childHistorySequence !== "number") {
      throw new Error("Expected child historySequence to be a number");
    }

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: childHistorySequence },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Hello from child",
            title: "Result",
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ]
    );
    const writeChildPartial = await partialService.writePartial(childId, childPartial);
    expect(writeChildPartial.success).toBe(true);

    // Simulate stream manager committing the final partial right before natural stream end.
    const commitChildPartial = await partialService.commitPartial(childId);
    expect(commitChildPartial.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    await flushTerminalAttentionDrains(taskService);

    const updatedChildPartial = await partialService.readPartial(childId);
    expect(updatedChildPartial).toBeNull();

    await collectFullHistory(historyService, parentId);

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
      expect(toolPart?.output && typeof toolPart.output === "object").toBe(true);
      expect(JSON.stringify(toolPart?.output)).toContain("Hello from child");
    }

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws?.taskStatus).toBe("reported");

    expect(emit).toHaveBeenCalledWith(
      "metadata",
      expect.objectContaining({ workspaceId: childId })
    );

    const reportArtifact = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(reportArtifact?.reportMarkdown).toBe("Hello from child");
    expect(reportArtifact?.structuredOutput).toBeUndefined();

    expect(remove).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(resumeStream).toHaveBeenCalledWith(parentId, expect.any(Object), {
      acceptanceOrigin: "automatic",
      agentInitiated: true,
    });
    expect(emit).toHaveBeenCalled();
  });

  function getConfiguredWorkspaceIds(config: Config): string[] {
    return Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .map((workspace) => workspace.id)
      .filter((id): id is string => typeof id === "string");
  }

  async function finalizeReportedChildTaskForTest(params: {
    historyService: HistoryService;
    partialService: ReturnType<typeof createTaskServiceHarness>["partialService"];
    taskService: TaskService;
    childId: string;
    reportMarkdown: string;
    title: string;
    prompt?: string;
  }): Promise<void> {
    const childPrompt = createMuxMessage(
      `user-${params.childId}-prompt`,
      "user",
      params.prompt ?? "compare options",
      {
        timestamp: Date.now(),
      }
    );
    expect((await params.historyService.appendToHistory(params.childId, childPrompt)).success).toBe(
      true
    );

    const childAssistantPlaceholder = createMuxMessage(
      `assistant-${params.childId}-partial`,
      "assistant",
      "",
      { timestamp: Date.now() }
    );
    expect(
      (await params.historyService.appendToHistory(params.childId, childAssistantPlaceholder))
        .success
    ).toBe(true);

    const childHistorySequence = childAssistantPlaceholder.metadata?.historySequence;
    if (typeof childHistorySequence !== "number") {
      throw new Error("Expected child historySequence to be a number");
    }

    const childPartial = createMuxMessage(
      `assistant-${params.childId}-partial`,
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: childHistorySequence },
      [
        {
          type: "dynamic-tool",
          toolCallId: `agent-report-${params.childId}`,
          toolName: "agent_report",
          input: { reportMarkdown: params.reportMarkdown, title: params.title },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: params.reportMarkdown },
      ]
    );
    expect((await params.partialService.writePartial(params.childId, childPartial)).success).toBe(
      true
    );
    expect((await params.partialService.commitPartial(params.childId)).success).toBe(true);

    await streamEnd(params.taskService, {
      type: "stream-end",
      workspaceId: params.childId,
      messageId: `assistant-${params.childId}-partial`,
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });
  }

  test("agent_report waits for all best-of reports before finalizing pending parent task output", async () => {
    const parentId = "parent-best-of";
    const childOneId = "child-best-of-1";
    const childTwoId = "child-best-of-2";
    const bestOf = { groupId: "best-of-group", index: 0, total: 2 } as const;

    const { config, historyService, partialService, taskService, remove } =
      await createBestOfTaskServiceTestHarness({
        rootDir,
        parentId,
        children: [
          {
            id: childOneId,
            name: "agent_explore_child_1",
            taskStatus: "running",
            bestOf,
          },
          {
            id: childTwoId,
            name: "agent_explore_child_2",
            taskStatus: "running",
            bestOf: { ...bestOf, index: 1 },
          },
        ],
      });

    await writePendingBestOfParentPartial({
      partialService,
      parentId,
      messageId: "assistant-parent-best-of-partial",
      toolCallId: "task-best-of-call",
      title: "Best of 2",
      n: 2,
      timestamp: Date.now(),
    });

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childOneId,
      reportMarkdown: "Report from child one",
      title: "Option one",
    });

    const parentHistoryAfterFirst = await collectFullHistory(historyService, parentId);
    expect(JSON.stringify(parentHistoryAfterFirst)).not.toContain("Report from child one");

    const afterFirstParentPartial = await partialService.readPartial(parentId);
    expect(afterFirstParentPartial).not.toBeNull();
    expect(getTaskToolPart(afterFirstParentPartial)?.state).toBe("input-available");
    expect(remove).not.toHaveBeenCalled();

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childTwoId,
      reportMarkdown: "Report from child two",
      title: "Option two",
    });

    const afterSecondParentPartial = await partialService.readPartial(parentId);
    expect(afterSecondParentPartial).not.toBeNull();
    const toolPart = getTaskToolPart(afterSecondParentPartial);
    expect(toolPart?.state).toBe("output-available");
    expect(toolPart?.output && typeof toolPart.output === "object").toBe(true);
    const serializedOutput = JSON.stringify(toolPart?.output);
    expect(serializedOutput).toContain(childOneId);
    expect(serializedOutput).toContain(childTwoId);
    expect(serializedOutput).toContain("Report from child one");
    expect(serializedOutput).toContain("Report from child two");

    const remainingTaskIds = getConfiguredWorkspaceIds(config);
    expect(remainingTaskIds).toContain(childOneId);
    expect(remainingTaskIds).toContain(childTwoId);
  });

  test("best-of finalization never ships a report a resumed sibling is replacing", async () => {
    const parentId = "parent-best-of-resumed-sibling";
    const childOneId = "child-best-of-resumed-sibling-1";
    const childTwoId = "child-best-of-resumed-sibling-2";
    const bestOf = { groupId: "best-of-resumed-sibling", index: 0, total: 2 } as const;

    const { config, historyService, partialService, taskService } =
      await createBestOfTaskServiceTestHarness({
        rootDir,
        parentId,
        children: [
          {
            id: childOneId,
            name: "agent_explore_child_1",
            taskStatus: "running",
            bestOf,
          },
          {
            // Reported once, then its re-run was stopped: the user resume below replaces its report.
            id: childTwoId,
            name: "agent_explore_child_2",
            taskStatus: "interrupted",
            bestOf: { ...bestOf, index: 1 },
          },
        ],
      });

    await writePendingBestOfParentPartial({
      partialService,
      parentId,
      messageId: "assistant-parent-best-of-resumed-sibling",
      toolCallId: "task-best-of-resumed-sibling-call",
      title: "Best of 2",
      n: 2,
      timestamp: Date.now(),
    });
    await upsertTestSubagentReports({
      config,
      parentId,
      reports: [
        {
          childTaskId: childTwoId,
          reportMarkdown: "Report from child two (pre-continuation)",
          title: "Option two (stale)",
        },
      ],
    });

    // Barrier at the commit of child one's grouped output: its assembly has already read child
    // two's old artifact. Resume child two and let its replacement report race the commit. The
    // replacement is started, not awaited (awaiting it under the assembly's lock would deadlock);
    // the barrier lifts once child two asks for the group lock, so it has run as far as the lock
    // lets it: blocked before publishing, or, were publication unserialized, already published
    // and queueing for delivery.
    const groupLocks = (taskService as unknown as { deferredBestOfLocks: MutexMap<string> })
      .deferredBestOfLocks;
    const withGroupLock = groupLocks.withLock.bind(groupLocks);
    let onGroupLockRequested: (() => void) | undefined;
    spyOn(groupLocks, "withLock").mockImplementation(((
      key: string,
      operation: () => Promise<unknown>
    ) => {
      if (key === parentId) onGroupLockRequested?.();
      return withGroupLock(key, operation);
    }) as typeof groupLocks.withLock);
    const updatePartial = historyService.updatePartialIfMessageIdMatches.bind(historyService);
    let replacementReport: Promise<void> | undefined;
    spyOn(historyService, "updatePartialIfMessageIdMatches").mockImplementationOnce(
      async (workspaceId, messageId, updater) => {
        expect(await taskService.markInterruptedTaskRunning(childTwoId)).toBe(true);
        const groupLockRequested = new Promise<void>((resolve) => {
          onGroupLockRequested = resolve;
        });
        replacementReport = finalizeReportedChildTaskForTest({
          historyService,
          partialService,
          taskService,
          childId: childTwoId,
          reportMarkdown: "Report from child two (continuation)",
          title: "Option two",
        });
        await groupLockRequested;
        return updatePartial(workspaceId, messageId, updater);
      }
    );

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childOneId,
      reportMarkdown: "Report from child one",
      title: "Option one",
    });
    expect(replacementReport).toBeDefined();
    await replacementReport;
    await flushTerminalAttentionDrains(taskService);

    const toolPart = getTaskToolPart(await partialService.readPartial(parentId));
    expect(toolPart?.state).toBe("output-available");
    const serializedOutput = JSON.stringify(toolPart?.output);
    expect(serializedOutput).toContain("Report from child one");
    expect(serializedOutput).toContain("Report from child two (continuation)");
    expect(serializedOutput).not.toContain("pre-continuation");
    const parentHistory = await collectFullHistory(historyService, parentId);
    expect(JSON.stringify(parentHistory)).not.toContain("pre-continuation");
  });

  test("agent_report recovers a pending legacy variants task call", async () => {
    const parentId = "parent-legacy-variants";
    const childOneId = "child-legacy-variant-1";
    const childTwoId = "child-legacy-variant-2";
    const groupId = "legacy-variant-group";

    const { config, historyService, partialService, taskService } =
      await createBestOfTaskServiceTestHarness({
        rootDir,
        parentId,
        children: [
          {
            id: childOneId,
            name: "agent_explore_frontend",
            title: "Split review",
            taskStatus: "running",
            bestOf: { groupId, index: 0, total: 2 },
          },
          {
            id: childTwoId,
            name: "agent_explore_backend",
            title: "Split review",
            taskStatus: "running",
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

    const runtimeWorkspaces = Array.from(config.loadConfigOrDefault().projects.values()).flatMap(
      (project) => project.workspaces
    );
    expect(
      runtimeWorkspaces.find((workspace) => workspace.id === childOneId)?.bestOf
    ).toBeUndefined();
    expect(
      runtimeWorkspaces.find((workspace) => workspace.id === childTwoId)?.bestOf
    ).toBeUndefined();

    await writePendingBestOfParentPartial({
      partialService,
      parentId,
      messageId: "assistant-parent-legacy-variants-partial",
      toolCallId: "task-legacy-variants-call",
      title: "Split review",
      legacyVariants: ["frontend", "backend"],
      prompt: "Review ${variant} for regressions",
      timestamp: Date.now(),
    });

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childOneId,
      reportMarkdown: "Frontend findings",
      title: "Frontend review",
      prompt: "Review frontend for regressions",
    });
    expect(getTaskToolPart(await partialService.readPartial(parentId))?.state).toBe(
      "input-available"
    );
    const parentHistoryAfterFirst = await collectFullHistory(historyService, parentId);
    expect(JSON.stringify(parentHistoryAfterFirst)).not.toContain("Frontend findings");

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childTwoId,
      reportMarkdown: "Backend findings",
      title: "Backend review",
      prompt: "Review backend for regressions",
    });

    const toolPart = getTaskToolPart(await partialService.readPartial(parentId));
    expect(toolPart?.state).toBe("output-available");
    const serializedOutput = JSON.stringify(toolPart?.output);
    expect(serializedOutput).toContain("Frontend findings");
    expect(serializedOutput).toContain("Backend findings");

    const persisted = JSON.parse(await fsPromises.readFile(configFile, "utf-8")) as {
      projects: Array<
        [string, { workspaces: Array<{ id?: string; bestOf?: { kind?: string; label?: string } }> }]
      >;
    };
    const persistedWorkspaces = persisted.projects.flatMap(([, project]) => project.workspaces);
    expect(
      persistedWorkspaces.find((workspace) => workspace.id === childOneId)?.bestOf
    ).toMatchObject({ kind: "variants", label: "frontend" });
    expect(
      persistedWorkspaces.find((workspace) => workspace.id === childTwoId)?.bestOf
    ).toMatchObject({ kind: "variants", label: "backend" });
  });

  // Test exercises real config + history + partial-on-disk I/O across many
  // sequential awaits. Under CI parallel-test contention this can momentarily
  // exceed Bun's default 5s per-test timeout even though it completes in
  // ~250ms locally; bump the budget for headroom.
  test(
    "agent_report finalizes interrupted best-of parent output after partial best-of spawn failure",
    async () => {
      const parentId = "parent-best-of-partial-spawn";
      const childOneId = "child-best-of-partial-1";
      const childTwoId = "child-best-of-partial-2";
      const bestOf = { groupId: "best-of-partial-group", index: 0, total: 3 } as const;

      const { config, historyService, partialService, taskService, remove } =
        await createBestOfTaskServiceTestHarness({
          rootDir,
          parentId,
          children: [
            {
              id: childOneId,
              name: "agent_explore_child_1",
              taskStatus: "running",
              bestOf,
            },
            {
              id: childTwoId,
              name: "agent_explore_child_2",
              taskStatus: "running",
              bestOf: { ...bestOf, index: 1 },
            },
          ],
        });

      await writePendingBestOfParentPartial({
        partialService,
        parentId,
        messageId: "assistant-parent-best-of-partial-spawn",
        toolCallId: "task-best-of-partial-call",
        title: "Best of 3",
        n: 3,
        timestamp: Date.now(),
      });

      await finalizeReportedChildTaskForTest({
        historyService,
        partialService,
        taskService,
        childId: childOneId,
        reportMarkdown: "Report from child one",
        title: "Option one",
      });

      const parentHistoryAfterFirst = await collectFullHistory(historyService, parentId);
      expect(JSON.stringify(parentHistoryAfterFirst)).not.toContain("Report from child one");

      const afterFirstParentPartial = await partialService.readPartial(parentId);
      expect(afterFirstParentPartial).not.toBeNull();
      expect(getTaskToolPart(afterFirstParentPartial)?.state).toBe("input-available");
      expect(remove).not.toHaveBeenCalled();

      await finalizeReportedChildTaskForTest({
        historyService,
        partialService,
        taskService,
        childId: childTwoId,
        reportMarkdown: "Report from child two",
        title: "Option two",
      });

      const afterSecondParentPartial = await partialService.readPartial(parentId);
      expect(afterSecondParentPartial).not.toBeNull();
      const toolPart = getTaskToolPart(afterSecondParentPartial);
      expect(toolPart?.state).toBe("output-available");
      expect(toolPart?.output && typeof toolPart.output === "object").toBe(true);
      const serializedOutput = JSON.stringify(toolPart?.output);
      expect(serializedOutput).toContain(childOneId);
      expect(serializedOutput).toContain(childTwoId);
      expect(serializedOutput).toContain("Report from child one");
      expect(serializedOutput).toContain("Report from child two");

      const remainingTaskIds = getConfiguredWorkspaceIds(config);
      expect(remainingTaskIds).toContain(childOneId);
      expect(remainingTaskIds).toContain(childTwoId);
    },
    { timeout: 15_000 }
  );

  test("grouped partial finalization exposes each terminal report exactly once", async () => {
    const parentId = "parent-best-of-no-duplicate";
    const childOneId = "child-best-of-no-duplicate-1";
    const childTwoId = "child-best-of-no-duplicate-2";
    const bestOf = { groupId: "best-of-no-duplicate-group", index: 0, total: 2 } as const;

    const { config, historyService, partialService, taskService } =
      await createBestOfTaskServiceTestHarness({
        rootDir,
        parentId,
        children: [
          {
            id: childOneId,
            name: "agent_explore_child_1",
            taskStatus: "running",
            bestOf,
          },
          {
            // Already reported (artifact seeded below) and then stopped; its late stream-end
            // below re-delivers the same report.
            id: childTwoId,
            name: "agent_explore_child_2",
            taskStatus: "interrupted",
            bestOf: { ...bestOf, index: 1 },
          },
        ],
      });

    await writePendingBestOfParentPartial({
      partialService,
      parentId,
      messageId: "assistant-parent-best-of-no-duplicate",
      toolCallId: "task-best-of-no-duplicate-call",
      title: "Best of 2",
      n: 2,
      timestamp: Date.now(),
    });
    await upsertTestSubagentReports({
      config,
      parentId,
      reports: [
        {
          childTaskId: childTwoId,
          reportMarkdown: "Report from child two",
          title: "Option two",
        },
      ],
    });

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childOneId,
      reportMarkdown: "Report from child one",
      title: "Option one",
    });

    const afterFirstParentPartial = await partialService.readPartial(parentId);
    expect(afterFirstParentPartial).not.toBeNull();
    const toolPart = getTaskToolPart(afterFirstParentPartial);
    expect(toolPart?.state).toBe("output-available");
    const serializedOutput = JSON.stringify(toolPart?.output);
    expect(serializedOutput).toContain(childOneId);
    expect(serializedOutput).toContain(childTwoId);

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childTwoId,
      reportMarkdown: "Report from child two",
      title: "Option two",
    });
    await flushTerminalAttentionDrains(taskService);

    const serializedParentHistory = JSON.stringify(
      await collectFullHistory(historyService, parentId)
    );
    expect(serializedParentHistory.match(/<mux_subagent_report>/g)).toHaveLength(2);
    expect(serializedParentHistory).toContain("Report from child one");
    expect(serializedParentHistory).toContain("Report from child two");
  });

  test("agent_report falls back to synthetic parent reports when grouped recovery cannot finish", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-fallback";
    const childOneId = "child-best-of-fallback-1";
    const childTwoId = "child-best-of-fallback-2";
    const bestOf = { groupId: "best-of-fallback-group", index: 0, total: 2 } as const;

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
          taskStatus: "running",
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
      "assistant-parent-best-of-fallback",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-fallback-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
        {
          type: "dynamic-tool",
          toolCallId: "task-secondary-pending-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "secondary task",
            title: "Secondary task",
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    const childPrompt = createMuxMessage(`user-${childOneId}-prompt`, "user", "compare options", {
      timestamp: Date.now(),
    });
    expect((await historyService.appendToHistory(childOneId, childPrompt)).success).toBe(true);

    const childAssistantPlaceholder = createMuxMessage(
      `assistant-${childOneId}-partial`,
      "assistant",
      "",
      { timestamp: Date.now() }
    );
    expect(
      (await historyService.appendToHistory(childOneId, childAssistantPlaceholder)).success
    ).toBe(true);

    const childHistorySequence = childAssistantPlaceholder.metadata?.historySequence;
    if (typeof childHistorySequence !== "number") {
      throw new Error("Expected child historySequence to be a number");
    }

    const childPartial = createMuxMessage(
      `assistant-${childOneId}-partial`,
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: childHistorySequence },
      [
        {
          type: "dynamic-tool",
          toolCallId: `agent-report-${childOneId}`,
          toolName: "agent_report",
          input: { reportMarkdown: "Report from child one", title: "Option one" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Report from child one" },
      ]
    );
    expect((await partialService.writePartial(childOneId, childPartial)).success).toBe(true);
    expect((await partialService.commitPartial(childOneId)).success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childOneId,
      messageId: `assistant-${childOneId}-partial`,
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    const parentHistory = await collectFullHistory(historyService, parentId);
    const serializedParentHistory = JSON.stringify(parentHistory);
    expect(serializedParentHistory).toContain("<mux_subagent_report>");
    expect(serializedParentHistory).toContain("Report from child one");

    const remainingTaskIds = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .map((workspace) => workspace.id)
      .filter((id): id is string => typeof id === "string");
    expect(remainingTaskIds).toContain(childOneId);
    expect(remainingTaskIds).toContain(childTwoId);
  });

  test("interrupted best-of siblings trigger deferred fallback delivery for earlier reports", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-deferred-fallback";
    const childOneId = "child-best-of-deferred-fallback-1";
    const childTwoId = "child-best-of-deferred-fallback-2";
    const bestOf = { groupId: "best-of-deferred-fallback-group", index: 0, total: 2 } as const;

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
          taskStatus: "running",
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
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
      "assistant-parent-best-of-deferred-fallback",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-deferred-fallback-call",
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

    async function finalizeChildReport(
      childId: string,
      reportMarkdown: string,
      title: string
    ): Promise<void> {
      const childPrompt = createMuxMessage(`user-${childId}-prompt`, "user", "compare options", {
        timestamp: Date.now(),
      });
      expect((await historyService.appendToHistory(childId, childPrompt)).success).toBe(true);

      const childAssistantPlaceholder = createMuxMessage(
        `assistant-${childId}-partial`,
        "assistant",
        "",
        { timestamp: Date.now() }
      );
      expect(
        (await historyService.appendToHistory(childId, childAssistantPlaceholder)).success
      ).toBe(true);

      const childHistorySequence = childAssistantPlaceholder.metadata?.historySequence;
      if (typeof childHistorySequence !== "number") {
        throw new Error("Expected child historySequence to be a number");
      }

      const childPartial = createMuxMessage(
        `assistant-${childId}-partial`,
        "assistant",
        "",
        { timestamp: Date.now(), historySequence: childHistorySequence },
        [
          {
            type: "dynamic-tool",
            toolCallId: `agent-report-${childId}`,
            toolName: "agent_report",
            input: { reportMarkdown, title },
            state: "output-available",
            output: { success: true },
          },
          { type: "text", text: reportMarkdown },
        ]
      );
      expect((await partialService.writePartial(childId, childPartial)).success).toBe(true);
      expect((await partialService.commitPartial(childId)).success).toBe(true);

      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: childId,
        messageId: `assistant-${childId}-partial`,
        metadata: { model: "test-model", finishReason: "stop" },
        parts: childPartial.parts as StreamEndEvent["parts"],
      });
    }

    await finalizeChildReport(childOneId, "Report from child one", "Option one");
    const parentHistoryBeforeInterrupt = await collectFullHistory(historyService, parentId);
    expect(JSON.stringify(parentHistoryBeforeInterrupt)).not.toContain("Report from child one");

    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const childTwo = project.workspaces.find((workspace) => workspace.id === childTwoId);
        if (childTwo) {
          childTwo.taskStatus = "interrupted";
        }
      }
      return cfg;
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTwoId,
      messageId: "assistant-child-two-interrupted",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: [],
    });
    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTwoId,
      messageId: "assistant-child-two-interrupted-repeat",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: [],
    });

    const parentHistoryAfterInterrupt = await collectFullHistory(historyService, parentId);
    const serializedParentHistory = JSON.stringify(parentHistoryAfterInterrupt);
    expect(serializedParentHistory).toContain("<mux_subagent_report>");
    expect(serializedParentHistory).toContain("Report from child one");
    expect(serializedParentHistory.match(/child-best-of-deferred-fallback-1/g)).toHaveLength(1);
  });

  test("agent_report uses legacy exec agentType for git format-patch eligibility", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    const parentPath = path.join(projectPath, "parent");
    const childPath = path.join(projectPath, "child");
    await fsPromises.mkdir(parentPath, { recursive: true });
    await fsPromises.mkdir(childPath, { recursive: true });

    initGitRepo(childPath);
    const baseCommitSha = execSync("git rev-parse HEAD", {
      cwd: childPath,
      encoding: "utf-8",
    }).trim();

    execSync("bash -lc 'echo \"world\" >> README.md'", { cwd: childPath, stdio: "ignore" });
    execSync("git add README.md", { cwd: childPath, stdio: "ignore" });
    execSync('git commit -m "child change"', { cwd: childPath, stdio: "ignore" });

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: "parent",
          runtimeConfig: { type: "local" },
        },
        {
          path: childPath,
          id: childId,
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          agentId: "explore",
          taskStatus: "running",
          runtimeConfig: { type: "local" },
          taskBaseCommitSha: baseCommitSha,
        },
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
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "exec", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: 0 },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ]
    );
    const writeChildPartial = await partialService.writePartial(childId, childPartial);
    expect(writeChildPartial.success).toBe(true);

    const parentSessionDir = path.join(config.sessionsDir, parentId);
    const patchPath = getSubagentGitPatchMboxPath(parentSessionDir, childId, "repo");

    const waiter = taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    const report = await waiter;
    expect(report).toEqual({ reportMarkdown: "Hello from child", title: "Result" });

    const artifactAfterStreamEnd = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    expect(
      artifactAfterStreamEnd?.status === "pending" || artifactAfterStreamEnd?.status === "ready"
    ).toBe(true);

    const start = Date.now();
    let lastArtifact: unknown = null;
    while (true) {
      const artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
      lastArtifact = artifact;

      if (artifact?.status === "ready") {
        try {
          await fsPromises.stat(patchPath);
          break;
        } catch {
          // Keep polling until the patch file exists.
        }
      } else if (artifact?.status === "failed" || artifact?.status === "skipped") {
        throw new Error(
          `Patch artifact generation failed with status=${artifact.status}: ${
            artifact.projectArtifacts.find((projectArtifact) => projectArtifact.status === "failed")
              ?.error ?? "unknown error"
          }`
        );
      }

      if (Date.now() - start > 20_000) {
        throw new Error(
          `Timed out waiting for patch artifact generation (lastArtifact=${JSON.stringify(lastArtifact)})`
        );
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    const artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    expect(artifact?.status).toBe("ready");

    await fsPromises.stat(patchPath);

    expect(remove).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
  }, 20_000);

  test("agent_report generates mixed per-project git format-patch artifacts for multi-project exec tasks before cleanup", async () => {
    const config = await createTestConfig(rootDir);

    const primaryProjectPath = path.join(rootDir, "project-a");
    const secondaryProjectPath = path.join(rootDir, "project-b");
    const parentId = "parent-111";
    const childId = "child-222";

    const parentPath = path.join(primaryProjectPath, "parent");
    const childWorkspacePath = path.join(rootDir, "multi-project-container");
    await fsPromises.mkdir(parentPath, { recursive: true });
    await fsPromises.mkdir(childWorkspacePath, { recursive: true });
    await fsPromises.mkdir(primaryProjectPath, { recursive: true });
    await fsPromises.mkdir(secondaryProjectPath, { recursive: true });

    initGitRepo(primaryProjectPath);
    initGitRepo(secondaryProjectPath);
    const primaryBaseCommitSha = execSync("git rev-parse HEAD", {
      cwd: primaryProjectPath,
      encoding: "utf-8",
    }).trim();
    const secondaryBaseCommitSha = execSync("git rev-parse HEAD", {
      cwd: secondaryProjectPath,
      encoding: "utf-8",
    }).trim();

    execSync("bash -lc 'echo \"secondary\" >> README.md'", {
      cwd: secondaryProjectPath,
      stdio: "ignore",
    });
    execSync("git add README.md", { cwd: secondaryProjectPath, stdio: "ignore" });
    execSync('git commit -m "secondary change"', {
      cwd: secondaryProjectPath,
      stdio: "ignore",
    });

    await saveWorkspaces(
      config,
      primaryProjectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: "parent",
          runtimeConfig: { type: "local" },
        },
        {
          path: childWorkspacePath,
          id: childId,
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          agentId: "exec",
          taskStatus: "running",
          runtimeConfig: { type: "local" },
          taskBaseCommitSha: primaryBaseCommitSha,
          taskBaseCommitShaByProjectPath: {
            [primaryProjectPath]: primaryBaseCommitSha,
            [secondaryProjectPath]: secondaryBaseCommitSha,
          },
          projects: [
            { projectPath: primaryProjectPath, projectName: "project-a" },
            { projectPath: secondaryProjectPath, projectName: "project-b" },
          ],
        },
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
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "exec", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: 0 },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ]
    );
    expect((await partialService.writePartial(childId, childPartial)).success).toBe(true);

    const parentSessionDir = path.join(config.sessionsDir, parentId);
    const secondaryPatchPath = getSubagentGitPatchMboxPath(parentSessionDir, childId, "project-b");

    const waiter = taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    await waiter;

    const start = Date.now();
    let artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    while (artifact?.status === "pending") {
      if (Date.now() - start > 20_000) {
        throw new Error(
          `Timed out waiting for multi-project patch generation: ${JSON.stringify(artifact)}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    }

    expect(artifact?.status).toBe("ready");
    expect(artifact?.readyProjectCount).toBe(1);
    expect(artifact?.skippedProjectCount).toBe(1);
    expect(artifact?.projectArtifacts).toEqual([
      expect.objectContaining({
        projectPath: primaryProjectPath,
        projectName: "project-a",
        status: "skipped",
        commitCount: 0,
      }),
      expect.objectContaining({
        projectPath: secondaryProjectPath,
        projectName: "project-b",
        status: "ready",
        commitCount: 1,
      }),
    ]);
    await fsPromises.stat(secondaryPatchPath);
  }, 20_000);

  test("agent_report generates git format-patch artifact for exec-derived custom tasks before cleanup", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    const parentPath = path.join(projectPath, "parent");
    const childPath = path.join(projectPath, "child");
    await fsPromises.mkdir(parentPath, { recursive: true });
    await fsPromises.mkdir(childPath, { recursive: true });

    // Custom agent definition stored in the parent workspace (.mux/agents).
    const agentsDir = path.join(parentPath, ".mux", "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "test-file.md"),
      `---\nname: Test File\ndescription: Exec-derived custom agent for tests\nbase: exec\nsubagent:\n  runnable: true\n---\n\nTest agent body.\n`,
      "utf-8"
    );

    initGitRepo(childPath);
    const baseCommitSha = execSync("git rev-parse HEAD", {
      cwd: childPath,
      encoding: "utf-8",
    }).trim();

    execSync("bash -lc 'echo \\\"world\\\" >> README.md'", { cwd: childPath, stdio: "ignore" });
    execSync("git add README.md", { cwd: childPath, stdio: "ignore" });
    execSync('git commit -m "child change"', { cwd: childPath, stdio: "ignore" });

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: "parent",
          runtimeConfig: { type: "local" },
        },
        {
          path: childPath,
          id: childId,
          name: "agent_test_file_child",
          parentWorkspaceId: parentId,
          agentType: "test-file",
          agentId: "test-file",
          taskStatus: "running",
          runtimeConfig: { type: "local" },
          taskBaseCommitSha: baseCommitSha,
        },
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
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "test-file", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: 0 },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ]
    );
    const writeChildPartial = await partialService.writePartial(childId, childPartial);
    expect(writeChildPartial.success).toBe(true);

    const parentSessionDir = path.join(config.sessionsDir, parentId);
    const patchPath = getSubagentGitPatchMboxPath(parentSessionDir, childId, "repo");

    const waiter = taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    const report = await waiter;
    expect(report).toEqual({ reportMarkdown: "Hello from child", title: "Result" });

    const artifactAfterStreamEnd = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    expect(
      artifactAfterStreamEnd?.status === "pending" || artifactAfterStreamEnd?.status === "ready"
    ).toBe(true);

    const start = Date.now();
    let lastArtifact: unknown = null;
    while (true) {
      const artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
      lastArtifact = artifact;

      if (artifact?.status === "ready") {
        try {
          await fsPromises.stat(patchPath);
          break;
        } catch {
          // Keep polling until the patch file exists.
        }
      } else if (artifact?.status === "failed" || artifact?.status === "skipped") {
        throw new Error(
          `Patch artifact generation failed with status=${artifact.status}: ${
            artifact.projectArtifacts.find((projectArtifact) => projectArtifact.status === "failed")
              ?.error ?? "unknown error"
          }`
        );
      }

      if (Date.now() - start > 20_000) {
        throw new Error(
          `Timed out waiting for patch artifact generation (lastArtifact=${JSON.stringify(lastArtifact)})`
        );
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    const artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    expect(artifact?.status).toBe("ready");

    await fsPromises.stat(patchPath);

    expect(remove).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
  }, 20_000);

  test("agent_report updates queued/running task tool output in parent history", async () => {
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
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const {
      workspaceService,
      sendMessage: sendMessageMock,
      resumeStream,
    } = createWorkspaceServiceMocks({ remove });
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentHistoryMessage = createMuxMessage(
      "assistant-parent-history",
      "assistant",
      "Spawned subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "explore", prompt: "do the thing", run_in_background: true },
          state: "output-available",
          output: { status: "running", taskId: childId },
        },
      ]
    );
    const appendParentHistory = await historyService.appendToHistory(
      parentId,
      parentHistoryMessage
    );
    expect(appendParentHistory.success).toBe(true);

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: 0 },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ]
    );
    const writeChildPartial = await partialService.writePartial(childId, childPartial);
    expect(writeChildPartial.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    await flushTerminalAttentionDrains(taskService);

    const parentMessages = await collectFullHistory(historyService, parentId);
    // Original task tool call remains immutable ("running"), and a synthetic report message is appended.
    expect(parentMessages.length).toBeGreaterThanOrEqual(2);

    const taskCallMessage = parentMessages.find((m) => m.id === "assistant-parent-history") ?? null;
    expect(taskCallMessage).not.toBeNull();
    if (taskCallMessage) {
      const toolPart = taskCallMessage.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as { output?: unknown } | undefined;
      expect(JSON.stringify(toolPart?.output)).toContain('"status":"running"');
      expect(JSON.stringify(toolPart?.output)).toContain(childId);
    }

    const syntheticReport = parentMessages.find((m) => m.metadata?.synthetic) ?? null;
    expect(syntheticReport).not.toBeNull();
    if (syntheticReport) {
      expect(syntheticReport.role).toBe("user");
      const text = syntheticReport.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      expect(text).toContain("Hello from child");
      expect(text).toContain(childId);
    }

    expect(remove).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(resumeStream).toHaveBeenCalledWith(parentId, expect.any(Object), {
      acceptanceOrigin: "automatic",
      agentInitiated: true,
    });
  });
});
