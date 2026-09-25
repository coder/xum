import { describe, expect, test, mock, spyOn } from "bun:test";
import { CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE } from "./agentSession";
import { existsSync } from "fs";
import * as fsPromises from "fs/promises";
import path from "path";
import { Err, Ok } from "@/common/types/result";
import { createTestHistoryService } from "./testHistoryService";
import type { InitStateManager } from "./initStateManager";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { createMuxMessage } from "@/common/types/message";
import {
  WORKFLOW_RESULT_METADATA_TYPE,
  WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE,
  WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE,
  buildWorkflowResultContextMessage,
} from "@/common/utils/workflowRunMessages";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import {
  mockInitStateManager,
  createMockAIService,
  createWorkspaceServiceForTest,
} from "./workspaceService.testHarness";

describe("WorkspaceService workflow invocation events", () => {
  test("emits workflow slash invocation rows through the active session chat stream", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-live-events";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-live-events",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });
      const session = workspaceService.getOrCreateSession(workspaceId);
      const events: WorkspaceChatMessage[] = [];
      const unsubscribe = session.onChatEvent(({ message }) => {
        events.push(message);
      });

      try {
        const persisted = await workspaceService.appendWorkflowRunInvocation({
          workspaceId,
          rawCommand: "/demo investigate live events",
          scriptPath: "./workflows/demo.js",
          args: { input: "investigate live events" },
          runId: "wfr_live_events",
          status: "running",
          result: null,
        });

        expect(persisted).toBe(true);
        expect(events).toHaveLength(2);
        const triggerMessage = events[0];
        const cardMessage = events[1];
        if (triggerMessage?.type !== "message" || cardMessage?.type !== "message") {
          throw new Error("Expected workflow invocation to emit message events");
        }
        expect(triggerMessage).toMatchObject({ role: "user", type: "message" });
        expect(triggerMessage.metadata?.muxMetadata).toEqual(
          expect.objectContaining({ type: WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE })
        );
        expect(cardMessage).toMatchObject({ role: "assistant", type: "message" });
        expect(cardMessage.metadata?.muxMetadata).toEqual(
          expect.objectContaining({ type: WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE })
        );
      } finally {
        unsubscribe();
        await workspaceService.disposeSession(workspaceId);
      }
    } finally {
      await cleanup();
    }
  });

  test("keeps workflow invocations current across synthetic user continuations", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness";
    const runId = "wfr_currentness";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("synthetic-await", "user", "Call task_await", {
          timestamp: 1_100,
          synthetic: true,
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "Never mind, answer something else", {
          timestamp: 1_200,
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("counts workflow_resume output as the current invocation after manual supersession", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-resume";
    const runId = "wfr_currentness_resume";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-resume",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "Never mind, answer something else", {
          timestamp: 1_100,
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      // An unrelated tool output mentioning the run does not re-establish the invocation.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-unrelated-tool", "assistant", "", { timestamp: 1_200 }, [
          {
            type: "dynamic-tool",
            toolCallId: "task-list-1",
            toolName: "task_list",
            state: "output-available",
            input: {},
            output: { status: "running", runId, result: null },
          },
        ])
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      // workflow_resume re-attaches the agent to the run, so the invocation counts as current
      // again and the terminal continuation would be delivered.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-resume", "assistant", "", { timestamp: 1_300 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-resume-1",
            toolName: "workflow_resume",
            state: "output-available",
            input: { run_id: runId, mode: "resume", run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("counts a kernel-launched run recorded in the sidecar as the current invocation", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-kernel";
    const runId = "wfr_currentness_kernel";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-kernel",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      // mux.workflow_run inside code_execution leaves no workflow_run tool part in history; the
      // agent-workflow-runs sidecar reference is the only durable invocation evidence.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "run the audit workflow", { timestamp: 1_000 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-kernel-launch", "assistant", "", { timestamp: 1_100 }, [
          {
            type: "dynamic-tool",
            toolCallId: "code-exec-1",
            toolName: "code_execution",
            state: "output-available",
            input: { code: "return xum.workflow_run({ script_path: './workflows/demo.js' })" },
            output: { success: true, result: { status: "running", runId } },
          },
        ])
      );

      // The nested runId in the code_execution output alone is not invocation evidence.
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: "manual-user",
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      // A newer manual user message supersedes the sidecar reference.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user-2", "user", "never mind, answer something else", {
          timestamp: 1_200,
        })
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      // A kernel workflow_resume re-records the reference after the supersession and
      // re-establishes provenance (latest record wins).
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_250,
        afterBoundaryMessageId: "manual-user-2",
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      // Once the terminal result was delivered, the sidecar must not resurrect the invocation.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("workflow-result", "user", "The workflow below has finished.", {
          timestamp: 1_300,
          synthetic: true,
          muxMetadata: {
            type: WORKFLOW_RESULT_METADATA_TYPE,
            rawCommand: "workflow_run ./workflows/demo.js",
            runId,
          },
        })
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      // A kernel background resume issued after the delivered result re-records the reference,
      // so the retried run's next terminal wake must count as current again.
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_350,
        afterBoundaryMessageId: "workflow-result",
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("does not treat sidecar references as current after a full history clear", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-cleared";
    const runId = "wfr_currentness_cleared";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-cleared",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      // A full clear (truncateHistory) removes every row without appending a reset boundary
      // and leaves the sidecar intact; the surviving reference must not inject a workflow
      // result into the freshly cleared conversation.
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: "manual-user",
      });

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("delivers kernel launches recorded against a decision-free history", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-empty";
    const runId = "wfr_currentness_empty";
    const legacyRunId = "wfr_currentness_empty_legacy";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-empty",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      // A kernel launch from a synthetic turn in a new (or fully cleared) workspace records a
      // verified-empty snapshot (null). History still having no decision row means the launch
      // context is unchanged, so the wake must deliver.
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      // A reference without a verified snapshot cannot claim the empty history as its launch
      // context; it may merely have survived a full clear.
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId: legacyRunId,
        createdAtMs: 1_150,
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, legacyRunId)).toBe(
        false
      );

      // A decision row appearing after the launch supersedes the verified-empty snapshot.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "never mind, answer something else", {
          timestamp: 1_200,
        })
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("retires kernel workflow run references on a full history clear", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-retire";
    const runId = "wfr_currentness_retire";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-retire",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      // Launched from a decision-free history: the verified-empty snapshot delivers.
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "never mind, answer something else", {
          timestamp: 1_200,
        })
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      // A full clear returns history to decision-free, making the pre-clear null snapshot
      // indistinguishable from a fresh empty-history launch; the clear must retire the
      // reference so the stale result cannot inject into the fresh conversation.
      const clearResult = await workspaceService.truncateHistory(workspaceId, 1.0);
      expect(clearResult.success).toBe(true);
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("retires kernel workflow run references even when a later post-clear step fails", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-retire-early";
    const runId = "wfr_currentness_retire_early";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-retire-early",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "never mind, answer something else", {
          timestamp: 1_200,
        })
      );

      // The truncation commits, then a later post-clear step fails. Retirement must already
      // have happened, or the stale null-snapshot reference survives the committed clear and
      // reads current against the emptied history.
      const sessionAccessor = workspaceService as unknown as {
        getOrCreateSession(id: string): { clearPostCompactionState(): Promise<void> };
      };
      const session = sessionAccessor.getOrCreateSession(workspaceId);
      const carryoverSpy = spyOn(session, "clearPostCompactionState").mockImplementationOnce(() =>
        Promise.reject(new Error("carryover discard failed"))
      );
      try {
        const clearResult = await workspaceService.truncateHistory(workspaceId, 1.0);
        expect(clearResult.success).toBe(false);
      } finally {
        carryoverSpy.mockRestore();
      }
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a failed reference retirement aborts the clear before truncation", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-retire-abort";
    const runId = "wfr_currentness_retire_abort";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-retire-abort",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "never mind, answer something else", {
          timestamp: 1_200,
        })
      );

      // Retirement failing after a committed truncation would leave the null-snapshot
      // reference reading current against the emptied history (pre-clear output injected
      // into the fresh conversation), so the clear must abort with the transcript intact.
      const truncateSpy = spyOn(historyService, "truncateHistory");
      const internal = workspaceService as unknown as {
        retireKernelWorkflowRunReferences(id: string): Promise<void>;
      };
      const retireSpy = spyOn(internal, "retireKernelWorkflowRunReferences")
        // Lazy rejection: an eager mockRejectedValueOnce promise trips bun's
        // unhandled-rejection detector on this host before the clear consumes it.
        .mockImplementationOnce(() => Promise.reject(new Error("read-only session storage")));
      try {
        const clearResult = await workspaceService.truncateHistory(workspaceId, 1.0);
        expect(clearResult.success).toBe(false);
        if (!clearResult.success) {
          expect(clearResult.error).toContain("could not be retired");
        }
        expect(truncateSpy).not.toHaveBeenCalled();
      } finally {
        retireSpy.mockRestore();
        truncateSpy.mockRestore();
      }

      // A retry once storage recovers clears normally and retires the sidecar.
      const retryResult = await workspaceService.truncateHistory(workspaceId, 1.0);
      expect(retryResult.success).toBe(true);
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a partial truncation that empties history retires kernel workflow references", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-partial-empty";
    const runId = "wfr_currentness_partial_empty";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-partial-empty",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "single short message", { timestamp: 1_200 })
      );

      // Half of a single-message transcript crosses the whole-history removal budget, so the
      // token-proportional truncation takes historyService's full-delete fast path. The
      // emptied transcript must retire the null-snapshot reference exactly like an explicit
      // clear, or the pre-truncation workflow result would read current against the emptied
      // decision-free history.
      const truncateResult = await workspaceService.truncateHistory(workspaceId, 0.5);
      expect(truncateResult.success).toBe(true);
      expect(await historyService.getHistoryFromLatestBoundary(workspaceId)).toEqual(Ok([]));
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("an overlapping truncation that would empty history is refused, not silently cleared", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-preflight-race";
    const runId = "wfr_currentness_preflight_race";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-preflight-race",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "single short message", { timestamp: 1_200 })
      );

      // Simulate the preflight racing an overlapping truncation: it classifies this request
      // as non-emptying, but the locked rewrite's own recomputation would empty history. The
      // serialized revalidation must refuse rather than skip the full-clear guards.
      const preflightSpy = spyOn(
        historyService,
        "classifyTruncationRemoval"
      ).mockImplementationOnce(() => Promise.resolve("partial" as const));
      try {
        const result = await workspaceService.truncateHistory(workspaceId, 0.5);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("full clear");
        }
      } finally {
        preflightSpy.mockRestore();
      }
      // The transcript is intact; the reference was already retired before the refused
      // rewrite (retirement precedes every row-removing truncation), which is the fail-safe
      // direction: a dropped wake, with the result still retrievable via resume.
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(1);
      }
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("an unreadable truncation scope preflight refuses instead of applying full-clear effects", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-preflight-refuse";
    const runId = "wfr_currentness_preflight_refuse";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-preflight-refuse",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "single short message", { timestamp: 1_200 })
      );

      // A transiently unreadable preflight must refuse: an unknown scope labeled "all" would
      // apply full-clear side effects while a prefix removal can leave rows behind.
      const preflightSpy = spyOn(historyService, "classifyTruncationRemoval").mockRejectedValueOnce(
        new Error("EIO: history unreadable")
      );
      try {
        const result = await workspaceService.truncateHistory(workspaceId, 0.5);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("classify");
        }
      } finally {
        preflightSpy.mockRestore();
      }
      // Lossless refusal: the transcript is intact and the kernel workflow reference survives
      // for the retry (no wake was settled superseded by a truncation that never happened).
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(1);
      }
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(true);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a full-clear-classified truncation that would leave rows is refused under the history lock", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-all-drift-refuse";
    const runId = "wfr_currentness_all_drift_refuse";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-all-drift-refuse",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      for (let i = 0; i < 6; i++) {
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`manual-user-${i}`, "user", `padding message ${i}`, {
            timestamp: 1_200 + i,
          })
        );
      }

      // Simulate rows appended during the unserialized preflight (e.g. a turn completing
      // before the admission guard is acquired): it classified this request as emptying, but
      // the locked rewrite's recomputation removes only a prefix. The serialized revalidation
      // must refuse rather than apply full-clear side effects (context epoch advance,
      // goal/plan/retry discards) while rows remain.
      const preflightSpy = spyOn(
        historyService,
        "classifyTruncationRemoval"
      ).mockImplementationOnce(() => Promise.resolve("all" as const));
      try {
        const result = await workspaceService.truncateHistory(workspaceId, 0.5);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("leave messages");
        }
      } finally {
        preflightSpy.mockRestore();
      }
      // The transcript is intact; the reference was already retired before the refused
      // rewrite (retirement precedes every row-removing truncation), which is the fail-safe
      // direction: a dropped wake, with the result still retrievable via resume.
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(6);
      }
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("the admission guard is held across the truncation scope preflight", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-preflight-guard";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-preflight-guard",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });
      for (let i = 0; i < 6; i++) {
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`manual-user-${i}`, "user", `padding message ${i}`, {
            timestamp: 1_200 + i,
          })
        );
      }

      // A turn admitted during the preflight could launch a kernel workflow whose sidecar
      // reference the wholesale retirement deletes while its rows survive the prefix cut,
      // permanently suppressing that run's wake. Admission must therefore already be held
      // while the classification snapshot is read: park the preflight and prove a concurrent
      // context mutation is refused for the whole window.
      let releasePreflight: ((scope: "partial") => void) | undefined;
      const preflightGate = new Promise<"partial">((resolve) => {
        releasePreflight = resolve;
      });
      const preflightSpy = spyOn(
        historyService,
        "classifyTruncationRemoval"
      ).mockImplementationOnce(() => preflightGate);
      try {
        const first = workspaceService.truncateHistory(workspaceId, 0.5);
        const second = await workspaceService.truncateHistory(workspaceId, 1.0);
        expect(second.success).toBe(false);
        if (!second.success) {
          expect(second.error).toContain("already in progress");
        }
        releasePreflight?.("partial");
        const firstResult = await first;
        expect(firstResult.success).toBe(true);
      } finally {
        preflightSpy.mockRestore();
      }
      // The refused full clear touched nothing: the prefix cut left a suffix behind.
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data.length).toBeGreaterThan(0);
      }
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a turn becoming active during reference retirement refuses the truncation", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-retirement-recheck";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-retirement-recheck",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      let streaming = false;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
          isStreaming: mock(() => streaming),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });
      for (let i = 0; i < 6; i++) {
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`manual-user-${i}`, "user", `padding message ${i}`, {
            timestamp: 1_200 + i,
          })
        );
      }

      // An in-turn compaction retry bypasses admission gating across a transient idle gap,
      // and the retirement await is the last one before the rewrite: a retry that becomes
      // active during it must refuse the truncation instead of streaming across it.
      const retireSpy = spyOn(
        workspaceService as unknown as {
          retireKernelWorkflowRunReferences: (id: string) => Promise<void>;
        },
        "retireKernelWorkflowRunReferences"
      ).mockImplementationOnce(() => {
        streaming = true;
        return Promise.resolve();
      });
      try {
        const result = await workspaceService.truncateHistory(workspaceId, 0.5);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("turn is active");
        }
      } finally {
        retireSpy.mockRestore();
      }
      // Refused before the rewrite: the transcript is intact.
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(6);
      }
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a partial prefix truncation retires kernel workflow references", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-prefix-retire";
    const runId = "wfr_currentness_prefix_retire";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-prefix-retire",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "before truncation", { timestamp: 1_200 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user-b", "user", "still here after", { timestamp: 1_300 })
      );

      // A genuinely partial prefix cut can delete the launch turn's restriction-bearing rows
      // without adding a supersession decision, so the reference must not survive to
      // recompose the wake from unrestricted defaults; the run stays retrievable via resume.
      const truncateResult = await workspaceService.truncateHistory(workspaceId, 0.5);
      expect(truncateResult.success).toBe(true);
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(1);
      }
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a partial truncation blocks send admission across reference retirement", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-partial-admission";
    const runId = "wfr_currentness_partial_admission";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-partial-admission",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "before truncation", { timestamp: 1_200 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user-b", "user", "still here after", { timestamp: 1_300 })
      );

      // A send racing the partial truncation during the retirement await must be refused:
      // admitted, it would snapshot the pre-truncation transcript and lose its turn's
      // workflow provenance to the reference retirement.
      const internal = workspaceService as unknown as {
        retireKernelWorkflowRunReferences: (id: string) => Promise<void>;
      };
      const originalRetire = internal.retireKernelWorkflowRunReferences.bind(workspaceService);
      let raceSendOutcome: string | null = null;
      const retireSpy = spyOn(internal, "retireKernelWorkflowRunReferences").mockImplementationOnce(
        async (id: string) => {
          const sendResult = await workspaceService.sendMessage(workspaceId, "race the cut", {
            model: "openai:gpt-4o",
            agentId: "exec",
          });
          raceSendOutcome = sendResult.success ? "accepted" : JSON.stringify(sendResult.error);
          await originalRetire(id);
        }
      );
      try {
        const truncateResult = await workspaceService.truncateHistory(workspaceId, 0.5);
        expect(truncateResult.success).toBe(true);
      } finally {
        retireSpy.mockRestore();
      }
      expect(raceSendOutcome ?? "").toContain(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE);
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(1);
      }
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a destructive history replacement retires kernel workflow references", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-replace-retire";
    const runId = "wfr_currentness_replace_retire";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-replace-retire",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "before replacement", { timestamp: 1_200 })
      );

      // A destructive non-compaction replacement leaves a decision-free transcript that a
      // null-boundary reference would read as current, injecting the pre-replacement result.
      const replaceResult = await workspaceService.replaceHistory(
        workspaceId,
        createMuxMessage("replacement-summary", "assistant", "Replacement summary", {})
      );
      expect(replaceResult.success).toBe(true);
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a truncation that removes no rows preserves kernel workflow references", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-noop-preserve";
    const runId = "wfr_currentness_noop_preserve";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-noop-preserve",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "first message", { timestamp: 1_200 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user-b", "user", "second message", { timestamp: 1_300 })
      );

      // A tiny percentage rounds to a zero removal budget: the transcript is unchanged, so
      // the run's reference must survive or its terminal wake would settle superseded under
      // a conversation that never lost a row.
      const truncateResult = await workspaceService.truncateHistory(workspaceId, 0.0001);
      expect(truncateResult.success).toBe(true);
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(2);
      }
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(true);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a no-op-classified truncation that would remove rows is refused with references intact", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-noop-race";
    const runId = "wfr_currentness_noop_race";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-noop-race",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "single short message", { timestamp: 1_200 })
      );

      // Simulate the scope preflight racing history growth: classified a no-op (so reference
      // retirement was skipped), but the locked recomputation reaches real rows. The
      // serialized guard must refuse rather than remove rows with live references.
      const preflightSpy = spyOn(
        historyService,
        "classifyTruncationRemoval"
      ).mockImplementationOnce(() => Promise.resolve("none" as const));
      try {
        const result = await workspaceService.truncateHistory(workspaceId, 0.9);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("no-op");
        }
      } finally {
        preflightSpy.mockRestore();
      }
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(1);
      }
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(true);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a delivered coalesced workflow result consumes the kernel run's currentness", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-coalesced";
    const runId = "wfr_currentness_coalesced";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-coalesced",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      // Another run's payload quoting nothing about this run must not count as consumption.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(
          "coalesced-other",
          "user",
          buildWorkflowResultContextMessage({
            rawCommand: "workflow_run other.js",
            name: "other.js",
            runId: "wfr_currentness_other",
            status: "completed",
            result: { reportMarkdown: "other done" },
            run: null,
          }),
          { timestamp: 1_250, synthetic: true }
        )
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      // The drain's synthetic coalesced prompt carries no workflow-result metadata. After a
      // crash between durable acceptance and the settled-marker write, this row is the only
      // evidence the result already reached history; it must read as consumption or the next
      // sweep injects the same terminal result again.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(
          "coalesced-result",
          "user",
          buildWorkflowResultContextMessage({
            rawCommand: "workflow_run research.js",
            name: "research.js",
            runId,
            status: "completed",
            result: { reportMarkdown: "done" },
            run: null,
          }),
          { timestamp: 1_300, synthetic: true }
        )
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("decides sidecar currentness by boundary identity, not wall-clock order", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-clock";
    const runId = "wfr_currentness_clock";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-clock",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "run the audit workflow", { timestamp: 1_000 })
      );
      // A backward clock correction after recording makes the reference timestamp future-dated
      // relative to every later history row; identity comparison must still deliver the wake.
      const skewedCreatedAtMs = Date.now() + 30 * 60_000;
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: skewedCreatedAtMs,
        afterBoundaryMessageId: "manual-user",
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      // A user message written after the correction has a smaller timestamp than the reference;
      // wall-clock ordering would keep the stale reference current, identity must not.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user-2", "user", "never mind, answer something else", {
          timestamp: 1_200,
        })
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("fails boundaryless sidecar references quiet instead of trusting wall-clock order", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-legacy";
    const runId = "wfr_currentness_legacy";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-legacy",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "run the audit workflow", { timestamp: 1_000 })
      );
      // A reference without a boundary snapshot (pre-upgrade entry or record-time history read
      // failure) cannot be ordered against the decision row by identity: the wake fails quiet
      // (not_current) rather than delivering or deferring forever.
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
      });
      expect(await workspaceService.getWorkflowInvocationCurrentness(workspaceId, runId)).toBe(
        "not_current"
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      // A backward clock correction gives the newer superseding turn an OLDER timestamp than
      // the reference. Wall-clock ordering would resurrect the superseded reference as current
      // and deliver its output under the newer turn's tool policy; it must stay quiet.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user-2", "user", "never mind, answer something else", {
          timestamp: 1_100,
        })
      );
      expect(await workspaceService.getWorkflowInvocationCurrentness(workspaceId, runId)).toBe(
        "not_current"
      );
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("treats an unreadable history as indeterminate, not superseded", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-io-error";
    const runId = "wfr_currentness_io_error";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-io-error",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "run the audit workflow", { timestamp: 1_000 })
      );
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: "manual-user",
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      const readSpy = spyOn(historyService, "iterateFullHistory").mockResolvedValue(
        Err("disk read failed")
      );
      try {
        // The drain distinguishes a read failure (retain and retry) from supersession
        // (settle as superseded); the boolean view stays fail-safe false for non-destructive
        // callers.
        expect(await workspaceService.getWorkflowInvocationCurrentness(workspaceId, runId)).toBe(
          "indeterminate"
        );
        expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
        // The record path must fail loudly instead of persisting a verified-empty boundary that
        // would permanently strand the run's wake after storage recovers.
        let boundaryError: unknown;
        try {
          await workspaceService.getWorkflowInvocationBoundaryMessageId(workspaceId, runId);
        } catch (error: unknown) {
          boundaryError = error;
        }
        expect(String(boundaryError)).toContain("boundary unavailable");
      } finally {
        readSpy.mockRestore();
      }
      expect(await workspaceService.getWorkflowInvocationCurrentness(workspaceId, runId)).toBe(
        "current"
      );
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("treats an unreadable sidecar as indeterminate, not superseded", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-sidecar-error";
    const runId = "wfr_currentness_sidecar_error";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-sidecar-error",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "run the audit workflow", { timestamp: 1_000 })
      );
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: "manual-user",
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      // The sidecar is the only invocation evidence for kernel-launched runs: an unreadable
      // file must read as "cannot know right now", not "no reference", or the drain would
      // settle the wake as superseded on a transient storage fault.
      const sidecarPath = path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json");
      await fsPromises.rm(sidecarPath);
      await fsPromises.mkdir(sidecarPath);
      try {
        expect(await workspaceService.getWorkflowInvocationCurrentness(workspaceId, runId)).toBe(
          "indeterminate"
        );
        expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      } finally {
        await fsPromises.rmdir(sidecarPath);
      }
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: "manual-user",
      });
      expect(await workspaceService.getWorkflowInvocationCurrentness(workspaceId, runId)).toBe(
        "current"
      );
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test.each(["workflow_run", "workflow_resume"] as const)(
    "treats terminal %s output as a consumed workflow result",
    async (toolName) => {
      const { config, historyService, cleanup } = await createTestHistoryService();
      const workspaceId = `workflow-terminal-${toolName}`;
      const runId = `wfr_terminal_${toolName}`;
      const projectPath = path.join(config.rootDir, "project");
      try {
        await config.addWorkspace(projectPath, {
          id: workspaceId,
          name: workspaceId,
          projectName: "project",
          projectPath,
          runtimeConfig: { type: "local" },
        });
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          aiService: createMockAIService({
            stopStream: mock(() => Promise.resolve(Ok(undefined))),
          }),
          extensionMetadata: new ExtensionMetadataService(
            path.join(config.rootDir, "extensionMetadata.json")
          ),
          initStateManager: {
            ...mockInitStateManager,
            off: mock(() => undefined as unknown as InitStateManager),
          } as unknown as InitStateManager,
        });

        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`assistant-${toolName}`, "assistant", "", { timestamp: 1_000 }, [
            {
              type: "dynamic-tool",
              toolCallId: `${toolName}-call-1`,
              toolName,
              state: "output-available",
              input:
                toolName === "workflow_run"
                  ? { script_path: "./workflows/demo.js", args: {}, run_in_background: false }
                  : { run_id: runId, mode: "resume", run_in_background: false },
              output: {
                status: "completed",
                runId,
                result: { reportMarkdown: "done" },
              },
            },
          ])
        );

        expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
        await workspaceService.disposeSession(workspaceId);
      } finally {
        await cleanup();
      }
    }
  );

  test("keeps workflow invocations current across mid-stream auto-compaction requests", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-midstream-compact";
    const runId = "wfr_currentness_midstream_compact";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-midstream-compact",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("midstream-auto-compaction", "user", "Compacting to continue", {
          timestamp: 1_100,
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

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("treats on-send compaction requests as manual workflow supersession", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-auto-compact";
    const runId = "wfr_currentness_auto_compact";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-auto-compact",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("auto-compaction", "user", "Compacting before a new user prompt", {
          timestamp: 1_100,
          synthetic: true,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {},
            source: "auto-compaction",
          },
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("keeps workflow invocations current across compaction boundaries", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-boundary";
    const runId = "wfr_currentness_boundary";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-boundary",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      const persisted = await workspaceService.appendWorkflowRunInvocation({
        workspaceId,
        rawCommand: "/demo currentness boundary",
        scriptPath: "./workflows/demo.js",
        args: { input: "currentness boundary" },
        runId,
        status: "running",
        result: null,
      });
      expect(persisted).toBe(true);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("boundary", "assistant", "Compacted summary", {
          timestamp: 2_000,
          compactionBoundary: true,
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("treats reset boundaries as workflow supersession", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-reset";
    const runId = "wfr_currentness_reset";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-reset",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("reset-boundary", "assistant", "Context reset", {
          timestamp: 1_100,
          contextBoundaryKind: "reset",
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("keeps workflow current after non-terminal task_await errors", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-error";
    const runId = "wfr_currentness_error";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-error",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(
          "assistant-task-await-active-error",
          "assistant",
          "",
          { timestamp: 1_100 },
          [
            {
              type: "dynamic-tool",
              toolCallId: "task-await-1",
              toolName: "task_await",
              state: "output-available",
              input: { task_ids: [runId] },
              output: {
                results: [
                  {
                    taskId: runId,
                    status: "error",
                    error: "Interrupted",
                    run: { id: runId, status: "running" },
                  },
                ],
              },
            },
          ]
        )
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(
          "assistant-task-await-failed-error",
          "assistant",
          "",
          { timestamp: 1_200 },
          [
            {
              type: "dynamic-tool",
              toolCallId: "task-await-2",
              toolName: "task_await",
              state: "output-available",
              input: { task_ids: [runId] },
              output: {
                results: [
                  {
                    taskId: runId,
                    status: "error",
                    error: "Workflow failed",
                    run: { id: runId, status: "failed" },
                  },
                ],
              },
            },
          ]
        )
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("marks workflow invocations consumed after terminal task_await results", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-consumed";
    const runId = "wfr_currentness_consumed";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-consumed",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-task-await", "assistant", "", { timestamp: 1_100 }, [
          {
            type: "dynamic-tool",
            toolCallId: "task-await-1",
            toolName: "task_await",
            state: "output-available",
            input: { task_ids: [runId] },
            output: { results: [{ taskId: runId, status: "completed" }] },
          },
        ])
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });
});
