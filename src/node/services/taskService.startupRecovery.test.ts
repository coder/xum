import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import * as path from "path";
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import { type ProjectsConfig } from "@/node/config";
import * as subagentGitPatchArtifacts from "@/node/services/subagentGitPatchArtifacts";
import { upsertSubagentGitPatchArtifact } from "@/node/services/subagentGitPatchArtifacts";
import { Ok, Err, type Result } from "@/common/types/result";
import { defaultModel } from "@/common/utils/ai/models";
import type { StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage } from "@/common/types/message";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import assert from "node:assert";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveLocalParentWorkspace,
  saveWorkspaces,
  streamEnd,
  testTaskSettings,
  workspaceTurnManagerFor,
  workspaceTurnSnapshot,
} from "@/node/services/taskService.testHarness";
import {
  createConfigBackedRemoveMock,
  createTaskServiceHarness,
  flushTerminalAttentionDrains,
  registerLiveWorkspaceTurnHandle,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
  removeWorkspaceFromTestConfig,
} from "@/node/services/taskService.shared.testHarness";

describe("TaskService", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  test.each([
    { taskStatus: "running", compacted: false },
    { taskStatus: "running", compacted: true },
    { taskStatus: undefined, compacted: true },
  ] as const)(
    "initialize recovers compaction before pending guidance (%j)",
    async ({ taskStatus, compacted }) => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      const parentWorkspaceId = "parent-restart-guidance";
      const childTaskId = "child-restart-guidance";

      await saveWorkspaces(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "parent", parentWorkspaceId),
          projectWorkspace(projectPath, "child", childTaskId, {
            parentWorkspaceId,
            agentId: "exec",
            agentType: "exec",
            taskStatus,
            taskModelString: "openai:gpt-5.2",
            taskPendingGuidance: [
              { id: "guidance-1", message: "First correction", queueDispatchMode: "turn-end" },
              { id: "guidance-2", message: "Second correction", queueDispatchMode: "tool-end" },
            ],
          }),
        ],
        testTaskSettings()
      );

      const recovered: string[] = [];
      const providerTurn = Promise.withResolvers<void>();
      const sendMessage = mock(
        async (
          _workspaceId: string,
          _message: string,
          _options: unknown,
          internal?: { onAccepted?: () => Promise<void> | void; startStreamInBackground?: boolean }
        ): Promise<Result<void>> => {
          recovered.push("guidance");
          await internal?.onAccepted?.();
          if (!internal?.startStreamInBackground) await providerTurn.promise;
          return Ok(undefined);
        }
      );
      const { workspaceService } = createWorkspaceServiceMocks({
        sendMessage,
        dispatchPendingCompactionFollowUp: mock(() => {
          recovered.push("compaction");
          return Promise.resolve(Ok(compacted));
        }),
      });
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      const initialization = taskService.initialize();
      try {
        // Replay must finish accepting every ID while the provider turn is still held open.
        expect((await raceWithAbortAndTimeout(initialization, { timeoutMs: 1_000 })).kind).toBe(
          "ok"
        );
      } finally {
        providerTurn.resolve();
        await initialization;
      }

      expect(sendMessage).toHaveBeenCalledTimes(2);
      for (const [index, mode] of ["turn-end", "tool-end"].entries()) {
        expect(sendMessage.mock.calls[index]?.[2]).toMatchObject({ queueDispatchMode: mode });
        expect(sendMessage.mock.calls[index]?.[3]).toMatchObject({
          synthetic: true,
          agentInitiated: true,
          queueDedupeKey: "guidance-" + (index + 1),
        });
      }
      expect(findWorkspaceInConfig(config, childTaskId)?.taskPendingGuidance).toBeUndefined();
      expect(recovered).toEqual(["compaction", "guidance", "guidance"]);
    }
  );

  const startupGuidanceStates = [
    "running",
    "awaiting_report",
    "stopped",
    "opted-out",
    "compaction-stopped",
    "compaction-unrecorded",
    "compaction-unsupported",
    "compaction-during-probe",
  ] as const;

  test.each([...startupGuidanceStates])(
    "startup restores question guidance only as a queue (%s)",
    async (state) => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      const childId = "question-child";
      const guidance = [
        { id: "first", message: "First correction", queueDispatchMode: "turn-end" as const },
        { id: "second", message: "Second correction", queueDispatchMode: "tool-end" as const },
      ];
      await saveWorkspaces(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "parent", "parent"),
          projectWorkspace(projectPath, "child", childId, {
            parentWorkspaceId: "parent",
            agentId: "exec",
            agentType: "exec",
            taskStatus: state === "awaiting_report" ? "awaiting_report" : "running",
            taskModelString: "openai:gpt-5.2",
            taskPendingGuidance: guidance,
          }),
        ],
        testTaskSettings()
      );
      const sends: Array<Parameters<WorkspaceHost["sendMessage"]>> = [];
      const sendMessage = mock((...args: Parameters<WorkspaceHost["sendMessage"]>) => {
        sends.push(args);
        return Promise.resolve(Ok(undefined));
      });
      const compaction = mock(() => Promise.resolve(Ok(false)));
      const { workspaceService } = createWorkspaceServiceMocks({
        sendMessage,
        dispatchPendingCompactionFollowUp: compaction,
      });
      const { taskService, historyService } = createTaskServiceHarness(config, {
        workspaceService,
      });
      await historyService.appendToHistory(childId, createMuxMessage("user", "user", "Work"));
      await historyService.writePartial(
        childId,
        createMuxMessage("question", "assistant", "", {}, [
          {
            type: "dynamic-tool",
            state: "input-available",
            toolCallId: "ask",
            toolName: "ask_user_question",
            input: { question: "Which option?" },
          },
        ])
      );
      if (state === "stopped" || state === "opted-out") {
        await fsPromises.writeFile(
          path.join(config.sessionsDir, childId, "auto-retry-preference.json"),
          JSON.stringify(
            state === "stopped"
              ? { startupAutoRetryAbandon: { reason: "aborted", userMessageId: "user" } }
              : { enabled: false }
          )
        );
      }
      const { session } = await createAgentSessionHarness({
        workspaceId: childId,
        config,
        historyService,
      });
      if (state === "compaction-stopped") {
        expect(await session.cancelCompaction(true)).toEqual(Ok(undefined));
      }
      if (state === "compaction-unrecorded") {
        const publication = spyOn(
          historyService,
          "withCompactionStorageLock"
        ).mockRejectedValueOnce(new Error("Stop publication unavailable"));
        expect((await session.cancelCompaction(true)).success).toBe(false);
        publication.mockRestore();
      }
      if (state === "compaction-during-probe") {
        const readTail = historyService.getLastMessages.bind(historyService);
        spyOn(historyService, "getLastMessages").mockImplementationOnce(async (...args) => {
          const result = await readTail(...args);
          expect(await session.cancelCompaction(true)).toEqual(Ok(undefined));
          return result;
        });
      }
      if (state === "compaction-unsupported") {
        await fsPromises.writeFile(
          historyService.getCompactionCancellationStorage(childId).path,
          JSON.stringify({ version: 99, futureIntent: "Stop" })
        );
      }
      workspaceService.getStartupRecoveryState = () =>
        session.getStartupRecoveryState(
          state === "compaction-unrecorded" || state === "compaction-unsupported" ? 25 : undefined
        );
      try {
        await taskService.initialize();
        expect(compaction).not.toHaveBeenCalled();
        if (state === "compaction-unrecorded" || state === "compaction-unsupported") {
          expect(sends).toHaveLength(0);
          expect(findWorkspaceInConfig(config, childId)?.taskPendingGuidance).toEqual(guidance);
          expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("running");
          return;
        }
        if (
          state === "stopped" ||
          state === "opted-out" ||
          state === "compaction-stopped" ||
          state === "compaction-during-probe"
        ) {
          expect(findWorkspaceInConfig(config, childId)?.taskPendingGuidance).toBeUndefined();
          expect(sends).toHaveLength(0);
          return;
        }
        expect(findWorkspaceInConfig(config, childId)?.taskPendingGuidance).toEqual(guidance);
        expect(sends).toHaveLength(2);
        for (const [index, entry] of guidance.entries()) {
          expect(sends[index]?.[2].queueDispatchMode).toBe(entry.queueDispatchMode);
          expect(sends[index]?.[3]).toMatchObject({
            restoreQueued: true,
            acceptanceOrigin: "automatic",
            queueDedupeKey: entry.id,
          });
        }
        const finalEvent: StreamEndEvent = {
          type: "stream-end",
          workspaceId: childId,
          messageId: "final",
          metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
          parts: [{ type: "text", text: "Finished with the corrections" }],
        };
        await streamEnd(taskService, finalEvent);
        expect(findWorkspaceInConfig(config, childId)?.taskStatus).not.toBe("reported");
        await taskService.sendMessageToDescendantAgentTask(
          "parent",
          childId,
          "Later correction",
          "turn-end"
        );
        const later = findWorkspaceInConfig(config, childId)?.taskPendingGuidance?.[2];
        assert(later != null);
        expect(sends[2]?.[3]?.queueDedupeKey).toBe(later.id);
        expect(sends[2]?.[3]?.acceptanceOrigin).toBe("automatic");
        await sends[0]?.[3]?.onAccepted?.();
        expect(findWorkspaceInConfig(config, childId)?.taskPendingGuidance).toEqual([
          guidance[1],
          later,
        ]);
        await sends[1]?.[3]?.onAccepted?.();
        expect(findWorkspaceInConfig(config, childId)?.taskPendingGuidance).toEqual([later]);
        await sends[2]?.[3]?.onAccepted?.();
        expect(findWorkspaceInConfig(config, childId)?.taskPendingGuidance).toBeUndefined();
        await historyService.deletePartial(childId);
        await streamEnd(taskService, finalEvent);
        expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
      } finally {
        await session.dispose();
      }
    }
  );

  test.each(["stop", "pre-stream-failure"] as const)(
    "restored guidance settles only its own reservation on %s",
    async (failure) => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      const childId = "canceled-guidance";
      const guidance = [
        { id: "first", message: "First correction", queueDispatchMode: "turn-end" as const },
        { id: "second", message: "Second correction", queueDispatchMode: "tool-end" as const },
      ];
      await saveWorkspaces(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "parent", "parent"),
          projectWorkspace(projectPath, "child", childId, {
            parentWorkspaceId: "parent",
            agentId: "exec",
            agentType: "exec",
            taskStatus: "running",
            taskPendingGuidance: guidance,
          }),
        ],
        testTaskSettings()
      );
      const { workspaceService } = createWorkspaceServiceMocks();
      const { taskService, historyService } = createTaskServiceHarness(config, {
        workspaceService,
      });
      const { session } = await createAgentSessionHarness({
        workspaceId: childId,
        config,
        historyService,
      });
      const settled = guidance.map(() => Promise.withResolvers<void>());
      const internals: Array<NonNullable<Parameters<WorkspaceHost["sendMessage"]>[3]>> = [];
      workspaceService.getStartupRecoveryState = () => Promise.resolve("question");
      workspaceService.sendMessage = (_id, message, options, internal) => {
        const index = internals.length;
        assert(internal != null);
        internals.push(internal);
        session.queueMessage(message, options, {
          ...internal,
          dedupeKey: internal.queueDedupeKey,
          onCanceled: async (reason) => {
            await internal.onCanceled?.(reason);
            settled[index].resolve();
          },
        });
        return Promise.resolve(Ok(undefined));
      };
      try {
        await taskService.initialize();
        if (failure === "stop") {
          session.removeQueuedMessagesByDedupeKeyPrefix("first", "Guidance canceled");
          await settled[0].promise;
        } else {
          await internals[0]?.onAcceptedPreStreamFailure?.({
            type: "unknown",
            raw: "Startup failed",
          });
        }
        expect(findWorkspaceInConfig(config, childId)?.taskPendingGuidance).toEqual([guidance[1]]);
        expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("running");
        expect((await session.interruptStream()).success).toBe(true);
        // WorkspaceService's user Stop restores visible input and cancels hidden guidance.
        session.restoreQueueToInput();
        await settled[1].promise;
        expect(findWorkspaceInConfig(config, childId)?.taskPendingGuidance).toBeUndefined();
        expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("awaiting_report");
        await streamEnd(taskService, {
          type: "stream-end",
          workspaceId: childId,
          messageId: "after-user-resume",
          metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
          parts: [{ type: "text", text: "Final response after resuming" }],
        });
        expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
      } finally {
        await session.dispose();
        await taskService.maybeStartQueuedTasks();
        await flushTerminalAttentionDrains(taskService);
      }
    }
  );

  test("initialize replays pending guidance even when the task has active descendants", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-restart-guidance-descendant";
    const childTaskId = "child-restart-guidance-descendant";
    const grandchildTaskId = "grandchild-restart-guidance";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskPendingGuidance: [
            {
              id: "guidance-blocked",
              message: "Apply this correction",
              queueDispatchMode: "turn-end",
            },
          ],
        }),
        projectWorkspace(projectPath, "grandchild", grandchildTaskId, {
          parentWorkspaceId: childTaskId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );

    const sendMessage = mock(
      async (
        _workspaceId: string,
        _message: string,
        _options: unknown,
        internal?: { onAccepted?: () => Promise<void> | void }
      ): Promise<Result<void>> => {
        await internal?.onAccepted?.();
        return Ok(undefined);
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();

    expect(sendMessage).toHaveBeenCalledWith(
      childTaskId,
      expect.stringContaining("Apply this correction"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPendingGuidance).toBeUndefined();
  });

  test.each(["running", "awaiting_report"] as const)(
    "startup skips tasks completed during earlier recovery (%s)",
    async (taskStatus) => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      await saveWorkspaces(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "parent", "parent"),
          ...["first", "later"].map((id) =>
            projectWorkspace(projectPath, id, id, {
              parentWorkspaceId: "parent",
              agentId: "exec",
              agentType: "exec",
              taskStatus,
              taskModelString: "openai:gpt-5.2",
            })
          ),
        ],
        testTaskSettings()
      );
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
        dispatchPendingCompactionFollowUp: mock(async () => {
          await config.editConfig((cfg) => {
            const later = cfg.projects
              .get(projectPath)
              ?.workspaces.find((workspace) => workspace.id === "later");
            if (later) later.taskStatus = "reported";
            return cfg;
          });
          return Ok(false);
        }),
      });
      const { taskService } = createTaskServiceHarness(config, { workspaceService });
      await taskService.recoverInterruptedTasks();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]?.[0]).toBe("first");
    }
  );

  test("startup recovery aborted by shutdown mid-run drains no queue and re-drives nothing", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", "parent"),
        projectWorkspace(projectPath, "child", "child", {
          parentWorkspaceId: "parent",
          agentId: "exec",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );
    const shutdown = new AbortController();
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      // Shutdown begins while recovery is still inspecting tasks (it outlived the startup bound).
      getStartupRecoveryState: mock(() => {
        shutdown.abort();
        return Promise.resolve("interrupted" as const);
      }),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const drainQueue = spyOn(taskService, "maybeStartQueuedTasks");

    await taskService.recoverInterruptedTasks({ signal: shutdown.signal });

    expect(drainQueue).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("startup does not recover a task that completed during blocker inspection", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const workspaces = [
      projectWorkspace(projectPath, "parent", "parent"),
      projectWorkspace(projectPath, "child", "child", {
        parentWorkspaceId: "parent",
        agentId: "exec",
        taskStatus: "running",
      }),
    ];
    await saveWorkspaces(config, projectPath, workspaces, testTaskSettings());
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      getStartupRecoveryState: mock(async () => {
        await saveWorkspaces(
          config,
          projectPath,
          [
            workspaces[0],
            {
              ...workspaces[1],
              taskStatus: "reported",
            },
          ],
          testTaskSettings()
        );
        return "interrupted" as const;
      }),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    await taskService.recoverInterruptedTasks();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, "child")?.taskStatus).toBe("reported");
  });

  test.each(["running", "awaiting_report", undefined] as const)(
    "startup preserves active status for indeterminate blockers (%s)",
    async (taskStatus) => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      await saveWorkspaces(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "parent", "parent"),
          ...["stopped", "failed-follow-up", "crashed", "compacted", "settled"].map((id) =>
            projectWorkspace(projectPath, id, id, {
              parentWorkspaceId: "parent",
              agentId: "exec",
              agentType: "exec",
              taskStatus,
              taskModelString: "openai:gpt-5.2",
            })
          ),
        ],
        testTaskSettings()
      );
      const dispatchPendingCompactionFollowUp = mock((id: string) =>
        Promise.resolve(
          id === "failed-follow-up" ? Err("unreadable follow-up") : Ok(id === "compacted")
        )
      );
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
        getStartupRecoveryState: mock((id: string) =>
          Promise.resolve(
            id === "stopped"
              ? ("blocked" as const)
              : id === "crashed"
                ? ("interrupted" as const)
                : ("idle" as const)
          )
        ),
        dispatchPendingCompactionFollowUp,
      });
      const { taskService } = createTaskServiceHarness(config, { workspaceService });
      await taskService.recoverInterruptedTasks();
      expect(sendMessage).toHaveBeenCalledTimes(taskStatus == null ? 1 : 2);
      expect(sendMessage.mock.calls[0]?.[0]).toBe("crashed");
      expect(findWorkspaceInConfig(config, "stopped")?.taskStatus).toBe(taskStatus);
      expect(dispatchPendingCompactionFollowUp).not.toHaveBeenCalledWith(
        "stopped",
        expect.anything()
      );
      expect(dispatchPendingCompactionFollowUp).toHaveBeenCalledWith(
        "compacted",
        expect.anything()
      );
    }
  );

  test.each([
    "stop",
    "opt-out",
    "question",
    "read-failure",
    "streaming",
    "preparing",
    "handle",
  ] as const)(
    "startup reclaims stopped capacity without disturbing other blockers (%s)",
    async (blocker) => {
      const config = await createTestConfig(rootDir);
      const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
      const pausedId = "paused-task";
      const queuedId = "queued-sibling";
      await config.editConfig((cfg) => {
        cfg.taskSettings = testTaskSettings(1, 3);
        cfg.projects.get(projectPath)!.workspaces.push(
          ...[pausedId, queuedId].map((id) => ({
            path: projectPath,
            id,
            name: id,
            parentWorkspaceId: parentId,
            agentId: "explore",
            agentType: "explore",
            taskIsolation: "none" as const,
            runtimeConfig: { type: "local" as const },
            taskStatus: id === pausedId ? ("running" as const) : ("queued" as const),
            taskPrompt: id === queuedId ? "Start the queued sibling" : undefined,
            taskModelString: defaultModel,
          }))
        );
        return cfg;
      });
      let queuedStreaming = false;
      const { aiService, stopStream } = createAIServiceMocks(config, {
        isStreaming: mock((id: string) =>
          id === queuedId ? queuedStreaming : id === pausedId && blocker === "streaming"
        ),
      });
      const sendMessage = mock((_id: string, _message: string, _options: unknown) => {
        queuedStreaming = true;
        return Promise.resolve(Ok(undefined));
      });
      const { workspaceService } = createWorkspaceServiceMocks({
        sendMessage,
        isBusyForMessage: mock((id: string) => id === pausedId && blocker === "preparing"),
      });
      const { taskService, historyService } = createTaskServiceHarness(config, {
        workspaceService,
        aiService,
      });
      await historyService.appendToHistory(
        pausedId,
        createMuxMessage("paused-user", "user", "Work until stopped")
      );
      await historyService.writePartial(
        pausedId,
        createMuxMessage("question", "assistant", "", {}, [
          {
            type: "dynamic-tool",
            state: "input-available",
            toolCallId: "question",
            toolName: "ask_user_question",
            input: { question: "Continue?" },
          },
        ])
      );
      if (blocker !== "question") {
        await fsPromises.writeFile(
          path.join(config.sessionsDir, pausedId, "auto-retry-preference.json"),
          JSON.stringify(
            blocker === "opt-out"
              ? { enabled: false }
              : { startupAutoRetryAbandon: { reason: "aborted", userMessageId: "paused-user" } }
          )
        );
      }
      const { session } = await createAgentSessionHarness({
        workspaceId: pausedId,
        config,
        historyService,
      });
      const stateProbe = mock((_id: string) => session.getStartupRecoveryState());
      workspaceService.getStartupRecoveryState = stateProbe;
      if (blocker === "read-failure") {
        spyOn(historyService, "readPartial").mockRejectedValue(new Error("unreadable"));
        spyOn(
          session as unknown as { waitForStartupReadRetry: () => Promise<void> },
          "waitForStartupReadRetry"
        ).mockResolvedValue(undefined);
      }
      const interruptedHandle = "wst_paused_capacity";
      if (blocker === "handle") {
        await registerLiveWorkspaceTurnHandle(
          taskService,
          pausedId,
          interruptedHandle,
          parentId,
          "reserved"
        );
      }
      try {
        expect(taskService.countActiveAgentTasks(config.loadConfigOrDefault())).toBe(1);
        await taskService.recoverInterruptedTasks();
        await taskService.maybeStartQueuedTasks();
        const stopped = ["stop", "opt-out", "handle"].includes(blocker);
        expect(findWorkspaceInConfig(config, pausedId)?.taskStatus).toBe(
          stopped ? "interrupted" : "running"
        );
        expect(findWorkspaceInConfig(config, queuedId)?.taskStatus).toBe(
          stopped ? "running" : "queued"
        );
        expect(taskService.countActiveAgentTasks(config.loadConfigOrDefault())).toBe(1);
        expect(stateProbe).not.toHaveBeenCalledWith(queuedId);
        expect(sendMessage).toHaveBeenCalledTimes(stopped ? 1 : 0);
        expect(stopStream).not.toHaveBeenCalledWith(queuedId, expect.anything());
        if (stopped) {
          expect(sendMessage.mock.calls[0]?.slice(0, 2)).toEqual([
            queuedId,
            "Start the queued sibling",
          ]);
          const result = await taskService
            .waitForAgentReport(pausedId, { timeoutMs: 1_000 })
            .catch((error: unknown) => error);
          expect(result).toBeInstanceOf(Error);
        }
        if (blocker === "handle") {
          expect(findWorkspaceInConfig(config, pausedId)?.taskExecutionStatus).toBe("interrupted");
          expect(
            await workspaceTurnSnapshot(taskService, parentId, interruptedHandle)
          ).toMatchObject({ status: "interrupted" });
          expect(
            workspaceTurnManagerFor(taskService).getLiveWorkspaceTurnRegistration(pausedId)
          ).toBeUndefined();
        }
      } finally {
        await session.dispose();
        await taskService.maybeStartQueuedTasks();
        await flushTerminalAttentionDrains(taskService);
      }
    }
  );

  test("startup settles every stopped tree before handle cleanup can launch queued descendants", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = testTaskSettings(2, 3);
      cfg.projects.get(projectPath)!.workspaces.push(
        ...["first", "second", "descendant", "sibling"].map((id) => ({
          path: projectPath,
          id,
          name: id,
          parentWorkspaceId: id === "descendant" ? "second" : parentId,
          agentId: "explore",
          agentType: "explore",
          taskIsolation: "none" as const,
          runtimeConfig: { type: "local" as const },
          taskStatus:
            id === "first" || id === "second" ? ("running" as const) : ("queued" as const),
          taskPrompt: id,
          taskModelString: defaultModel,
        }))
      );
      return cfg;
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      getStartupRecoveryState: mock(() => Promise.resolve("stopped")),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const prematureDrains: string[] = [];
    const scheduleDrain = taskService.scheduleMaybeStartQueuedTasks.bind(taskService);
    spyOn(taskService, "scheduleMaybeStartQueuedTasks").mockImplementation(() => {
      if (findWorkspaceInConfig(config, "second")?.taskStatus !== "interrupted") {
        prematureDrains.push("second still needs normalization");
      }
      scheduleDrain();
    });
    await registerLiveWorkspaceTurnHandle(
      taskService,
      "first",
      "wst_startup_batch",
      parentId,
      "reserved"
    );
    await taskService.recoverInterruptedTasks();
    await taskService.maybeStartQueuedTasks();
    expect(findWorkspaceInConfig(config, "first")?.taskStatus).toBe("interrupted");
    expect(findWorkspaceInConfig(config, "second")?.taskStatus).toBe("interrupted");
    expect(findWorkspaceInConfig(config, "descendant")?.taskStatus).toBe("interrupted");
    expect(findWorkspaceInConfig(config, "sibling")?.taskStatus).toBe("running");
    expect(prematureDrains).toHaveLength(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe("sibling");
  });

  test.each(["lifecycle-lock", "handle-read"] as const)(
    "startup contains a throwing %s stop normalization while healthy siblings proceed",
    async (fault) => {
      const config = await createTestConfig(rootDir);
      const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
      await config.editConfig((cfg) => {
        cfg.taskSettings = testTaskSettings(2, 3);
        cfg.projects.get(projectPath)!.workspaces.push(
          ...["unreadable", "healthy", "queued"].map((id) => ({
            id,
            path: projectPath,
            name: id,
            parentWorkspaceId: parentId,
            taskStatus: id === "queued" ? ("queued" as const) : ("running" as const),
            taskIsolation: "none" as const,
            runtimeConfig: { type: "local" as const },
            agentId: "explore",
            agentType: "explore",
            taskModelString: defaultModel,
            taskPrompt: id === "queued" ? "Continue healthy work" : undefined,
          }))
        );
        return cfg;
      });
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
        getStartupRecoveryState: mock(() => Promise.resolve("stopped")),
      });
      const { taskService } = createTaskServiceHarness(config, { workspaceService });
      if (fault === "lifecycle-lock") {
        spyOn(taskService, "withTaskTreeLifecycleLock").mockRejectedValueOnce(
          new Error("Lock unavailable")
        );
      } else {
        spyOn(workspaceTurnManagerFor(taskService), "listAllWorkspaceTurns").mockRejectedValueOnce(
          new Error("Handle directory EIO")
        );
      }
      await taskService.recoverInterruptedTasks();
      await taskService.maybeStartQueuedTasks();
      expect(findWorkspaceInConfig(config, "unreadable")?.taskStatus).toBe("running");
      expect(findWorkspaceInConfig(config, "healthy")?.taskStatus).toBe("interrupted");
      expect(findWorkspaceInConfig(config, "queued")?.taskStatus).toBe("running");
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]?.[0]).toBe("queued");
    }
  );

  test.each([false, true])(
    "stopping cancels captured durable guidance before reactivation (later=%s)",
    async (later) => {
      const config = await createTestConfig(rootDir);
      const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
      const childId = "stopped-guidance";
      const oldGuidance = {
        id: "old",
        message: "Old correction",
        queueDispatchMode: "tool-end" as const,
      };
      const newGuidance = {
        id: "new",
        message: "Later correction",
        queueDispatchMode: "turn-end" as const,
      };
      await config.editConfig((cfg) => {
        cfg.projects.get(projectPath)!.workspaces.push({
          id: childId,
          path: projectPath,
          name: childId,
          parentWorkspaceId: parentId,
          taskStatus: "running",
          taskIsolation: "none",
          runtimeConfig: { type: "local" },
          agentId: "explore",
          agentType: "explore",
          taskModelString: defaultModel,
          taskPendingGuidance: [oldGuidance],
        });
        return cfg;
      });
      const sendMessage = mock(async (...args: Parameters<WorkspaceHost["sendMessage"]>) => {
        await args[3]?.onAccepted?.();
        return Ok(undefined);
      });
      const { workspaceService } = createWorkspaceServiceMocks({
        sendMessage,
        getStartupRecoveryState: mock(() => Promise.resolve("stopped")),
      });
      const { taskService } = createTaskServiceHarness(config, { workspaceService });
      const manager = workspaceTurnManagerFor(taskService);
      if (later) {
        await registerLiveWorkspaceTurnHandle(
          taskService,
          childId,
          "wst_canceled_guidance",
          parentId,
          "reserved"
        );
        const interrupt = manager.interruptWorkspaceTurn.bind(manager);
        spyOn(manager, "interruptWorkspaceTurn").mockImplementationOnce(async (...args) => {
          // A concurrent writer after stop's capture horizon must not lose its fresh GUID.
          await config.editConfig((cfg) => {
            const ws = cfg.projects.get(projectPath)!.workspaces.find((ws) => ws.id === childId)!;
            (ws.taskPendingGuidance ??= []).push(newGuidance);
            return cfg;
          });
          return interrupt(...args);
        });
      }
      await taskService.recoverInterruptedTasks();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("interrupted");
      if (later) {
        expect(findWorkspaceInConfig(config, childId)?.taskPendingGuidance).toEqual([newGuidance]);
        return;
      }
      expect(findWorkspaceInConfig(config, childId)?.taskPendingGuidance).toBeUndefined();
      // A user resume admits the existing child again; canceled orchestration must not block it.
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      const resumed = await taskService.sendMessageToDescendantAgentTask(
        parentId,
        childId,
        "Finish the new request",
        "turn-end"
      );
      expect(resumed).toMatchObject({ success: true, data: { delivery: "accepted" } });
      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: childId,
        messageId: "fresh-final",
        metadata: {
          model: defaultModel,
          finishReason: "stop",
        },
        parts: [{ type: "text", text: "Finished the new request" }],
      });
      expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
      await taskService.maybeStartQueuedTasks();
      await flushTerminalAttentionDrains(taskService);
    }
  );

  test("initialize does not resend the restart nudge to a running task that is already streaming", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-restart-streaming";
    const streamingTaskId = "child-running-streaming";
    const idleTaskId = "child-running-idle";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "streaming", streamingTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
        }),
        projectWorkspace(projectPath, "idle", idleTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );

    // The queue drain can leave a task streaming before the running-task pass reaches it.
    const isStreaming = mock((workspaceId: string) => workspaceId === streamingTaskId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();

    const messagedWorkspaceIds = (
      sendMessage as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.map((call) => call[0]);
    expect(messagedWorkspaceIds).toContain(idleTaskId);
    expect(messagedWorkspaceIds).not.toContain(streamingTaskId);
  });

  test("recovery does not re-drive a running task whose accepted turn is still preparing", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-restart-preparing";
    const preparingTaskId = "child-running-preparing";
    const idleTaskId = "child-running-idle";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "preparing", preparingTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
        }),
        projectWorkspace(projectPath, "idle", idleTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );

    // An earlier pass's background nudge is accepted but not yet streaming: the session is busy.
    const isBusyForMessage = mock((workspaceId: string) => workspaceId === preparingTaskId);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ isBusyForMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const attemptBefore = findWorkspaceInConfig(config, preparingTaskId)?.taskAttemptId;

    await taskService.recoverInterruptedTasks();

    const messagedWorkspaceIds = (
      sendMessage as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.map((call) => call[0]);
    expect(messagedWorkspaceIds).toContain(idleTaskId);
    expect(messagedWorkspaceIds).not.toContain(preparingTaskId);
    // Rotating would hand the preparing turn's result to a superseded attempt.
    expect(findWorkspaceInConfig(config, preparingTaskId)?.taskAttemptId).toBe(attemptBefore);
  });

  test("recovery does not re-drive an awaiting_report task whose accepted turn is still preparing", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-awaiting-preparing";
    const preparingTaskId = "child-awaiting-preparing";
    const idleTaskId = "child-awaiting-idle";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        ...[preparingTaskId, idleTaskId].map((taskId) =>
          projectWorkspace(projectPath, taskId, taskId, {
            parentWorkspaceId,
            agentId: "exec",
            agentType: "exec",
            taskStatus: "awaiting_report",
            taskModelString: "openai:gpt-5.2",
          })
        ),
      ],
      testTaskSettings()
    );

    // An earlier pass's background completion prompt is accepted but not yet streaming.
    const isBusyForMessage = mock((workspaceId: string) => workspaceId === preparingTaskId);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ isBusyForMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const before = findWorkspaceInConfig(config, preparingTaskId);

    await taskService.recoverInterruptedTasks();

    const messagedWorkspaceIds = (
      sendMessage as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.map((call) => call[0]);
    expect(messagedWorkspaceIds).toContain(idleTaskId);
    expect(messagedWorkspaceIds).not.toContain(preparingTaskId);
    const after = findWorkspaceInConfig(config, preparingTaskId);
    expect(after?.taskAttemptId).toBe(before?.taskAttemptId);
    expect(after?.taskRecoveryAttempts).toBe(before?.taskRecoveryAttempts);
  });

  test("startup phases stay partitioned: recovery resumes tasks, housekeeping prunes reported ones", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-startup-phases";
    const runningTaskId = "child-running-phases";
    const reportedTaskId = "child-reported-phases";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "running", runningTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
        }),
        projectWorkspace(projectPath, "reported", reportedTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          taskModelString: "openai:gpt-5.2",
          workflowTask: { runId: "wfr_startup_phases", stepId: "explore" },
        }),
      ],
      testTaskSettings()
    );

    const remove = createConfigBackedRemoveMock(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    // The listener-gating phase only touches active tasks: no O(reported tasks) cleanup here.
    await taskService.recoverInterruptedTasks();
    const messagedWorkspaceIds = (
      sendMessage as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.map((call) => call[0]);
    expect(messagedWorkspaceIds).toEqual([runningTaskId]);
    expect(remove).not.toHaveBeenCalled();

    // The background phase never resumes tasks (clients may be acting on them by now).
    await taskService.runStartupHousekeeping();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls.map((call) => call[0])).toEqual([reportedTaskId]);
    expect(findWorkspaceInConfig(config, reportedTaskId)).toBeUndefined();
  });

  test("startup leaves archived reported tasks untouched and recovers them on unarchive", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-archive-recovery";
    const childId = "child-archive-recovery";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "reported",
          archivedAt: "2026-08-10T00:00:00.000Z",
          workflowTask: { runId: "wfr_archive_recovery", stepId: "exec" },
        }),
      ],
      testTaskSettings()
    );
    const { taskService, historyService } = createTaskServiceHarness(config);
    const internal = taskService as unknown as {
      gitPatchArtifactService: { maybeStartGeneration: (...args: unknown[]) => Promise<void> };
    };
    const generation = spyOn(
      internal.gitPatchArtifactService,
      "maybeStartGeneration"
    ).mockResolvedValue();
    const artifactRead = spyOn(subagentGitPatchArtifacts, "readSubagentGitPatchArtifact");
    const partialRead = spyOn(historyService, "readPartial");
    try {
      await taskService.runStartupHousekeeping();
      expect(generation).not.toHaveBeenCalled();
      expect(artifactRead).not.toHaveBeenCalled();
      expect(partialRead).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childId)).toBeDefined();
      await config.editConfig((cfg) => {
        const child = cfg.projects.get(projectPath)?.workspaces.find((ws) => ws.id === childId);
        if (child) child.unarchivedAt = "2026-08-11T00:00:00.000Z";
        return cfg;
      });
      await taskService.noteWorkspaceUnarchived(childId);
      expect(generation).toHaveBeenCalledWith(parentId, childId, expect.any(Function), undefined);
    } finally {
      generation.mockRestore();
      artifactRead.mockRestore();
      partialRead.mockRestore();
    }
  });

  test("startup batches settled artifacts and recovers pending or missing patches", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-settled-patches";
    const children = ["settled-first", "settled-second", "pending-patch", "missing-patch"].map(
      (id) =>
        projectWorkspace(projectPath, id, id, {
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "reported",
        })
    );
    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "parent", parentId), ...children],
      testTaskSettings()
    );
    for (const child of children.filter((child) => child.id !== "missing-patch")) {
      await upsertSubagentGitPatchArtifact({
        workspaceId: parentId,
        workspaceSessionDir: path.join(config.sessionsDir, parentId),
        childTaskId: child.id!,
        updater: () => ({
          childTaskId: child.id!,
          parentWorkspaceId: parentId,
          createdAtMs: 1,
          status: child.id === "pending-patch" ? "pending" : "ready",
          projectArtifacts: [
            {
              projectPath,
              projectName: "repo",
              storageKey: "repo",
              status: child.id === "pending-patch" ? "pending" : "ready",
            },
          ],
          readyProjectCount: 0,
          failedProjectCount: 0,
          skippedProjectCount: 0,
          totalCommitCount: 0,
        }),
      });
    }
    const { taskService } = createTaskServiceHarness(config);
    const internal = taskService as unknown as {
      gitPatchArtifactService: { maybeStartGeneration: (...args: unknown[]) => Promise<void> };
    };
    const generation = spyOn(
      internal.gitPatchArtifactService,
      "maybeStartGeneration"
    ).mockResolvedValue();
    const artifactRead = spyOn(subagentGitPatchArtifacts, "readSubagentGitPatchArtifactsFile");
    try {
      await taskService.runStartupHousekeeping();
      expect(generation.mock.calls.map((call) => call[1])).toEqual([
        "pending-patch",
        "missing-patch",
      ]);
      expect(artifactRead).toHaveBeenCalledTimes(1);
    } finally {
      generation.mockRestore();
      artifactRead.mockRestore();
    }
  });

  test("initialize does not reload config.json per completed-report task", async () => {
    const countConfigLoadsDuringInitialize = async (reportedTaskCount: number): Promise<number> => {
      const runRootDir = path.join(rootDir, `run-${reportedTaskCount}`);
      const config = await createTestConfig(runRootDir);
      const projectPath = path.join(runRootDir, "repo");
      const parentWorkspaceId = "parent-reload";
      const reportedTasks = Array.from({ length: reportedTaskCount }, (_unused, index) =>
        projectWorkspace(projectPath, `reported-${index}`, `child-reported-${index}`, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          taskModelString: "openai:gpt-5.2",
        })
      );
      await saveWorkspaces(
        config,
        projectPath,
        [projectWorkspace(projectPath, "parent", parentWorkspaceId), ...reportedTasks],
        testTaskSettings()
      );
      const { taskService } = createTaskServiceHarness(config);
      const loadConfigSpy = spyOn(config, "loadConfigOrDefault");
      try {
        await taskService.initialize();
        return loadConfigSpy.mock.calls.length;
      } finally {
        loadConfigSpy.mockRestore();
      }
    };

    const loadsWithTwoTasks = await countConfigLoadsDuringInitialize(2);
    const loadsWithSixTasks = await countConfigLoadsDuringInitialize(6);
    expect(loadsWithSixTasks).toBe(loadsWithTwoTasks);
  });

  test("startup cleanup confirms a snapshot-eligible task on fresh config before removing it", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-cleanup-live";
    const reactivatedTaskId = "child-workflow-reactivated";
    const turnStartingTaskId = "child-workflow-turn-starting";
    const staleTaskId = "child-workflow-stale";
    const workflowTask = (stepId: string) => ({
      parentWorkspaceId,
      agentId: "exec",
      agentType: "exec",
      taskStatus: "reported" as const,
      reportedAt: "2026-08-10T00:00:00.000Z",
      taskModelString: "openai:gpt-5.2",
      workflowTask: { runId: "wfr_cleanup_live", stepId },
    });

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "reactivated", reactivatedTaskId, workflowTask("a")),
        projectWorkspace(projectPath, "turn-starting", turnStartingTaskId, workflowTask("c")),
        projectWorkspace(projectPath, "stale", staleTaskId, workflowTask("b")),
      ],
      testTaskSettings()
    );
    const snapshot = config.loadConfigOrDefault();
    // After the startup snapshot, a client reactivated one child, and another got an
    // existing-workspace turn whose execution mirror is starting before any stream registers
    // (taskStatus stays "reported" on that path).
    await config.editConfig((cfg) => {
      const workspaces = cfg.projects.get(projectPath)?.workspaces ?? [];
      const reactivated = workspaces.find((workspace) => workspace.id === reactivatedTaskId);
      if (reactivated) {
        reactivated.taskStatus = "running";
        reactivated.reportedAt = undefined;
      }
      const turnStarting = workspaces.find((workspace) => workspace.id === turnStartingTaskId);
      if (turnStarting) {
        turnStarting.taskExecutionId = "wst_turn_starting";
        turnStarting.taskExecutionStatus = "starting";
      }
      return cfg;
    });

    const { workspaceService } = createWorkspaceServiceMocks({
      remove: createConfigBackedRemoveMock(config),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internals = taskService as unknown as {
      cleanupReportedLeafTask: (
        workspaceId: string,
        options?: { config?: ProjectsConfig }
      ) => Promise<number>;
    };

    expect(await internals.cleanupReportedLeafTask(reactivatedTaskId, { config: snapshot })).toBe(
      0
    );
    expect(await internals.cleanupReportedLeafTask(turnStartingTaskId, { config: snapshot })).toBe(
      0
    );
    expect(await internals.cleanupReportedLeafTask(staleTaskId, { config: snapshot })).toBe(1);
    expect(findWorkspaceInConfig(config, reactivatedTaskId)?.taskStatus).toBe("running");
    expect(findWorkspaceInConfig(config, turnStartingTaskId)?.taskExecutionStatus).toBe("starting");
    expect(findWorkspaceInConfig(config, staleTaskId)).toBeUndefined();
  });

  test("startup cleanup continues from the parent the live confirmation saw after a re-parent", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "parent-cleanup-reparent-root";
    const oldParentId = "child-workflow-reparent-old-parent";
    const newParentId = "child-workflow-reparent-new-parent";
    const leafTaskId = "child-workflow-reparent-leaf";
    const workflowTask = (stepId: string, parentWorkspaceId: string) => ({
      parentWorkspaceId,
      agentId: "exec",
      agentType: "exec",
      taskStatus: "reported" as const,
      reportedAt: "2026-08-10T00:00:00.000Z",
      taskModelString: "openai:gpt-5.2",
      workflowTask: { runId: "wfr_cleanup_reparent", stepId },
    });

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(
          projectPath,
          "old-parent",
          oldParentId,
          workflowTask("old", rootWorkspaceId)
        ),
        projectWorkspace(
          projectPath,
          "new-parent",
          newParentId,
          workflowTask("new", rootWorkspaceId)
        ),
        projectWorkspace(projectPath, "leaf", leafTaskId, workflowTask("leaf", oldParentId)),
      ],
      testTaskSettings()
    );
    const snapshot = config.loadConfigOrDefault();

    // A client re-parents the leaf after the snapshot screen, before remove() takes the lifecycle
    // lock; the live confirmation inside remove() sees the new parent.
    const remove = mock(
      async (
        workspaceId: string,
        _force?: boolean,
        options?: { beforeRemove?: () => Promise<boolean> }
      ): Promise<Result<void>> => {
        if (workspaceId === leafTaskId) {
          await config.editConfig((cfg) => {
            const leaf = cfg.projects
              .get(projectPath)
              ?.workspaces.find((workspace) => workspace.id === leafTaskId);
            if (leaf) leaf.parentWorkspaceId = newParentId;
            return cfg;
          });
        }
        if (options?.beforeRemove != null && !(await options.beforeRemove())) {
          return Ok(undefined);
        }
        await removeWorkspaceFromTestConfig(config, workspaceId);
        return Ok(undefined);
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internals = taskService as unknown as {
      cleanupReportedLeafTask: (
        workspaceId: string,
        options?: { config?: ProjectsConfig }
      ) => Promise<number>;
    };

    // Removing the leaf makes its live parent a structural leaf, so cleanup prunes that one
    // next; the former parent had nothing removed under it and stays.
    expect(await internals.cleanupReportedLeafTask(leafTaskId, { config: snapshot })).toBe(2);
    expect(findWorkspaceInConfig(config, leafTaskId)).toBeUndefined();
    expect(findWorkspaceInConfig(config, newParentId)).toBeUndefined();
    expect(findWorkspaceInConfig(config, oldParentId)).toBeDefined();
  });

  test("reported-task cleanup and task_send_message never deadlock on the event and task-tree locks", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-cleanup-send-lock-order";
    const childTaskId = "child-cleanup-send-lock-order";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          taskModelString: "openai:gpt-5.2",
          workflowTask: { runId: "wfr_cleanup_send_lock_order", stepId: "explore" },
        }),
      ],
      testTaskSettings()
    );

    // Mirror WorkspaceService.remove(): confirm and delete under the task-tree lifecycle lock.
    // Hold the call open between cleanup taking the child's event lock and remove() taking the
    // tree lock, so the send can be parked on its own lock acquisition inside that window.
    let releaseRemove!: () => void;
    const removeGate = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    let removeEntered!: () => void;
    const removeStarted = new Promise<void>((resolve) => {
      removeEntered = resolve;
    });
    const remove = mock(
      async (
        workspaceId: string,
        _force?: boolean,
        options?: { beforeRemove?: () => Promise<boolean> }
      ): Promise<Result<void>> => {
        removeEntered();
        await removeGate;
        return await taskService.withTaskTreeLifecycleLock(workspaceId, async () => {
          if (options?.beforeRemove != null && !(await options.beforeRemove())) {
            return Ok(undefined);
          }
          await removeWorkspaceFromTestConfig(config, workspaceId);
          return Ok(undefined);
        });
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internals = taskService as unknown as {
      requestReportedTaskCleanupRecheck: (workspaceId: string) => Promise<void>;
    };

    const cleanup = internals.requestReportedTaskCleanupRecheck(childTaskId);
    await removeStarted;
    const send = taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "steer the reported child",
      "tool-end"
    );
    // One macrotask turn: the send's pre-lock section is microtask-only, so by now it is parked
    // on its first lock acquisition while cleanup still holds the child's event lock.
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseRemove();

    let deadlockTimer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      Promise.all([cleanup, send]).then(() => "settled" as const),
      new Promise<"deadlocked">((resolve) => {
        deadlockTimer = setTimeout(() => resolve("deadlocked"), 5_000);
      }),
    ]);
    clearTimeout(deadlockTimer);
    expect(outcome).toBe("settled");
    expect(await send).toEqual(Err({ code: "not_found" }));
    expect(findWorkspaceInConfig(config, childTaskId)).toBeUndefined();
  }, 10_000);

  test("bare compaction stream-end resumes the pre-compaction parent identity", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-bare-compaction";
    const childId = "child-bare-compaction";
    const execModel = "openai:gpt-5.6-sol";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId, {
          aiSettingsByAgent: {
            exec: { model: execModel, thinkingLevel: "high" },
          },
        }),
        projectWorkspace(projectPath, "child", childId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const waitForPendingCompactionCompletionDecision = mock(
      (): Promise<boolean> => Promise.resolve(false)
    );
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      waitForPendingCompactionCompletionDecision,
    });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("pre-compact-exec", "assistant", "Waiting for delegated work", {
        timestamp: Date.now(),
        agentId: "exec",
      })
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("bare-compact-output", "assistant", "Compaction summary", {
        timestamp: Date.now(),
        agentId: "compact",
      })
    );

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: parentId,
      messageId: "bare-compact-output",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        agentId: "compact",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Compaction summary" }],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      parentId,
      expect.any(String),
      expect.objectContaining({
        agentId: "exec",
        model: execModel,
        thinkingLevel: "high",
      }),
      expect.any(Object)
    );
  });

  test("compaction stream-end does not advance a running persistent child toward recovery", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-child-compaction";
    const childTaskId = "child-compaction";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );
    const waitForPendingCompactionCompletionDecision = mock(
      (_workspaceId: string, messageId: string): Promise<boolean> =>
        Promise.resolve(
          messageId === "child-compaction-agent-id" || messageId === "child-compaction-mode"
        )
    );
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      waitForPendingCompactionCompletionDecision,
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "child-compaction-agent-id",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        agentId: "compact",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Compacted child context" }],
    });
    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "child-compaction-mode",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        mode: "compact",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Compacted child context" }],
    });

    const child = findWorkspaceInConfig(config, childTaskId);
    expect(child?.taskStatus).toBe("running");
    expect(child?.taskRecoveryAttempts).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();

    await config.editConfig((cfg) => {
      const child = cfg.projects
        .get(projectPath)
        ?.workspaces.find((workspace) => workspace.id === childTaskId);
      assert(child, "child workspace must exist");
      child.taskStatus = "awaiting_report";
      return cfg;
    });
    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "standalone-child-compaction",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        agentId: "compact",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Standalone compacted child context" }],
    });

    expect(findWorkspaceInConfig(config, childTaskId)).toMatchObject({
      taskStatus: "awaiting_report",
      taskRecoveryAttempts: 1,
    });

    await config.editConfig((cfg) => {
      const child = cfg.projects
        .get(projectPath)
        ?.workspaces.find((workspace) => workspace.id === childTaskId);
      assert(child, "child workspace must exist");
      delete child.taskRecoveryAttempts;
      return cfg;
    });
    sendMessage.mockClear();
    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "failed-child-compaction",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        agentId: "compact",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Rejected compacted child context" }],
    });

    expect(findWorkspaceInConfig(config, childTaskId)?.taskRecoveryAttempts).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
