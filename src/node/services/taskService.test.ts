import * as path from "path";
import { describe, test, expect, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import { existsSync } from "fs";
import type { Config } from "@/node/config";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { TaskHandleStore } from "@/node/services/taskHandleStore";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import { Ok, Err, type Result } from "@/common/types/result";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { formatSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import type { SendMessageError } from "@/common/types/errors";
import { createMuxMessage } from "@/common/types/message";
import { type DynamicToolPart } from "@/common/types/toolParts";
import assert from "node:assert";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  projectWorkspace,
  saveLocalParentWorkspace,
  saveTestConfig,
  stubStableIds,
  testTaskSettings,
  workspaceTurnRecord,
} from "@/node/services/taskService.testHarness";
import {
  createAgentTask,
  createTaskServiceHarness,
  flushTerminalAttentionDrains,
  registerTaskServiceTestRoot,
  rootDir,
} from "@/node/services/taskService.shared.testHarness";

describe("TaskService", () => {
  registerTaskServiceTestRoot();

  test("resolveTaskAISettings preserves explicit gateway model identities", async () => {
    const config = await createTestConfig(rootDir);
    const { taskService } = createTaskServiceHarness(config);

    const resolver = (
      taskService as unknown as {
        resolveTaskAISettings: (params: {
          cfg: ReturnType<Config["loadConfigOrDefault"]>;
          parentWorkspaceId: string;
          parentMeta: Record<string, never>;
          agentId: string;
          modelString?: string;
        }) => Promise<{ taskModelString: string; canonicalModel: string }>;
      }
    ).resolveTaskAISettings.bind(taskService);

    // A cross-typed canonical-name Coder instance (coder:openai/<claude> with
    // type anthropic) must stay gateway-scoped in the PERSISTED settings:
    // name canonicalization would rewrite it to openai:<claude>, sending
    // queued follow-ups and plan→exec continuations to direct OpenAI.
    const gateway = await resolver({
      cfg: config.loadConfigOrDefault(),
      parentWorkspaceId: "missing-parent",
      parentMeta: {},
      agentId: "exec",
      modelString: "coder:openai/claude-sonnet-4-20250514",
    });
    expect(gateway.canonicalModel).toBe("coder:openai/claude-sonnet-4-20250514");

    // Non-gateway strings keep canonical normalization.
    const direct = await resolver({
      cfg: config.loadConfigOrDefault(),
      parentWorkspaceId: "missing-parent",
      parentMeta: {},
      agentId: "exec",
      modelString: "anthropic:claude-sonnet-4-20250514",
    });
    expect(direct.canonicalModel).toBe("anthropic:claude-sonnet-4-20250514");
  });

  test("scratch tasks share the managed workdir and stay in the scratch config bucket", async () => {
    const config = await createTestConfig(rootDir);
    const parentId = "1111111111";
    const childId = "2222222222";
    const scratchPath = path.join(config.rootDir, "scratch", parentId);
    await fsPromises.mkdir(scratchPath, { recursive: true });
    await saveTestConfig(
      config,
      [
        [
          SCRATCH_PROJECT_CONFIG_KEY,
          {
            projectKind: "system",
            trusted: true,
            workspaces: [
              {
                kind: "scratch",
                path: scratchPath,
                id: parentId,
                name: `scratch-${parentId}`,
                createdAt: new Date().toISOString(),
                runtimeConfig: { type: "local" },
                aiSettings: {
                  model: "anthropic:claude-opus-4-6",
                  thinkingLevel: "high",
                },
              },
            ],
          },
        ],
      ],
      { taskSettings: testTaskSettings() }
    );
    stubStableIds(config, [childId]);

    const workspaceMocks = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await createAgentTask(taskService, parentId, "Inspect the scratch files");

    expect(result).toEqual(
      Ok({
        taskId: childId,
        desktopOwnerWorkspaceId: childId,
        kind: "agent",
        status: "running",
        modelString: "anthropic:claude-opus-4-6",
        thinkingLevel: "high",
      })
    );
    const scratchProject = config.loadConfigOrDefault().projects.get(SCRATCH_PROJECT_CONFIG_KEY);
    const child = scratchProject?.workspaces.find((workspace) => workspace.id === childId);
    expect(child?.kind).toBe("scratch");
    expect(child?.path).toBe(scratchPath);
    expect(child?.taskIsolation).toBe("none");
    expect(child?.parentWorkspaceId).toBe(parentId);
    expect(config.loadConfigOrDefault().projects.has(scratchPath)).toBe(false);
    expect(workspaceMocks.sendMessage).toHaveBeenCalledWith(
      childId,
      "Inspect the scratch files",
      expect.any(Object),
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
  });

  test("does not consume a terminal report from a request that never included it", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const taskId = "task-raced-request-snapshot";
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: taskId,
    });

    const { historyService, taskService } = createTaskServiceHarness(config);
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("original-user", "user", "Start work", { timestamp: Date.now() })
    );
    const reportMessage = createMuxMessage(
      "terminal-report",
      "user",
      formatSubagentReportEnvelope({
        taskId,
        agentType: "explore",
        status: "completed",
        title: "Result",
        reportMarkdown: "Finished after the request snapshot.",
      }),
      { timestamp: Date.now(), synthetic: true, uiVisible: true }
    );
    await historyService.appendToHistory(parentId, reportMessage);
    const reportSequence = reportMessage.metadata?.historySequence;
    assert(typeof reportSequence === "number", "report history sequence is required");

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("stale-assistant", "assistant", "Response to the earlier request", {
        timestamp: Date.now(),
        requestHistorySequence: reportSequence - 1,
        finishReason: "stop",
      })
    );
    await taskService.acknowledgeAgentReports(parentId);
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(1);

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("informed-assistant", "assistant", "Response including the report", {
        timestamp: Date.now(),
        requestHistorySequence: reportSequence,
        finishReason: "stop",
      })
    );
    await taskService.acknowledgeAgentReports(parentId);
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  describe("terminal report consumption", () => {
    const taskId = "late-awaited-child";
    const reportMarkdown = "The delegated investigation is complete.";
    const completed = { status: "completed", taskId, reportMarkdown };
    const awaitOutput = { results: [completed] };
    const toolPart = (toolName: string, output: unknown): DynamicToolPart => ({
      type: "dynamic-tool",
      toolCallId: "await-report",
      toolName,
      input: { task_ids: [taskId] },
      state: "output-available",
      output,
    });

    async function setup(options: { generationId?: string } = {}) {
      const config = await createTestConfig(rootDir);
      const { parentId } = await saveLocalParentWorkspace(config, rootDir);
      const terminalAttentionStore = new TerminalAttentionStore(config);
      const resumeStream = mock(
        (): Promise<Result<{ started: boolean }, SendMessageError>> =>
          Promise.resolve(Ok({ started: true }))
      );
      const { workspaceService } = createWorkspaceServiceMocks({ resumeStream });
      const { historyService, taskService, aiService } = createTaskServiceHarness(config, {
        workspaceService,
      });
      const user = createMuxMessage("request", "user", "Investigate", { timestamp: Date.now() });
      await historyService.appendToHistory(parentId, user);
      // Real streams append a placeholder before a late report, then finalize it in place.
      const assistant = createMuxMessage("parent-response", "assistant", "", {
        timestamp: Date.now(),
        requestHistorySequence: user.metadata?.historySequence,
      });
      await historyService.appendToHistory(parentId, assistant);
      const report = createMuxMessage(
        "late-report",
        "user",
        formatSubagentReportEnvelope({
          taskId,
          agentType: "explore",
          title: "Investigation",
          status: "completed",
          reportMarkdown,
        }),
        { timestamp: Date.now(), synthetic: true, uiVisible: true }
      );
      await historyService.appendToHistory(parentId, report);
      const notification = await terminalAttentionStore.enqueueIfAbsent({
        ownerWorkspaceId: parentId,
        sourceKind: "agent_task",
        sourceId: taskId,
        ...options,
      });
      assert(notification);
      assistant.metadata = { ...assistant.metadata, finishReason: "stop" };
      const internal = taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      };
      return {
        config,
        parentId,
        aiService,
        historyService,
        taskService,
        workspaceService,
        terminalAttentionStore,
        resumeStream,
        assistant,
        report,
        notification,
        drain: () => internal.drainTerminalAttention(parentId),
      };
    }

    for (const [name, part] of [
      ["task", toolPart("task", completed)],
      [
        "grouped task",
        toolPart("task", { status: "completed", reports: [{ taskId, reportMarkdown }] }),
      ],
      ["task_await", toolPart("task_await", awaitOutput)],
      [
        "completed receipts from a failed kernel evaluation",
        toolPart("code_execution", {
          success: false,
          toolCalls: [{ toolName: "task_await", result: awaitOutput }],
        }),
      ],
      [
        "partially completed group",
        toolPart("task", {
          status: "running",
          reports: [{ taskId, reportMarkdown }],
        }),
      ],
      [
        "kernel receipts",
        toolPart("code_execution", {
          success: true,
          toolCalls: [{ toolName: "task_await", result: awaitOutput }],
        }),
      ],
      [
        "explicitly returned kernel report",
        {
          ...toolPart("code_execution", { success: true, result: awaitOutput }),
          nestedCalls: [toolPart("task_await", awaitOutput)],
        },
      ],
    ] satisfies Array<[string, DynamicToolPart]>) {
      test("does not wake after a mid-stream report was consumed through " + name, async () => {
        const fixture = await setup();
        fixture.assistant.parts = [part, { type: "text", text: "Findings incorporated." }];
        expect(
          await fixture.historyService.updateHistory(fixture.parentId, fixture.assistant)
        ).toEqual(Ok(undefined));
        await fixture.drain();
        await fixture.drain();
        expect(fixture.resumeStream).not.toHaveBeenCalled();
        expect(
          await fixture.terminalAttentionStore.get(fixture.parentId, fixture.notification.id)
        ).toMatchObject({ status: "delivered" });
      });
    }

    for (const [name, toolName, genuine, returned, success, expectedWakes] of [
      ["hidden successful eval", "task_await", awaitOutput, undefined, true, 1],
      ["hidden failed eval", "task_await", awaitOutput, undefined, false, 1],
      ["canonical await return", "task_await", awaitOutput, awaitOutput, true, 0],
      ["canonical task return", "task", completed, completed, true, 0],
      [
        "canonical grouped return",
        "task",
        { status: "completed", reports: [completed] },
        { status: "completed", reports: [completed] },
        true,
        0,
      ],
      [
        "offloaded preview",
        "task_await",
        awaitOutput,
        { handle: "vars.__h0", preview: JSON.stringify(awaitOutput) },
        true,
        1,
      ],
      ["unrelated return", "task_await", awaitOutput, { summary: "done" }, true, 1],
      [
        "truncated report text",
        "task_await",
        awaitOutput,
        { results: [{ ...completed, reportMarkdown: reportMarkdown.slice(0, 10) }] },
        true,
        1,
      ],
      ["missing provenance", "task_await", { results: [] }, awaitOutput, true, 1],
      [
        "different identity",
        "task_await",
        { results: [{ ...completed, taskId: "other-child" }] },
        awaitOutput,
        true,
        1,
      ],
    ] satisfies Array<[string, string, unknown, unknown, boolean, number]>) {
      test("kernel report visibility: " + name, async () => {
        const fixture = await setup();
        fixture.assistant.parts = [
          {
            ...toolPart("code_execution", {
              success,
              result: returned,
              toolCalls: [{ toolName, ok: true, bytes: 100 }],
            }),
            nestedCalls: [toolPart(toolName, genuine)],
          },
          { type: "text", text: "Finished." },
        ];
        await fixture.historyService.updateHistory(fixture.parentId, fixture.assistant);
        await fixture.drain();
        expect(fixture.resumeStream).toHaveBeenCalledTimes(expectedWakes);
      });
    }

    test("waits for idle before inspecting the final response", async () => {
      const fixture = await setup();
      const readHistory = spyOn(fixture.historyService, "getHistoryFromLatestBoundary");
      const isStreaming = spyOn(fixture.aiService, "isStreaming").mockReturnValue(true);
      await fixture.drain();
      expect(readHistory).not.toHaveBeenCalled();
      expect(await fixture.terminalAttentionStore.listPending(fixture.parentId)).toHaveLength(1);
      fixture.assistant.parts = [
        toolPart("task_await", awaitOutput),
        { type: "text", text: "Done." },
      ];
      await fixture.historyService.updateHistory(fixture.parentId, fixture.assistant);
      isStreaming.mockReturnValue(false);
      await fixture.drain();
      expect(fixture.resumeStream).not.toHaveBeenCalled();
      expect(await fixture.terminalAttentionStore.listPending(fixture.parentId)).toHaveLength(0);
    });

    test("acknowledges before compaction while the owned completion phase is still busy", async () => {
      const fixture = await setup();
      const busy = spyOn(fixture.workspaceService, "isBusyForMessage").mockReturnValue(true);
      const readHistory = spyOn(fixture.historyService, "getHistoryFromLatestBoundary");
      fixture.assistant.parts = [toolPart("task_await", awaitOutput)];
      await fixture.historyService.updateHistory(fixture.parentId, fixture.assistant);
      // Provider streaming is already over, but completion still owns the workspace.
      await fixture.drain();
      expect(readHistory).not.toHaveBeenCalled();
      expect(fixture.resumeStream).not.toHaveBeenCalled();
      await fixture.taskService.acknowledgeAgentReports(fixture.parentId);
      await fixture.historyService.appendToHistory(
        fixture.parentId,
        createMuxMessage("compaction", "assistant", "Summary", {
          compactionBoundary: true,
          compacted: "user",
          compactionEpoch: 1,
          agentId: "compact",
          finishReason: "stop",
        })
      );
      const afterCompaction = await fixture.historyService.getHistoryFromLatestBoundary(
        fixture.parentId
      );
      assert(afterCompaction.success);
      expect(afterCompaction.data.some((message) => message.id === fixture.assistant.id)).toBe(
        false
      );
      busy.mockReturnValue(false);
      await fixture.drain();
      expect(fixture.resumeStream).not.toHaveBeenCalled();
      expect(await fixture.terminalAttentionStore.listPending(fixture.parentId)).toHaveLength(0);
    });

    for (const finishReason of [
      "length",
      "content-filter",
      "tool-calls",
      "error",
      "other",
      undefined,
    ] as const) {
      test("retains unincorporated receipts after finishReason=" + finishReason, async () => {
        const fixture = await setup();
        fixture.assistant.parts = [toolPart("task_await", awaitOutput)];
        fixture.assistant.metadata = { ...fixture.assistant.metadata, finishReason };
        await fixture.historyService.updateHistory(fixture.parentId, fixture.assistant);
        await fixture.taskService.acknowledgeAgentReports(fixture.parentId);
        expect(await fixture.terminalAttentionStore.listPending(fixture.parentId)).toHaveLength(1);
        await fixture.drain();
        expect(fixture.resumeStream).toHaveBeenCalledTimes(1);
      });
    }

    for (const toolName of ["task", "task_await"]) {
      for (const handleMatches of [true, false]) {
        test(
          "normalizes workspace-turn identity in " +
            toolName +
            " (handleMatches=" +
            handleMatches +
            ")",
          async () => {
            const record = workspaceTurnRecord("owner", taskId, "wst_receipt", "completed", {
              messageId: "workspace-final",
              reportMarkdown,
            });
            const fixture = await setup({
              generationId: [record.handleId, record.status, record.updatedAt].join(":"),
            });
            await new TaskHandleStore(fixture.config).upsertWorkspaceTurn({
              ...record,
              ownerWorkspaceId: fixture.parentId,
            });
            const receipt = {
              ...completed,
              taskId: handleMatches ? record.handleId : "wst_other",
              handleKind: "workspace_turn",
              workspaceId: taskId,
              finalMessageRef: { messageId: record.messageId },
            };
            fixture.assistant.parts = [
              toolPart(toolName, toolName === "task" ? receipt : { results: [receipt] }),
            ];
            await fixture.historyService.updateHistory(fixture.parentId, fixture.assistant);
            await fixture.drain();
            expect(fixture.resumeStream).toHaveBeenCalledTimes(handleMatches ? 0 : 1);
          }
        );
      }
    }

    test("reconciles a covered response in the drain without a stream-end callback", async () => {
      const fixture = await setup();
      await fixture.historyService.appendToHistory(
        fixture.parentId,
        createMuxMessage("informed-response", "assistant", "Already incorporated.", {
          timestamp: Date.now(),
          requestHistorySequence: fixture.report.metadata?.historySequence,
          finishReason: "stop",
        })
      );
      await fixture.drain();
      expect(fixture.resumeStream).not.toHaveBeenCalled();
    });

    for (const [name, part] of [
      ["running snapshot", toolPart("task_await", { results: [{ taskId, status: "running" }] })],
      [
        "failed wait",
        toolPart("task_await", { results: [{ taskId, status: "error", error: "failed" }] }),
      ],
      ["missing report", toolPart("task_await", { results: [{ taskId, status: "completed" }] })],
      ["unrelated tool", toolPart("file_read", awaitOutput)],
      [
        "failed nested call",
        toolPart("code_execution", {
          success: true,
          toolCalls: [{ toolName: "task_await", result: awaitOutput, error: "failed" }],
        }),
      ],
      [
        "pending outer call",
        {
          type: "dynamic-tool",
          toolName: "code_execution",
          toolCallId: "pending",
          input: {},
          state: "input-available",
          nestedCalls: [toolPart("task_await", awaitOutput)],
        },
      ],
    ] satisfies Array<[string, DynamicToolPart]>) {
      test("keeps the wake for a " + name, async () => {
        const fixture = await setup();
        fixture.assistant.parts = [part, { type: "text", text: "Done." }];
        await fixture.historyService.updateHistory(fixture.parentId, fixture.assistant);
        await fixture.drain();
        expect(fixture.resumeStream).toHaveBeenCalledTimes(1);
      });
    }

    for (const metadata of [{ partial: true }, { agentId: "compact" }]) {
      test(
        "does not acknowledge incomplete/compaction output " + JSON.stringify(metadata),
        async () => {
          const fixture = await setup();
          fixture.assistant.parts = [toolPart("task_await", awaitOutput)];
          fixture.assistant.metadata = { ...fixture.assistant.metadata, ...metadata };
          await fixture.historyService.updateHistory(fixture.parentId, fixture.assistant);
          await fixture.drain();
          expect(fixture.resumeStream).toHaveBeenCalledTimes(1);
        }
      );
    }

    test("only consumes completed entries returned by a thresholded await", async () => {
      const fixture = await setup();
      const otherId = "still-running-at-await-return";
      fixture.resumeStream.mockImplementation(async () => {
        const pending = await fixture.terminalAttentionStore.listPending(fixture.parentId);
        expect(pending.map((notification) => notification.sourceId)).toEqual([otherId]);
        return Ok({ started: true });
      });
      fixture.assistant.parts = [
        toolPart("task_await", {
          results: [completed, { taskId: otherId, status: "running" }],
        }),
      ];
      await fixture.historyService.updateHistory(fixture.parentId, fixture.assistant);
      await fixture.historyService.appendToHistory(
        fixture.parentId,
        createMuxMessage(
          "later-sibling-report",
          "user",
          formatSubagentReportEnvelope({
            taskId: otherId,
            agentType: "explore",
            title: "Investigation",
            status: "completed",
            reportMarkdown,
          }),
          { timestamp: Date.now(), synthetic: true, uiVisible: true }
        )
      );
      await fixture.terminalAttentionStore.enqueueIfAbsent({
        ownerWorkspaceId: fixture.parentId,
        sourceKind: "agent_task",
        sourceId: otherId,
      });
      await fixture.drain();
      expect(fixture.resumeStream).toHaveBeenCalledTimes(1);
      expect(
        await fixture.terminalAttentionStore.get(fixture.parentId, fixture.notification.id)
      ).toMatchObject({ status: "delivered" });
    });

    for (const owner of ["parent", "ancestor"] as const) {
      test(
        "consumes an older continuation after reactivation (owned by " + owner + ")",
        async () => {
          const oldRecord = workspaceTurnRecord("owner", taskId, "wst_older", "completed", {
            messageId: "old-final",
            reportMarkdown,
          });
          const generationId = [oldRecord.handleId, oldRecord.status, oldRecord.updatedAt].join(
            ":"
          );
          const fixture = await setup({ generationId });
          const ownerId = owner === "parent" ? fixture.parentId : "higher-ancestor";
          await fixture.config.editConfig((cfg) => {
            const entry = findWorkspaceEntry(cfg, fixture.parentId);
            assert(entry);
            const project = cfg.projects.get(entry.projectPath);
            assert(project);
            if (owner === "ancestor") {
              entry.workspace.parentWorkspaceId = ownerId;
              project.workspaces.push(projectWorkspace(entry.projectPath, "ancestor", ownerId));
            }
            project.workspaces.push(
              projectWorkspace(entry.projectPath, "child", taskId, {
                parentWorkspaceId: fixture.parentId,
                taskStatus: "reported",
                taskExecutionId: "wst_newer",
              })
            );
            return cfg;
          });
          const store = new TaskHandleStore(fixture.config);
          await store.upsertWorkspaceTurn({ ...oldRecord, ownerWorkspaceId: ownerId });
          const newRecord = {
            ...oldRecord,
            ownerWorkspaceId: ownerId,
            handleId: "wst_newer",
            messageId: "new-final",
          };
          await store.upsertWorkspaceTurn(newRecord);
          const newer = await fixture.terminalAttentionStore.enqueueIfAbsent({
            ownerWorkspaceId: fixture.parentId,
            sourceKind: "agent_task",
            sourceId: taskId,
            generationId: [newRecord.handleId, newRecord.status, newRecord.updatedAt].join(":"),
          });
          assert(newer);
          fixture.assistant.parts = [
            toolPart("task_await", { results: [{ ...completed, messageId: "old-final" }] }),
          ];
          await fixture.historyService.updateHistory(fixture.parentId, fixture.assistant);
          fixture.resumeStream.mockImplementation(async () => {
            const pending = await fixture.terminalAttentionStore.listPending(fixture.parentId);
            expect(pending.map((notification) => notification.id)).toEqual([newer.id]);
            return Ok({ started: true });
          });
          await fixture.drain();
          expect(fixture.resumeStream).toHaveBeenCalledTimes(1);
          expect(
            await fixture.terminalAttentionStore.get(fixture.parentId, fixture.notification.id)
          ).toMatchObject({ status: "delivered" });
        }
      );
    }

    for (const identity of ["current", "old", "initial"] as const) {
      test("matches continuation consumption to its execution (" + identity + ")", async () => {
        const record = workspaceTurnRecord("owner", taskId, "wst_continuation", "completed", {
          messageId: "current-final",
          reportMarkdown,
        });
        const generationId = [record.handleId, record.status, record.updatedAt].join(":");
        const fixture = await setup({ generationId });
        await new TaskHandleStore(fixture.config).upsertWorkspaceTurn({
          ...record,
          ownerWorkspaceId: fixture.parentId,
        });
        fixture.assistant.parts = [
          toolPart("task_await", {
            results: [
              {
                ...completed,
                ...(identity === "initial"
                  ? {}
                  : { messageId: identity === "current" ? "current-final" : "old-final" }),
              },
            ],
          }),
        ];
        await fixture.historyService.updateHistory(fixture.parentId, fixture.assistant);
        await fixture.drain();
        expect(fixture.resumeStream).toHaveBeenCalledTimes(identity === "current" ? 0 : 1);
      });
    }
  });

  test("late report still resumes an intentionally backgrounded parent once", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const taskId = "task-completed-after-parent-response";
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: taskId,
    });

    const resumeStream = mock(
      (): Promise<Result<{ started: boolean }, SendMessageError>> =>
        Promise.resolve(Ok({ started: true }))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ resumeStream });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });
    const userMessage = createMuxMessage("user-request", "user", "Start delegated work", {
      timestamp: Date.now(),
    });
    await historyService.appendToHistory(parentId, userMessage);
    const userSequence = userMessage.metadata?.historySequence;
    assert(typeof userSequence === "number", "user history sequence is required");
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("parent-final", "assistant", "The requested work is complete.", {
        timestamp: Date.now(),
        requestHistorySequence: userSequence,
      })
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage(
        "late-terminal-report",
        "user",
        formatSubagentReportEnvelope({
          taskId,
          agentType: "explore",
          status: "completed",
          title: "Late result",
          reportMarkdown: "Additional details arrived after the final response.",
        }),
        { timestamp: Date.now(), synthetic: true, uiVisible: true }
      )
    );

    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };
    await internal.drainTerminalAttention(parentId);

    expect(resumeStream).toHaveBeenCalledTimes(1);
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
    expect(await terminalAttentionStore.get(parentId, `agent_task:${taskId}`)).toMatchObject({
      status: "delivered",
    });
  });

  test("compaction output does not count as the parent's completed response", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const taskId = "task-completed-after-compaction";
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: taskId,
    });

    const resumeStream = mock(
      (): Promise<Result<{ started: boolean }, SendMessageError>> =>
        Promise.resolve(Ok({ started: true }))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ resumeStream });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });
    const userMessage = createMuxMessage("user-before-compact", "user", "Start delegated work", {
      timestamp: Date.now(),
    });
    await historyService.appendToHistory(parentId, userMessage);
    const userSequence = userMessage.metadata?.historySequence;
    assert(typeof userSequence === "number", "user history sequence is required");
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("compact-output", "assistant", "Compaction summary", {
        timestamp: Date.now(),
        agentId: "compact",
        requestHistorySequence: userSequence,
      })
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage(
        "terminal-report-after-compact",
        "user",
        formatSubagentReportEnvelope({
          taskId,
          agentType: "explore",
          status: "completed",
          title: "Result",
          reportMarkdown: "Ready after compaction.",
        }),
        { timestamp: Date.now(), synthetic: true, uiVisible: true }
      )
    );

    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };
    await internal.drainTerminalAttention(parentId);

    expect(resumeStream).toHaveBeenCalledTimes(1);
  });

  test("does not auto-resume an archived parent workspace", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      const entry = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === parentId);
      assert(entry, "parent workspace must exist");
      entry.archivedAt = "2026-08-10T00:00:00.000Z";
      return cfg;
    });
    const taskId = "task-for-archived-parent";
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: taskId,
    });

    const resumeStream = mock(
      (): Promise<Result<{ started: boolean }, SendMessageError>> =>
        Promise.resolve(Ok({ started: true }))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ resumeStream });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };

    await internal.drainTerminalAttention(parentId);

    expect(resumeStream).not.toHaveBeenCalled();
    expect(await terminalAttentionStore.get(parentId, `agent_task:${taskId}`)).toMatchObject({
      status: "superseded",
    });
  });

  test("persistent prompt-free resume failures stay pending without an idle retry loop", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const taskId = "task-persistent-resume-error";
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: taskId,
    });

    const resumeStream = mock(
      (): Promise<Result<{ started: boolean }, SendMessageError>> =>
        Promise.resolve(Err({ type: "unknown", raw: "Budget gate rejected the model" }))
    );
    const waitForIdleAndNoQueuedMessages = mock((): Promise<void> => Promise.resolve());
    const { workspaceService } = createWorkspaceServiceMocks({
      resumeStream,
      waitForIdleAndNoQueuedMessages,
    });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });
    await historyService.appendToHistory(
      parentId,
      createMuxMessage(
        "terminal-report",
        "user",
        formatSubagentReportEnvelope({
          taskId,
          agentType: "explore",
          status: "completed",
          title: "Result",
          reportMarkdown: "Ready for synthesis.",
        }),
        { timestamp: Date.now(), synthetic: true, uiVisible: true }
      )
    );

    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };
    await internal.drainTerminalAttention(parentId);

    expect(resumeStream).toHaveBeenCalledTimes(1);
    expect(waitForIdleAndNoQueuedMessages).not.toHaveBeenCalled();
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(1);
  });

  test("terminal workflow wake-up reconstructs durable result context", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_terminal_notify";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendNextEvent(runId, {
      type: "result",
      at: "2026-06-19T00:00:02.000Z",
      result: { reportMarkdown: "Workflow finished", structuredOutput: { ok: true } },
    });
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const terminalAttentionStore = new TerminalAttentionStore(config);
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const prompt = String(sendMessage.mock.calls[0]?.[1]);
    expect(prompt).toContain("mux_workflow_result");
    expect(prompt).toContain("Workflow finished");
    expect(prompt).toContain(runId);
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("terminal workflow wake-up defers when history is unreadable", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_terminal_defer";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const terminalAttentionStore = new TerminalAttentionStore(config);
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    // History unreadable at drain time: currentness is indeterminate, so the run must stay
    // queued for a later drain or sweep instead of being settled as superseded.
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("indeterminate"));
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).not.toHaveBeenCalled();
    const run = await runStore.getRun(runId);
    expect(
      await terminalAttentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("workflow_run", runId, run.updatedAt)
      )
    ).toBeNull();
  });

  test("a deferred wake delivers on the next drain trigger", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_terminal_defer_retry";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendNextEvent(runId, {
      type: "result",
      at: "2026-06-19T00:00:02.000Z",
      result: { reportMarkdown: "Workflow finished", structuredOutput: { ok: true } },
    });
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const terminalAttentionStore = new TerminalAttentionStore(config);
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    // The first drain sees a transient storage fault: the run stays queued with no timer
    // bookkeeping, and any later drain trigger (stream end, sweep) re-evaluates and delivers.
    let currentnessCalls = 0;
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => {
        currentnessCalls += 1;
        return Promise.resolve(currentnessCalls === 1 ? "indeterminate" : "current");
      });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).not.toHaveBeenCalled();

    (
      taskService as unknown as { scheduleTerminalAttentionDrain(id: string): void }
    ).scheduleTerminalAttentionDrain(parentId);
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const run = await runStore.getRun(runId);
    expect(
      await terminalAttentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("workflow_run", runId, run.updatedAt)
      )
    ).toMatchObject({ status: "delivered" });
  });

  test("drains for a removed workspace drop queued workflow wakes without touching disk", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_terminal_enqueue_removed_owner";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendNextEvent(runId, {
      type: "result",
      at: "2026-06-19T00:00:02.000Z",
      result: { reportMarkdown: "Workflow finished", structuredOutput: { ok: true } },
    });
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    // The owner is removed (config entry gone, session directory deleted) before the drain
    // runs; the drain must not recreate the deleted session directory or leave queued state
    // for a future workspace reusing the ID.
    const cfg = config.loadConfigOrDefault();
    for (const project of cfg.projects.values()) {
      project.workspaces = project.workspaces.filter((workspace) => workspace.id !== parentId);
    }
    await config.editConfig(() => cfg);
    const sessionDir = path.join(config.sessionsDir, parentId);
    await fsPromises.rm(sessionDir, { recursive: true, force: true });

    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(existsSync(sessionDir)).toBe(false);
    const queued = (
      taskService as unknown as {
        pendingWorkflowRunAttention: Map<string, Set<string>>;
      }
    ).pendingWorkflowRunAttention;
    expect(queued.has(parentId)).toBe(false);
  });

  test("a legacy pending workflow outbox record is deleted by the next drain", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createTaskServiceHarness(config);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const legacy = await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workflow_run",
      sourceId: "wfr_legacy_outbox",
    });
    assert(legacy, "legacy workflow attention must enqueue");

    await (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention(parentId);

    // Deleted outright rather than superseded: workflow wakes are re-derived from run
    // records now, so a pre-reconciler pending record is dead state that would otherwise
    // hold the drain hot forever.
    expect(await terminalAttentionStore.get(parentId, legacy.id)).toBeNull();
  });

  test("the sweep re-queues a resumed run's new terminal generation past the old delivered marker", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_recovery_stale_generation";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: new Date(Date.now() - 120_000).toISOString(),
    });
    await runStore.appendStatus(runId, "running", new Date(Date.now() - 90_000).toISOString());
    await runStore.appendStatus(runId, "failed", new Date(Date.now() - 60_000).toISOString());

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const sweep = () =>
      (
        taskService as unknown as {
          sweepWorkflowRunTerminalAttention(): Promise<number>;
        }
      ).sweepWorkflowRunTerminalAttention();

    // First generation delivers normally, leaving a delivered marker bound to that terminal
    // generation; the sweep must not re-queue an already-settled generation.
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "failed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(await sweep()).toBe(0);
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // The resumed run reaches terminal again with a newer updatedAt; the old delivered marker
    // belongs to the previous generation, so the sweep re-queues the wake without any reset
    // bookkeeping having run.
    await runStore.appendStatus(runId, "running", new Date(Date.now() + 30_000).toISOString(), {
      allowFailedCheckpointRetry: true,
    });
    await runStore.appendStatus(runId, "failed", new Date(Date.now() + 60_000).toISOString());

    expect(await sweep()).toBe(1);
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("the sweep honors a recent stable marker from the previous build and re-queues past a stale one", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_upgrade_stable_marker";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: new Date(Date.now() - 120_000).toISOString(),
    });
    await runStore.appendStatus(runId, "running", new Date(Date.now() - 90_000).toISOString());
    await runStore.appendStatus(runId, "failed", new Date(Date.now() - 60_000).toISOString());

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const sweep = () =>
      (
        taskService as unknown as {
          sweepWorkflowRunTerminalAttention(): Promise<number>;
        }
      ).sweepWorkflowRunTerminalAttention();

    // The previous build consumed the result (e.g. a kernel-nested task_await) and recorded
    // only the stable un-suffixed marker; no generation marker exists.
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.recordSettled({
      ownerWorkspaceId: parentId,
      sourceKind: "workflow_run",
      sourceId: runId,
      terminalOutcome: "failed",
      status: "delivered",
    });

    // Upgrade sweep: the stable marker postdates the terminal generation, so the wake is
    // already consumed and the decision migrates onto this generation's marker.
    expect(await sweep()).toBe(0);
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).not.toHaveBeenCalled();
    const run = await runStore.getRun(runId);
    const migrated = await terminalAttentionStore.get(
      parentId,
      TerminalAttentionStore.notificationId("workflow_run", runId, run.updatedAt)
    );
    expect(migrated?.status).toBe("delivered");

    // A resume that reaches terminal after the marker was written makes the stable marker
    // stale (its restart-time clear is best-effort): the newer generation must re-queue.
    await runStore.appendStatus(runId, "running", new Date(Date.now() + 30_000).toISOString(), {
      allowFailedCheckpointRetry: true,
    });
    await runStore.appendStatus(runId, "failed", new Date(Date.now() + 60_000).toISOString());
    expect(await sweep()).toBe(1);
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("unarchive reconciliation delivers a wake parked by the archived-owner drain", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_unarchive_requeue";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
    );
    const setArchivedState = async (field: "archivedAt" | "unarchivedAt") => {
      await config.editConfig((cfg) => {
        const entry = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === parentId);
        assert(entry, "parent workspace must exist");
        entry[field] = new Date().toISOString();
        return cfg;
      });
    };
    await setArchivedState("archivedAt");

    // Terminal lands while archived: the drain parks the wake durably (queue dropped, no
    // settlement marker).
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).not.toHaveBeenCalled();

    // Unarchive-time reconciliation re-queues and delivers without waiting for the interval
    // sweep.
    await setArchivedState("unarchivedAt");
    await taskService.noteWorkspaceUnarchived(parentId);
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain(runId);
  });

  test("settling a stale generation snapshot does not suppress a newer resumed result", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_mid_settlement_resume";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: new Date(Date.now() - 120_000).toISOString(),
    });
    await runStore.appendStatus(runId, "running", new Date(Date.now() - 90_000).toISOString());
    await runStore.appendStatus(runId, "failed", new Date(Date.now() - 60_000).toISOString());

    // The first wake turn resumes the run in the background and the newer generation reaches
    // terminal before the outer drain settles its stale first-generation snapshot. The owner
    // stays busy (streaming the wake turn) until that settlement completes, so the callback's
    // interim drain defers instead of delivering the newer generation early.
    let ownerBusy = false;
    let simulateResumeDuringWake: (() => Promise<void>) | undefined;
    const sendMessage = mock(async (..._args: unknown[]): Promise<Result<void>> => {
      const simulate = simulateResumeDuringWake;
      simulateResumeDuringWake = undefined;
      await simulate?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    (workspaceService as unknown as Record<string, unknown>).hasPendingQueuedOrPreparingTurn = mock(
      () => ownerBusy
    );
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    simulateResumeDuringWake = async () => {
      ownerBusy = true;
      await runStore.appendStatus(runId, "running", new Date(Date.now() + 30_000).toISOString(), {
        allowFailedCheckpointRetry: true,
      });
      await runStore.appendStatus(runId, "failed", new Date(Date.now() + 60_000).toISOString());
      taskService.noteWorkflowRunTerminalAttention({
        ownerWorkspaceId: parentId,
        runId,
        status: "failed",
      });
    };
    const drain = (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention.bind(taskService);
    const sweep = () =>
      (
        taskService as unknown as {
          sweepWorkflowRunTerminalAttention(): Promise<number>;
        }
      ).sweepWorkflowRunTerminalAttention();

    (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.set(parentId, new Set([runId]));

    await drain(parentId);
    ownerBusy = false;
    await flushTerminalAttentionDrains(taskService);
    await drain(parentId);
    await flushTerminalAttentionDrains(taskService);

    // The stale snapshot's settlement must neither drop the newer generation's queue entry
    // nor leave a stable marker that postdates it (which the sweep's upgrade fallback would
    // migrate as delivered, permanently suppressing the result).
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(String(sendMessage.mock.calls[1]?.[1])).toContain(runId);
    expect(await sweep()).toBe(0);
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("a history clear during the busy fallback settles the wake instead of delivering", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_busy_fallback_clear";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    const run = await runStore.getRun(runId);

    // The idle-only send loses the busy race while a full clear completes; the fallback path
    // must not inject the retained pre-clear prompt without revalidating.
    let cleared = false;
    const sendMessage = mock((..._args: unknown[]): Promise<Result<void, SendMessageError>> => {
      const internal = _args[3] as { requireIdle?: boolean } | undefined;
      if (internal?.requireIdle === true) {
        cleared = true;
        return Promise.resolve(
          Err({ type: "unknown", raw: "Workspace is busy; idle-only send was skipped." })
        );
      }
      return Promise.resolve(Ok(undefined));
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve(cleared ? "not_current" : "current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
    );
    (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.set(parentId, new Set([runId]));

    await (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention(parentId);
    await flushTerminalAttentionDrains(taskService);

    // Only the rejected idle-only attempt: the fallback aborts on the currentness reread and
    // the re-poked drain settles the superseded generation instead of delivering it.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect((sendMessage.mock.calls[0]?.[3] as { requireIdle?: boolean })?.requireIdle).toBe(true);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const marker = await terminalAttentionStore.get(
      parentId,
      TerminalAttentionStore.notificationId("workflow_run", runId, run.updatedAt)
    );
    expect(marker?.status).toBe("superseded");
  });

  test("a run generation change after prompt derivation defers the wake instead of delivering", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_dispatch_generation_drift";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "failed", "2026-06-19T00:00:03.000Z");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void, SendMessageError>> =>
        Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    // A Workflows UI retry flips the run back to running (a NEW generation) after the prompt
    // snapshot is taken, without touching history or owner busy-ness: model it inside the
    // derivation-time currentness read so the materialized candidate retains the failed
    // generation while the run record has already moved on.
    let retried = false;
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(async () => {
        if (!retried) {
          retried = true;
          await runStore.appendStatus(runId, "running", "2026-06-19T00:00:05.000Z", {
            allowFailedCheckpointRetry: true,
          });
        }
        return "current" as const;
      });
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
    );
    const pending = (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention;
    pending.set(parentId, new Set([runId]));

    await (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention(parentId);
    await flushTerminalAttentionDrains(taskService);

    // The pre-dispatch revalidation sees the changed generation and defers: the retained
    // prompt would present the superseded failed result as final. The queue entry survives
    // so the resumed run's next terminal transition (or the sweep) re-derives.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(pending.get(parentId)?.has(runId)).toBe(true);
  });

  test("a kernel-consumed generation during the busy fallback is not redelivered", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_busy_fallback_consumed";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    const run = await runStore.getRun(runId);

    // The busy race the idle-only send loses IS a competing owner turn consuming this very
    // generation through kernel-nested task_await: that consumption writes only the
    // settlement marker (no history evidence, owner idle again afterwards).
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const sendMessage = mock(
      async (..._args: unknown[]): Promise<Result<void, SendMessageError>> => {
        const internal = _args[3] as { requireIdle?: boolean } | undefined;
        if (internal?.requireIdle === true) {
          await terminalAttentionStore.recordSettled({
            ownerWorkspaceId: parentId,
            sourceKind: "workflow_run",
            sourceId: runId,
            generationId: run.updatedAt,
            terminalOutcome: "completed",
            status: "delivered",
          });
          return Err({ type: "unknown", raw: "Workspace is busy; idle-only send was skipped." });
        }
        return Ok(undefined);
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
    );
    const pending = (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention;
    pending.set(parentId, new Set([runId]));

    await (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention(parentId);
    await flushTerminalAttentionDrains(taskService);

    // Only the rejected idle-only attempt: the fallback's settlement-marker recheck sees the
    // consumption and aborts instead of replaying the result without requireIdle. The
    // re-poked drain then drops the consumed candidate from the queue.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect((sendMessage.mock.calls[0]?.[3] as { requireIdle?: boolean })?.requireIdle).toBe(true);
    const marker = await terminalAttentionStore.get(
      parentId,
      TerminalAttentionStore.notificationId("workflow_run", runId, run.updatedAt)
    );
    expect(marker?.status).toBe("delivered");
    expect(pending.get(parentId)?.has(runId) ?? false).toBe(false);
  });

  test("a history mutation during the revalidation reads supersedes the wake instead of delivering", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_dispatch_mutation_during_reads";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    const run = await runStore.getRun(runId);

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void, SendMessageError>> =>
        Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    // A history clear retires the run's invocation DURING the revalidation's own run/marker
    // reads: model it on the second generation-marker read (the first is derivation's), so
    // only a currentness read taken AFTER those reads can observe it.
    let cleared = false;
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve(cleared ? ("not_current" as const) : ("current" as const)));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      terminalAttentionStore: TerminalAttentionStore;
      pendingWorkflowRunAttention: Map<string, Set<string>>;
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };
    const generationMarkerId = TerminalAttentionStore.notificationId(
      "workflow_run",
      runId,
      run.updatedAt
    );
    const realGet = internal.terminalAttentionStore.get.bind(internal.terminalAttentionStore);
    let generationMarkerReads = 0;
    const getSpy = spyOn(internal.terminalAttentionStore, "get").mockImplementation(
      (ownerWorkspaceId, notificationId) => {
        if (notificationId === generationMarkerId) {
          generationMarkerReads += 1;
          if (generationMarkerReads === 2) {
            cleared = true;
          }
        }
        return realGet(ownerWorkspaceId, notificationId);
      }
    );

    try {
      await historyService.appendToHistory(
        parentId,
        createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
      );
      internal.pendingWorkflowRunAttention.set(parentId, new Set([runId]));
      await internal.drainTerminalAttention(parentId);
      await flushTerminalAttentionDrains(taskService);
    } finally {
      getSpy.mockRestore();
    }

    // Currentness is the final await before dispatch: it postdates the run/marker reads, so
    // the clear is observed and the retained prompt is settled superseded, never sent.
    expect(sendMessage).not.toHaveBeenCalled();
    const probeStore = new TerminalAttentionStore(config);
    const marker = await probeStore.get(parentId, generationMarkerId);
    expect(marker?.status).toBe("superseded");
    expect(internal.pendingWorkflowRunAttention.get(parentId)?.has(runId) ?? false).toBe(false);
  });

  test("overlapping settlements preserve the newer generation's stable marker", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_overlapping_settlements";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "failed", "2026-06-19T00:00:03.000Z");
    const oldGeneration = (await runStore.getRun(runId)).updatedAt;
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:05.000Z", {
      allowFailedCheckpointRetry: true,
    });
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:07.000Z");
    const newGeneration = (await runStore.getRun(runId)).updatedAt;

    const { taskService } = createTaskServiceHarness(config);
    const internal = taskService as unknown as {
      terminalAttentionStore: TerminalAttentionStore;
      pendingWorkflowRunAttention: Map<string, Set<string>>;
    };
    internal.pendingWorkflowRunAttention.set(parentId, new Set([runId]));

    // Park the older generation's settlement inside its first marker write: the newer
    // generation's settlement (started while the older one is parked) can then only
    // interleave with the older one's post-write mismatch delete if settlements overlap.
    let releaseOldSettlement: () => void = () => undefined;
    const oldSettlementParked = new Promise<void>((resolve) => {
      releaseOldSettlement = resolve;
    });
    let parkedReached: () => void = () => undefined;
    const oldSettlementReached = new Promise<void>((resolve) => {
      parkedReached = resolve;
    });
    const realRecordSettled = internal.terminalAttentionStore.recordSettled.bind(
      internal.terminalAttentionStore
    );
    let parkedOnce = false;
    const settleSpy = spyOn(internal.terminalAttentionStore, "recordSettled").mockImplementation(
      async (record, options) => {
        if (record.generationId === oldGeneration && !parkedOnce) {
          parkedOnce = true;
          parkedReached();
          await oldSettlementParked;
        }
        return realRecordSettled(record, options);
      }
    );

    try {
      const oldSettlement = taskService.markWorkflowRunTerminalAttentionSettled({
        ownerWorkspaceId: parentId,
        runId,
        status: "failed",
        runUpdatedAt: oldGeneration,
        settledAs: "superseded",
      });
      await oldSettlementReached;
      const newSettlement = taskService.markWorkflowRunTerminalAttentionSettled({
        ownerWorkspaceId: parentId,
        runId,
        status: "completed",
        runUpdatedAt: newGeneration,
        settledAs: "delivered",
      });
      // The newer settlement must queue behind the parked older one instead of interleaving.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const midProbeStore = new TerminalAttentionStore(config);
      expect(
        await midProbeStore.get(
          parentId,
          TerminalAttentionStore.notificationId("workflow_run", runId, newGeneration)
        )
      ).toBeNull();
      releaseOldSettlement();
      await Promise.all([oldSettlement, newSettlement]);
    } finally {
      settleSpy.mockRestore();
    }

    // The older settlement's mismatch delete ran before the newer settlement's stable
    // refresh, so the newer generation's markers survive and the queue entry is consumed.
    const probeStore = new TerminalAttentionStore(config);
    const stable = await probeStore.get(
      parentId,
      TerminalAttentionStore.notificationId("workflow_run", runId)
    );
    expect(stable?.generationId).toBe(newGeneration);
    const generationMarker = await probeStore.get(
      parentId,
      TerminalAttentionStore.notificationId("workflow_run", runId, newGeneration)
    );
    expect(generationMarker?.status).toBe("delivered");
    expect(internal.pendingWorkflowRunAttention.get(parentId)?.has(runId) ?? false).toBe(false);
  });

  test("a newer generation's settlement refreshes a surviving stale stable marker", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_stable_marker_refresh";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: new Date(Date.now() - 120_000).toISOString(),
    });
    await runStore.appendStatus(runId, "running", new Date(Date.now() - 90_000).toISOString());
    await runStore.appendStatus(runId, "failed", new Date(Date.now() - 60_000).toISOString());

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const sweep = () =>
      (
        taskService as unknown as {
          sweepWorkflowRunTerminalAttention(): Promise<number>;
        }
      ).sweepWorkflowRunTerminalAttention();

    // First generation delivers and records the stable whole-run marker.
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "failed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const firstGeneration = (await runStore.getRun(runId)).updatedAt;

    // The run resumes without the restart-time bookkeeping (its best-effort stable clear
    // failed), so the stale first-generation marker survives into the new generation.
    await runStore.appendStatus(runId, "running", new Date(Date.now() + 30_000).toISOString(), {
      allowFailedCheckpointRetry: true,
    });
    await runStore.appendStatus(runId, "failed", new Date(Date.now() + 60_000).toISOString());
    expect(await sweep()).toBe(1);
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    // The newer generation's settlement must refresh the write-once stable marker: a
    // downgraded build reads it as "latest consumed generation", and a record still carrying
    // the previous generation would suppress the newer result's wake after a downgrade.
    const run = await runStore.getRun(runId);
    expect(run.updatedAt).not.toBe(firstGeneration);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const stableMarker = await terminalAttentionStore.get(
      parentId,
      TerminalAttentionStore.notificationId("workflow_run", runId)
    );
    expect(stableMarker?.status).toBe("delivered");
    expect(stableMarker?.generationId).toBe(run.updatedAt);
  });

  test("the sweep honors a generation-tagged stable marker across clock corrections", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_stable_marker_clock_skew";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: new Date(Date.now() - 30_000).toISOString(),
    });
    await runStore.appendStatus(runId, "running", new Date(Date.now() - 10_000).toISOString());
    // The clock stepped back after this terminal transition, so the settlement marker below
    // carries a createdAt that PRECEDES the generation it consumed.
    await runStore.appendStatus(runId, "failed", new Date(Date.now() + 60_000).toISOString());
    const run = await runStore.getRun(runId);

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.recordSettled(
      {
        ownerWorkspaceId: parentId,
        sourceKind: "workflow_run",
        sourceId: runId,
        generationId: run.updatedAt,
        terminalOutcome: "failed",
        status: "delivered",
      },
      { wholeSourceRefresh: true }
    );

    // Exact generation evidence must win over wall-clock ordering: the marker consumed this
    // very generation, so the sweep must not re-queue and re-deliver it.
    expect(
      await (
        taskService as unknown as {
          sweepWorkflowRunTerminalAttention(): Promise<number>;
        }
      ).sweepWorkflowRunTerminalAttention()
    ).toBe(0);
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).not.toHaveBeenCalled();
    const migrated = await terminalAttentionStore.get(
      parentId,
      TerminalAttentionStore.notificationId("workflow_run", runId, run.updatedAt)
    );
    expect(migrated?.status).toBe("delivered");
  });

  test("an unreadable settlement marker skips only that run and never rejects the sweep", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    for (const runId of ["wfr_sweep_marker_a", "wfr_sweep_marker_b"]) {
      await runStore.createRun({
        id: runId,
        workspaceId: parentId,
        workflow: {
          name: "research",
          description: "Research workflow",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
        args: {},
        attentionPolicy: "notify_on_terminal",
        now: "2026-06-19T00:00:00.000Z",
      });
      await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
      await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    }

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    // Keep the queue observable: indeterminate currentness defers every drain delivery.
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("indeterminate"));
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      sweepWorkflowRunTerminalAttention(): Promise<number>;
      terminalAttentionStore: TerminalAttentionStore;
      pendingWorkflowRunAttention: Map<string, Set<string>>;
    };
    const realGet = internal.terminalAttentionStore.get.bind(internal.terminalAttentionStore);
    const getSpy = spyOn(internal.terminalAttentionStore, "get")
      // Lazy rejection: an eager mockRejectedValueOnce promise trips bun's unhandled-rejection
      // detector on this host before the sweep consumes it.
      .mockImplementationOnce(() => Promise.reject(new Error("EACCES: marker unreadable")))
      .mockImplementation(realGet);

    try {
      // Startup awaits this sweep: one damaged marker must skip its run, not abort the sweep.
      expect(await internal.sweepWorkflowRunTerminalAttention()).toBe(1);
      expect(internal.pendingWorkflowRunAttention.get(parentId)?.size).toBe(1);

      // The skipped run is re-derived once the marker read recovers.
      expect(await internal.sweepWorkflowRunTerminalAttention()).toBe(1);
      expect(internal.pendingWorkflowRunAttention.get(parentId)?.size).toBe(2);
    } finally {
      getSpy.mockRestore();
    }
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("a failed settlement marker write never rejects and keeps the queue entry", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createTaskServiceHarness(config);
    const internal = taskService as unknown as {
      terminalAttentionStore: TerminalAttentionStore;
      pendingWorkflowRunAttention: Map<string, Set<string>>;
    };
    internal.pendingWorkflowRunAttention.set(parentId, new Set(["wfr_marker_soft_fail"]));
    const settleSpy = spyOn(internal.terminalAttentionStore, "recordSettled")
      // Lazy rejection: an eager mockRejectedValueOnce promise trips bun's unhandled-rejection
      // detector on this host before the call consumes it.
      .mockImplementationOnce(() => Promise.reject(new Error("EACCES: marker dir unwritable")));

    const settleParams = {
      ownerWorkspaceId: parentId,
      runId: "wfr_marker_soft_fail",
      status: "completed" as const,
      runUpdatedAt: "2026-06-19T00:00:03.000Z",
      settledAs: "delivered" as const,
    };
    try {
      // Marker I/O must stay contained (workflow_resume/task_await return durable results
      // through this call), and the queue entry must survive so the next drain re-attempts.
      await taskService.markWorkflowRunTerminalAttentionSettled(settleParams);
      expect(internal.pendingWorkflowRunAttention.get(parentId)?.has("wfr_marker_soft_fail")).toBe(
        true
      );

      await taskService.markWorkflowRunTerminalAttentionSettled(settleParams);
      expect(internal.pendingWorkflowRunAttention.get(parentId)?.has("wfr_marker_soft_fail")).toBe(
        false
      );
    } finally {
      settleSpy.mockRestore();
    }
  });

  test("a history clear between classification and dispatch settles the wake instead of delivering", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_clear_race";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    const run = await runStore.getRun(runId);

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    // Classification sees a current invocation; a full clear then retires the sidecar before
    // the batch reaches sendMessage, so the last-moment reread must see not_current.
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("not_current")).mockImplementationOnce(() =>
        Promise.resolve("current")
      );
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });
    const drain = (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention.bind(taskService);

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
    );
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId,
    });
    (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.set(parentId, new Set([runId]));

    await drain(parentId);
    await flushTerminalAttentionDrains(taskService);

    // The pre-clear result must not wake the freshly cleared conversation; the run settles
    // superseded for this terminal generation and stays retrievable via workflow_resume.
    expect(sendMessage).not.toHaveBeenCalled();
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const marker = await terminalAttentionStore.get(
      parentId,
      TerminalAttentionStore.notificationId("workflow_run", runId, run.updatedAt)
    );
    expect(marker?.status).toBe("superseded");
    expect(
      (
        taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
      ).pendingWorkflowRunAttention
        .get(parentId)
        ?.has(runId) ?? false
    ).toBe(false);
  });

  test("a history clear during resume-option resolution settles the wake instead of delivering", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_resolve_clear_race";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    const run = await runStore.getRun(runId);

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    // Classification sees a current invocation; the clear completes while the drain resolves
    // resume options, so only a currentness reread taken AFTER that resolution observes it.
    let cleared = false;
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve(cleared ? "not_current" : "current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });
    const svc = taskService as unknown as {
      resolveParentAutoResumeOptions: (...args: unknown[]) => Promise<unknown>;
    };
    const originalResolve = svc.resolveParentAutoResumeOptions.bind(taskService);
    svc.resolveParentAutoResumeOptions = async (...args: unknown[]) => {
      const resolved = await originalResolve(...args);
      cleared = true;
      return resolved;
    };
    const drain = (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention.bind(taskService);

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
    );
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId,
    });
    (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.set(parentId, new Set([runId]));

    await drain(parentId);
    await flushTerminalAttentionDrains(taskService);

    // The pre-clear result must not wake the freshly cleared conversation.
    expect(sendMessage).not.toHaveBeenCalled();
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const marker = await terminalAttentionStore.get(
      parentId,
      TerminalAttentionStore.notificationId("workflow_run", runId, run.updatedAt)
    );
    expect(marker?.status).toBe("superseded");
  });

  test("an indeterminate newest group does not stall an older deliverable group", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const oldRunId = "wfr_group_old";
    const newRunId = "wfr_group_new";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    for (const runId of [oldRunId, newRunId]) {
      await runStore.createRun({
        id: runId,
        workspaceId: parentId,
        workflow: {
          name: "research",
          description: "Research workflow",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
        args: {},
        attentionPolicy: "notify_on_terminal",
        now: "2026-06-19T00:00:00.000Z",
      });
      await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
      await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    }

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    // Classification (first call per run) sees both runs current; the last-moment reread then
    // fails transiently for the NEWEST group only. The drain must fall through to the older
    // group in the same cycle instead of parking every wake on the sweep.
    const currentnessCalls = new Map<string, number>();
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock((_workspaceId: string, runId: string) => {
        const count = (currentnessCalls.get(runId) ?? 0) + 1;
        currentnessCalls.set(runId, count);
        if (count === 1) {
          return Promise.resolve("current");
        }
        return Promise.resolve(runId === newRunId ? "indeterminate" : "current");
      });
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });
    const drain = (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention.bind(taskService);

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audits", { timestamp: 1_000 })
    );
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId: oldRunId,
      createdAtMs: 1_100,
      agentId: "exec",
    });
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId: newRunId,
      createdAtMs: 1_500,
      agentId: "plan",
    });
    (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.set(parentId, new Set([oldRunId, newRunId]));

    await drain(parentId);
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const prompt = String(sendMessage.mock.calls[0]?.[1]);
    expect(prompt).toContain(oldRunId);
    expect(prompt).not.toContain(newRunId);
    expect(sendMessage.mock.calls[0]?.[2] as Record<string, unknown>).toMatchObject({
      agentId: "exec",
    });
    // The unreadable group stays queued for the next drain or sweep, never settled.
    expect(
      (
        taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
      ).pendingWorkflowRunAttention
        .get(parentId)
        ?.has(newRunId)
    ).toBe(true);
  });

  test("a generation settled during the owner's stream is not redelivered by the terminal callback", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_settled_requeue";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    // A kernel-nested task_await consumed the durable result and settled the generation while
    // the owner was still streaming, before WorkflowService reached its terminal callback.
    await taskService.markWorkflowRunTerminalAttentionSettled({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
      runUpdatedAt: "2026-06-19T00:00:03.000Z",
      settledAs: "delivered",
    });
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);

    // Kernel consumption leaves no history evidence, so only the durable marker can stop the
    // re-queued entry from waking the owner with a duplicate result.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      (
        taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
      ).pendingWorkflowRunAttention
        .get(parentId)
        ?.has(runId) ?? false
    ).toBe(false);
  });

  test("a rejected group send backs off and lets an older group deliver in the same cycle", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const oldRunId = "wfr_backoff_old";
    const newRunId = "wfr_backoff_new";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    for (const runId of [oldRunId, newRunId]) {
      await runStore.createRun({
        id: runId,
        workspaceId: parentId,
        workflow: {
          name: "research",
          description: "Research workflow",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
        args: {},
        attentionPolicy: "notify_on_terminal",
        now: "2026-06-19T00:00:00.000Z",
      });
      await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
      await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    }

    // The newest group's send is persistently rejected (its pinned agent cannot resolve);
    // the older group's send succeeds.
    const sendMessage = mock((..._args: unknown[]): Promise<Result<void, SendMessageError>> => {
      const options = _args[2] as { agentId?: string } | undefined;
      return options?.agentId === "plan"
        ? Promise.resolve(Err({ type: "unknown", raw: "agent not resolvable" }))
        : Promise.resolve(Ok(undefined));
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audits", { timestamp: 1_000 })
    );
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId: oldRunId,
      createdAtMs: 1_100,
      agentId: "exec",
    });
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId: newRunId,
      createdAtMs: 1_500,
      agentId: "plan",
    });
    (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.set(parentId, new Set([oldRunId, newRunId]));

    await (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention(parentId);
    await flushTerminalAttentionDrains(taskService);

    // First attempt selects the newest group and is rejected; the re-poked drain skips the
    // backed-off group and delivers the older one instead of parking it on the sweep.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({ agentId: "plan" });
    expect(sendMessage.mock.calls[1]?.[2]).toMatchObject({ agentId: "exec" });
    expect(String(sendMessage.mock.calls[1]?.[1])).toContain(oldRunId);
    const queued = (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.get(parentId);
    // The rejected group stays queued for the sweep-cadence retry, never settled.
    expect(queued?.has(newRunId)).toBe(true);
    expect(queued?.has(oldRunId) ?? false).toBe(false);
  });

  test("settlement writes the stable marker the previous build dedupes recovery on", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_downgrade_stable";
    // A real run record also materializes the owner session dir: settlement markers refuse to
    // recreate a removed owner dir by design, so the fixture must exist like in production.
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    const { taskService } = createTaskServiceHarness(config);
    await taskService.markWorkflowRunTerminalAttentionSettled({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
      runUpdatedAt: "2026-06-19T00:00:03.000Z",
      settledAs: "delivered",
    });

    const terminalAttentionStore = new TerminalAttentionStore(config);
    // The previous build recovers by enqueueIfAbsent on the stable un-suffixed id: an existing
    // record must block it from re-creating a pending wake for the consumed result.
    expect(
      await terminalAttentionStore.enqueueIfAbsent({
        ownerWorkspaceId: parentId,
        sourceKind: "workflow_run",
        sourceId: runId,
      })
    ).toBeNull();
    // This build's generation marker is written alongside it.
    expect(
      await terminalAttentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("workflow_run", runId, "2026-06-19T00:00:03.000Z")
      )
    ).toMatchObject({ status: "delivered" });
  });

  test("the sweep does not queue an intentionally interrupted run", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    for (const [runId, status] of [
      ["wfr_sweep_interrupted", "interrupted"],
      ["wfr_sweep_completed", "completed"],
    ] as const) {
      await runStore.createRun({
        id: runId,
        workspaceId: parentId,
        workflow: {
          name: "research",
          description: "Research workflow",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
        args: {},
        attentionPolicy: "notify_on_terminal",
        now: "2026-06-19T00:00:00.000Z",
      });
      await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
      await runStore.appendStatus(runId, status, "2026-06-19T00:00:03.000Z");
    }

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    // Keep the queue observable: indeterminate currentness defers every drain delivery.
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("indeterminate"));
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      sweepWorkflowRunTerminalAttention(): Promise<number>;
      pendingWorkflowRunAttention: Map<string, Set<string>>;
    };

    // The user stopped the interrupted run: re-deriving a continuation wake for it would undo
    // the stop with new agent actions. Only the completed run owes attention.
    expect(await internal.sweepWorkflowRunTerminalAttention()).toBe(1);
    const queued = internal.pendingWorkflowRunAttention.get(parentId);
    expect(queued?.has("wfr_sweep_completed")).toBe(true);
    expect(queued?.has("wfr_sweep_interrupted") ?? false).toBe(false);
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("a restarted run clears the stable downgrade marker but keeps generation markers", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_restart_compat";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    const { taskService } = createTaskServiceHarness(config);
    await taskService.markWorkflowRunTerminalAttentionSettled({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
      runUpdatedAt: "2026-06-19T00:00:03.000Z",
      settledAs: "delivered",
    });

    await taskService.clearWorkflowRunDowngradeSettlement({ ownerWorkspaceId: parentId, runId });

    const terminalAttentionStore = new TerminalAttentionStore(config);
    // The previous build re-arms a restarted run by deleting the stable id; after the clear
    // its recovery probe can enqueue the run's next result again instead of dropping it.
    expect(
      await terminalAttentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("workflow_run", runId)
      )
    ).toBeNull();
    // This build's generation marker is untouched: the old generation stays settled here.
    expect(
      await terminalAttentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("workflow_run", runId, "2026-06-19T00:00:03.000Z")
      )
    ).toMatchObject({ status: "delivered" });
  });

  test("workflow wake restriction recovery stops at a context reset boundary", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_policy_reset_boundary";
    const restrictedPolicy = [{ regex_match: "^bash$", action: "disable" as const }];
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    // The pre-reset manual row disabled bash, but the context reset discarded that
    // conversation. The workflow launched from a post-reset synthetic turn (heartbeat), so
    // its wake must use fresh defaults instead of resurrecting the discarded restriction.
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual-restricted", "user", "run the audit", {
        timestamp: 1_000,
        toolPolicy: restrictedPolicy,
        disableWorkspaceAgents: true,
      })
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("reset-boundary", "assistant", "Context reset", {
        timestamp: 2_000,
        contextBoundaryKind: "reset",
      })
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("heartbeat-launch", "user", "[heartbeat] launch the workflow", {
        timestamp: 3_000,
        synthetic: true,
      })
    );

    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const options = sendMessage.mock.calls[0]?.[2] as {
      toolPolicy?: unknown;
      disableWorkspaceAgents?: unknown;
    };
    expect(options.toolPolicy).toBeUndefined();
    expect(options.disableWorkspaceAgents).toBeUndefined();
  });

  test("workflow wakes restore the caller tool policy from the newest manual row", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const restrictedPolicy = [{ regex_match: "^bash$", action: "disable" as const }];
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    const createRun = async (runId: string) => {
      await runStore.createRun({
        id: runId,
        workspaceId: parentId,
        workflow: {
          name: "research",
          description: "Research workflow",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
        args: {},
        attentionPolicy: "notify_on_terminal",
        now: "2026-06-19T00:00:00.000Z",
      });
      await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
      await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    };
    await createRun("wfr_policy_restore");
    await createRun("wfr_policy_lifted");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    // The launch turn disabled bash; a later synthetic row (an earlier wake) defines no
    // policy and must be skipped. Omitting the policy on the wake would let workflow output
    // regain the disabled tool at a time the workflow chooses.
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual-restricted", "user", "run the audit", {
        timestamp: 1_000,
        toolPolicy: restrictedPolicy,
      })
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("earlier-wake", "user", "results delivered", {
        timestamp: 1_100,
        synthetic: true,
      })
    );
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId: "wfr_policy_restore",
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[2] as Record<string, unknown>).toMatchObject({
      toolPolicy: restrictedPolicy,
    });

    // A newer manual row without a policy means the caller lifted it: no restoration.
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual-unrestricted", "user", "carry on", { timestamp: 1_200 })
    );
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId: "wfr_policy_lifted",
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const liftedOptions = sendMessage.mock.calls[1]?.[2] as { toolPolicy?: unknown };
    expect(liftedOptions.toolPolicy).toBeUndefined();
  });

  test("workflow wakes skip the compaction request's own disable-all tool policy", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const restrictedPolicy = [{ regex_match: "^bash$", action: "disable" as const }];
    const compactionPolicy = [{ regex_match: ".*", action: "disable" as const }];
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    const createRun = async (runId: string) => {
      await runStore.createRun({
        id: runId,
        workspaceId: parentId,
        workflow: {
          name: "research",
          description: "Research workflow",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
        args: {},
        attentionPolicy: "notify_on_terminal",
        now: "2026-06-19T00:00:00.000Z",
      });
      await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
      await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    };
    await createRun("wfr_policy_through_compaction");
    await createRun("wfr_policy_unrestricted_compaction");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    const appendCompaction = async (id: string, timestamp: number) => {
      await historyService.appendToHistory(
        parentId,
        createMuxMessage(id, "user", "Summarize this conversation", {
          timestamp,
          synthetic: true,
          toolPolicy: compactionPolicy,
          muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
        })
      );
      await historyService.appendToHistory(
        parentId,
        createMuxMessage(id + "-summary", "assistant", "Summary", { timestamp: timestamp + 1 })
      );
      await historyService.appendToHistory(
        parentId,
        createMuxMessage(id + "-continue", "user", "Continue", {
          timestamp: timestamp + 2,
          synthetic: true,
        })
      );
    };

    // The compaction row is the newest user row carrying a tool policy, but that policy only
    // governed the summary turn. The wake must reach the manual row beneath it.
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual-restricted", "user", "run the audit", {
        timestamp: 1_000,
        toolPolicy: restrictedPolicy,
      })
    );
    await appendCompaction("compaction-1", 1_100);
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId: "wfr_policy_through_compaction",
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[2] as Record<string, unknown>).toMatchObject({
      toolPolicy: restrictedPolicy,
    });

    // An unrestricted manual row followed by a compaction must wake with tools available.
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual-unrestricted", "user", "carry on", { timestamp: 1_200 })
    );
    await appendCompaction("compaction-2", 1_300);
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId: "wfr_policy_unrestricted_compaction",
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const unrestrictedOptions = sendMessage.mock.calls[1]?.[2] as { toolPolicy?: unknown };
    expect(unrestrictedOptions.toolPolicy).toBeUndefined();
  });

  test("wake restoration walks a long agent-less tail: caller policy, agent identity, disable flag", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const restrictedPolicy = [{ regex_match: "^bash$", action: "disable" as const }];
    const runId = "wfr_policy_long_tail";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual-restricted", "user", "run the audit", {
        timestamp: 1_000,
        toolPolicy: restrictedPolicy,
        disableWorkspaceAgents: true,
        retrySendOptions: {
          model: "openai:gpt-4o",
          agentId: "exec",
          strictAgentResolution: { expectedScope: "project", expectedSource: "/repo/.xum/agents" },
        },
      })
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("agent-turn", "assistant", "on it", { timestamp: 1_000, agentId: "plan" })
    );
    // A tail longer than any bounded history read: the launch turn's restrictions must still
    // be found, not silently lifted once enough rows accumulate after the manual turn.
    for (let i = 0; i < 60; i++) {
      await historyService.appendToHistory(
        parentId,
        createMuxMessage(`assistant-${i}`, "assistant", `progress ${i}`, { timestamp: 1_001 + i })
      );
    }
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[2] as Record<string, unknown>).toMatchObject({
      agentId: "plan",
      strictAgentResolution: { expectedScope: "project", expectedSource: "/repo/.xum/agents" },
      toolPolicy: restrictedPolicy,
      disableWorkspaceAgents: true,
    });
  });

  test("workflow wakes bind to the initiating agent, not a later synthetic turn's agent", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_initiating_agent";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("launch-turn", "assistant", "starting", {
        timestamp: 1_001,
        agentId: "plan",
      })
    );
    // A heartbeat is synthetic, not a manual supersession boundary: the run stays current, but
    // its agent-bearing assistant row is now the newest one in history. The wake must use the
    // launch turn's agent from the sidecar, not the heartbeat's.
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("heartbeat", "user", "heartbeat", { timestamp: 1_002, synthetic: true })
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("heartbeat-turn", "assistant", "idle check", {
        timestamp: 1_003,
        agentId: "exec",
      })
    );
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId,
      agentId: "plan",
    });

    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[2] as Record<string, unknown>).toMatchObject({
      agentId: "plan",
    });
  });

  test("coalesced workflow wakes split by initiating agent", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    const createRun = async (runId: string) => {
      await runStore.createRun({
        id: runId,
        workspaceId: parentId,
        workflow: {
          name: "research",
          description: "Research workflow",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
        args: {},
        attentionPolicy: "notify_on_terminal",
        now: "2026-06-19T00:00:00.000Z",
      });
      await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
      await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    };
    await createRun("wfr_split_plan");
    await createRun("wfr_split_exec");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });
    const drain = (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention.bind(taskService);

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run both audits", { timestamp: 1_000 })
    );
    // Two current runs from different initiating agents: one coalesced wake would hand the
    // older run's (attacker-influenced) output to the newer agent's tool grants.
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId: "wfr_split_exec",
      createdAtMs: 1_000,
      agentId: "exec",
    });
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId: "wfr_split_plan",
      createdAtMs: 2_000,
      agentId: "plan",
    });

    // Seed the in-memory queue directly so ONE drain observes both runs; per-note drains
    // would deliver them separately without exercising the coalescing path.
    const terminalAttentionStore = new TerminalAttentionStore(config);
    (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.set(parentId, new Set(["wfr_split_plan", "wfr_split_exec"]));
    await drain(parentId);

    // The newest launch's group delivers first, alone, under its own agent.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const firstPrompt = String(sendMessage.mock.calls[0]?.[1]);
    expect(firstPrompt).toContain("wfr_split_plan");
    expect(firstPrompt).not.toContain("wfr_split_exec");
    expect(sendMessage.mock.calls[0]?.[2] as Record<string, unknown>).toMatchObject({
      agentId: "plan",
    });

    // The deferred group delivers on a later drain under its own agent.
    await drain(parentId);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const secondPrompt = String(sendMessage.mock.calls[1]?.[1]);
    expect(secondPrompt).toContain("wfr_split_exec");
    expect(secondPrompt).not.toContain("wfr_split_plan");
    expect(sendMessage.mock.calls[1]?.[2] as Record<string, unknown>).toMatchObject({
      agentId: "exec",
    });
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("coalesced workflow wakes split by strict pin within one agent", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    const createRun = async (runId: string) => {
      await runStore.createRun({
        id: runId,
        workspaceId: parentId,
        workflow: {
          name: "research",
          description: "Research workflow",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
        args: {},
        attentionPolicy: "notify_on_terminal",
        now: "2026-06-19T00:00:00.000Z",
      });
      await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
      await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    };
    await createRun("wfr_pin_split_pinned");
    await createRun("wfr_pin_split_unpinned");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });
    const drain = (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention.bind(taskService);

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run both audits", { timestamp: 1_000 })
    );
    // Same agentId, different launch pins (an agent definition replaced between synthetic
    // launches): one coalesced wake would process the pinned run's output under the newer
    // verified-unpinned launch.
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId: "wfr_pin_split_pinned",
      createdAtMs: 1_000,
      agentId: "plan",
      strictAgentResolution: { expectedScope: "built-in" },
    });
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId: "wfr_pin_split_unpinned",
      createdAtMs: 2_000,
      agentId: "plan",
      strictAgentResolution: null,
    });

    const terminalAttentionStore = new TerminalAttentionStore(config);
    // Seed the in-memory queue directly so ONE drain observes both runs.
    (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.set(
      parentId,
      new Set(["wfr_pin_split_pinned", "wfr_pin_split_unpinned"])
    );
    await drain(parentId);

    // The newest launch delivers first, alone, without the other launch's pin.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const firstPrompt = String(sendMessage.mock.calls[0]?.[1]);
    expect(firstPrompt).toContain("wfr_pin_split_unpinned");
    expect(firstPrompt).not.toContain("wfr_pin_split_pinned");
    const firstOptions = sendMessage.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(firstOptions.agentId).toBe("plan");
    expect(firstOptions.strictAgentResolution).toBeUndefined();

    // The pinned launch delivers on the retry drain under its own recorded pin.
    await drain(parentId);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const secondPrompt = String(sendMessage.mock.calls[1]?.[1]);
    expect(secondPrompt).toContain("wfr_pin_split_pinned");
    expect(secondPrompt).not.toContain("wfr_pin_split_unpinned");
    expect(sendMessage.mock.calls[1]?.[2] as Record<string, unknown>).toMatchObject({
      agentId: "plan",
      strictAgentResolution: { expectedScope: "built-in" },
    });
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("wake keeps a synthetic launch row's strict pin without lifting the manual policy", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const restrictedPolicy = [{ regex_match: "^bash$", action: "disable" as const }];
    const runId = "wfr_synthetic_pin";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual-restricted", "user", "run the audit", {
        timestamp: 1_000,
        toolPolicy: restrictedPolicy,
      })
    );
    // The kernel workflow launched from a pinned synthetic turn (preserved heartbeat or
    // compaction follow-up): its pin must ride the wake without lifting the manual policy.
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("synthetic-launch", "user", "heartbeat", {
        timestamp: 1_100,
        synthetic: true,
        retrySendOptions: {
          model: "openai:gpt-4o",
          agentId: "plan",
          strictAgentResolution: { expectedScope: "built-in" },
        },
      })
    );
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId,
      agentId: "plan",
    });

    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[2] as Record<string, unknown>).toMatchObject({
      agentId: "plan",
      toolPolicy: restrictedPolicy,
      strictAgentResolution: { expectedScope: "built-in" },
    });
  });

  test("transient run-store read failures defer the wake instead of dropping it", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const queued = (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention;

    // run.json exists but is unreadable (EISDIR): potentially transient, so the wake must
    // stay queued for a later drain or sweep instead of being dropped.
    const unreadableRunId = "wfr_unreadable";
    await fsPromises.mkdir(
      path.join(config.sessionsDir, parentId, "workflows", unreadableRunId, "run.json"),
      { recursive: true }
    );
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId: unreadableRunId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(queued.get(parentId)?.has(unreadableRunId)).toBe(true);

    // A definitively missing run (ENOENT) is dropped from the queue: the sweep re-derives
    // owed wakes from run records, so nothing durable is needed to keep it away.
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId: "wfr_missing",
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(queued.get(parentId)?.has("wfr_missing")).toBe(false);
    expect(queued.get(parentId)?.has(unreadableRunId)).toBe(true);
    expect(await terminalAttentionStore.get(parentId, "workflow_run:wfr_missing")).toBeNull();
  });

  test("wake defers when the launch-identity read fails after currentness succeeds", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_identity_unreadable";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    // Currentness succeeds without the sidecar (e.g. a direct invocation row)...
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const terminalAttentionStore = new TerminalAttentionStore(config);

    // ...but the launch-identity read fails transiently (EISDIR). Delivering without the
    // recorded identity would bind the wake to the newest agent-bearing history row, so the
    // wake must stay queued for the retry drain.
    await fsPromises.mkdir(path.join(config.sessionsDir, parentId, "agent-workflow-runs.json"), {
      recursive: true,
    });
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      (
        taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
      ).pendingWorkflowRunAttention
        .get(parentId)
        ?.has(runId)
    ).toBe(true);
    const run = await runStore.getRun(runId);
    expect(
      await terminalAttentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("workflow_run", runId, run.updatedAt)
      )
    ).toBeNull();
  });

  test("wake re-pins the selected group's recorded launch pin, not the newest row's", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    const createRun = async (runId: string) => {
      await runStore.createRun({
        id: runId,
        workspaceId: parentId,
        workflow: {
          name: "research",
          description: "Research workflow",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
        args: {},
        attentionPolicy: "notify_on_terminal",
        now: "2026-06-19T00:00:00.000Z",
      });
      await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
      await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    };
    await createRun("wfr_pin_unpinned");
    await createRun("wfr_pin_recorded");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audits", { timestamp: 1_000 })
    );
    // The newest pin-bearing row belongs to a DIFFERENT group's wake: pinning its provenance
    // onto this group's agentId would make resolution reject the wake on every retry.
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("other-group-wake", "user", "earlier group results", {
        timestamp: 1_100,
        synthetic: true,
        retrySendOptions: {
          model: "openai:gpt-4o",
          agentId: "plan",
          strictAgentResolution: { expectedScope: "project", expectedSource: "/repo/.xum/agents" },
        },
      })
    );

    // A verified-unpinned launch (null) must suppress the walk pin entirely.
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId: "wfr_pin_unpinned",
      agentId: "exec",
      strictAgentResolution: null,
    });
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId: "wfr_pin_unpinned",
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const unpinnedOptions = sendMessage.mock.calls[0]?.[2] as {
      agentId?: string;
      strictAgentResolution?: unknown;
    };
    expect(unpinnedOptions.agentId).toBe("exec");
    expect(unpinnedOptions.strictAgentResolution).toBeUndefined();

    // A recorded launch pin overrides the walk pin exactly.
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId: "wfr_pin_recorded",
      agentId: "plan",
      strictAgentResolution: { expectedScope: "built-in" },
    });
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId: "wfr_pin_recorded",
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[2] as Record<string, unknown>).toMatchObject({
      agentId: "plan",
      strictAgentResolution: { expectedScope: "built-in" },
    });
  });

  test("a malformed persisted toolPolicy cannot block the wake or leak into the send", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_policy_corrupt";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    // Persisted metadata is untrusted disk state: a corrupt toolPolicy shape must be dropped
    // (not copied into the send, where it would throw during resolution and permanently block
    // the wake), while the intact disable flag on the same row still applies.
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual-corrupt", "user", "run the audit", {
        timestamp: 1_000,
        toolPolicy: { bogus: true },
        disableWorkspaceAgents: true,
      } as unknown as Parameters<typeof createMuxMessage>[3])
    );
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const options = sendMessage.mock.calls[0]?.[2] as {
      toolPolicy?: unknown;
      disableWorkspaceAgents?: unknown;
    };
    expect(options.toolPolicy).toBeUndefined();
    expect(options.disableWorkspaceAgents).toBe(true);
  });
});
