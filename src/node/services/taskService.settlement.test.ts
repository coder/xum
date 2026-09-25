import * as path from "path";
import { describe, test, expect, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import {
  TASK_CREATE_WAIT_WARNING_MS,
  TASK_TERMINATION_STOP_STREAM_AGGREGATE_TIMEOUT_MS,
  TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS,
} from "@/constants/terminationTimeouts";
import type { Config } from "@/node/config";
import {
  type Workspace as WorkspaceConfigEntry,
  type WorkspaceMetadataOptions,
} from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import type { MutexMap } from "@/node/utils/concurrency/mutexMap";
import {
  getSubagentReportArtifactPath,
  readSubagentReportArtifact,
  upsertSubagentReportArtifact,
} from "@/node/services/subagentReportArtifacts";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import {
  taskRecoveryPromptDedupeKey,
  taskRecoveryPromptDedupePrefix,
} from "@/constants/agentMessaging";
import type { TaskService } from "@/node/services/taskService";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { WorkflowRunner } from "@/node/services/workflows/WorkflowRunner";
import { WorkflowTaskServiceAdapter } from "@/node/services/workflows/WorkflowTaskServiceAdapter";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { log } from "@/node/services/log";
import { Ok, Err, type Result } from "@/common/types/result";
import type { ErrorEvent, StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage } from "@/common/types/message";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type {
  QueueCutReceipt,
  QueueCutSuccessorState,
  SendMessageInternalOptions,
} from "@/node/services/taskWorkspaceSeam";
import type { SendMessageOptions } from "@/common/orpc/types";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import type { AgentSessionAIService } from "@/node/services/agentSession";
import {
  createTurnCompletionController,
  type SettledStepBudget,
} from "@/node/services/streamManager";
import assert from "node:assert";
import {
  createAIServiceMocks,
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  streamAbort,
  streamEnd,
  stubStableIds,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  flushTerminalAttentionDrains,
  registerTaskServiceTestRoot,
  rootDir,
} from "@/node/services/taskService.shared.testHarness";

describe("TaskService", () => {
  registerTaskServiceTestRoot();

  describe("continuation-aware stream end", () => {
    const model = "openai:gpt-5.5-pro";

    /** In-memory stand-in for AgentSession's cut receipts, wired through the seam. */
    function createQueueCutReceiptFake() {
      const receipts = new Map<string, QueueCutReceipt>();
      const listeners = new Set<(workspaceId: string) => void>();
      let turnGeneration = Symbol("source-turn");
      const release = (entryId: string) => {
        const receipt = receipts.get(entryId);
        if (receipt?.sourceHandled && (receipt.disposed || receipt.successor === "streaming")) {
          receipts.delete(entryId);
        }
      };
      return {
        receipts,
        advanceTurn() {
          turnGeneration = Symbol("later-turn");
        },
        register(entryId: string, successor: QueueCutSuccessorState = "pending", disposed = false) {
          receipts.set(entryId, {
            sourceTurnGeneration: turnGeneration,
            successor,
            sourceHandled: false,
            disposed,
          });
        },
        record(entryId: string, successor: QueueCutSuccessorState) {
          const receipt = receipts.get(entryId);
          assert(receipt, `no receipt for ${entryId}`);
          receipt.successor = successor;
          release(entryId);
        },
        notify(workspaceId: string) {
          for (const listener of listeners) listener(workspaceId);
        },
        overrides: {
          getTurnGeneration: mock(() => turnGeneration),
          clearQueueCutReceipts: mock(() => receipts.clear()),
          getQueueCutReceipt: mock((_workspaceId: string, entryId: string) =>
            receipts.get(entryId)
          ),
          markQueueCutSourceHandled: mock((_workspaceId: string, entryId: string) => {
            const receipt = receipts.get(entryId);
            if (receipt) receipt.sourceHandled = true;
            release(entryId);
          }),
          disposeQueueCut: mock((_workspaceId: string, entryId: string) => {
            const receipt = receipts.get(entryId);
            if (!receipt || receipt.disposed) return false;
            receipt.disposed = true;
            release(entryId);
            return true;
          }),
          onQueuedMessageChanged: mock((listener: (workspaceId: string) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          }),
        },
      };
    }

    async function setupChildTask(
      overrides: Partial<WorkspaceConfigEntry> = {},
      hostOverrides: Parameters<typeof createWorkspaceServiceMocks>[0] = {}
    ) {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      const parentId = "parent-cut";
      const childId = "child-cut";
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
            taskModelString: model,
            ...overrides,
          }),
        ],
        testTaskSettings(1, 3)
      );
      const receiptFake = createQueueCutReceiptFake();
      const removeQueuedMessagesByDedupeKeyPrefix = mock((): Result<number> => Ok(0));
      const mocks = createWorkspaceServiceMocks({
        ...receiptFake.overrides,
        removeQueuedMessagesByDedupeKeyPrefix,
        ...hostOverrides,
      });
      const aiMocks = createAIServiceMocks(config);
      const harness = createTaskServiceHarness(config, {
        workspaceService: mocks.workspaceService,
        aiService: aiMocks.aiService,
      });
      const child = () => findWorkspaceInConfig(config, childId);
      /** Settles behind any reconcile the notification listener queued under the event lock. */
      const settleEventLock = () =>
        (
          harness.taskService as unknown as { workspaceEventLocks: MutexMap<string> }
        ).workspaceEventLocks.withLock(childId, () => Promise.resolve());
      return {
        config,
        parentId,
        childId,
        receiptFake,
        child,
        emitStreamEnd: (event: StreamEndEvent) => {
          aiMocks.events.emit("stream-end", event);
        },
        emitError: (event: ErrorEvent) => {
          aiMocks.events.emit("error", event);
        },
        settleEventLock,
        removeQueuedMessagesByDedupeKeyPrefix,
        ...mocks,
        ...harness,
      };
    }

    function cutEvent(
      childId: string,
      stopCause: StreamEndEvent["metadata"]["stopCause"],
      messageId = "assistant-cut"
    ): StreamEndEvent {
      return {
        type: "stream-end",
        workspaceId: childId,
        messageId,
        metadata: { model, finishReason: "tool-calls", ...(stopCause ? { stopCause } : {}) },
        parts: [],
      };
    }

    function recoverySendOptions(sendMessage: ReturnType<typeof mock>, index = 0) {
      const call = sendMessage.mock.calls[index] as unknown[] | undefined;
      return {
        message: call?.[1] as string | undefined,
        options: call?.[2] as SendMessageOptions | undefined,
        internal: call?.[3] as SendMessageInternalOptions | undefined,
      };
    }

    test.each([
      ["pending", "pending" as const],
      ["admitted", { kind: "admitted" as const, turnGeneration: Symbol("successor") }],
    ])(
      "a queued-input cut whose successor is %s defers instead of prompting",
      async (_label, successor) => {
        const t = await setupChildTask();
        t.receiptFake.register("entry-1", successor);

        await streamEnd(
          t.taskService,
          cutEvent(t.childId, { kind: "queued-input", entryId: "entry-1" })
        );

        expect(t.sendMessage).not.toHaveBeenCalled();
        expect(t.child()?.taskStatus).toBe("running");
        expect(t.child()?.taskRecoveryAttempts).toBeUndefined();
        // Source handled, but the receipt survives until the successor settles.
        expect(t.receiptFake.receipts.get("entry-1")).toMatchObject({
          sourceHandled: true,
          disposed: false,
        });
        // Repeated notifications with an unsettled successor never become ordinary recovery.
        t.receiptFake.notify(t.childId);
        t.receiptFake.notify(t.childId);
        await t.settleEventLock();
        expect(t.sendMessage).not.toHaveBeenCalled();
        expect(t.child()?.taskStatus).toBe("running");
      }
    );

    test.each<QueueCutSuccessorState>([
      "pending",
      { kind: "admitted", turnGeneration: Symbol("successor") },
      "streaming",
      "canceled",
      "prestream-failed",
    ])(
      "parent stream-end releases its exact cut receipt regardless of successor outcome: %j",
      async (successor) => {
        const t = await setupChildTask({ taskStatus: "reported" });
        for (const stopCause of [
          { kind: "queued-input" as const, entryId: "parent-entry" },
          {
            kind: "context-budget" as const,
            decision: "warn" as const,
            continuationEntryId: "parent-entry",
          },
        ]) {
          t.receiptFake.register("parent-entry", successor);
          t.receiptFake.register("unrelated-entry");
          await streamEnd(t.taskService, cutEvent(t.parentId, stopCause));
          expect(t.receiptFake.receipts.has("parent-entry")).toBe(false);
          expect(t.receiptFake.receipts.has("unrelated-entry")).toBe(true);
        }
        expect(t.sendMessage).not.toHaveBeenCalled();
      }
    );

    test("an owned compaction continuation releases its source receipt", async () => {
      const t = await setupChildTask(
        {},
        {
          waitForPendingCompactionCompletionDecision: mock(() => Promise.resolve(true)),
        }
      );
      t.receiptFake.register("compact-entry");
      const event = cutEvent(t.childId, { kind: "queued-input", entryId: "compact-entry" });
      event.metadata.agentId = "compact";
      await streamEnd(t.taskService, event);
      expect(t.receiptFake.receipts.size).toBe(0);
      expect(t.sendMessage).not.toHaveBeenCalled();
    });

    test("a streaming successor owns completion: deferral dropped, receipt released", async () => {
      const t = await setupChildTask();
      t.receiptFake.register("entry-1", "streaming");

      await streamEnd(
        t.taskService,
        cutEvent(t.childId, { kind: "queued-input", entryId: "entry-1" })
      );

      expect(t.sendMessage).not.toHaveBeenCalled();
      expect(t.child()?.taskStatus).toBe("running");
      expect(t.receiptFake.receipts.has("entry-1")).toBe(false);
      t.receiptFake.notify(t.childId);
      await t.settleEventLock();
      expect(t.sendMessage).not.toHaveBeenCalled();
    });

    test.each(["canceled", "prestream-failed"] as const)(
      "a %s successor at classification recovers exactly once with a turn-end deduped prompt",
      async (successor) => {
        const t = await setupChildTask();
        t.receiptFake.register("entry-1", successor);

        await streamEnd(
          t.taskService,
          cutEvent(t.childId, { kind: "queued-input", entryId: "entry-1" })
        );

        expect(t.sendMessage).toHaveBeenCalledTimes(1);
        const { options, internal } = recoverySendOptions(t.sendMessage);
        expect(options?.queueDispatchMode).toBe("turn-end");
        expect(internal).toMatchObject({
          queueDedupeKey: taskRecoveryPromptDedupeKey(t.childId, "completion"),
          removableQueueDedupeKey: true,
        });
        expect(t.child()?.taskStatus).toBe("awaiting_report");
        expect(t.child()?.taskRecoveryAttempts).toBe(1);
        // Consumed and, with the source handled, released.
        expect(t.receiptFake.overrides.disposeQueueCut).toHaveBeenCalledTimes(1);
        expect(t.receiptFake.receipts.has("entry-1")).toBe(false);
        // A late duplicate notification after release is a no-op.
        t.receiptFake.notify(t.childId);
        await t.settleEventLock();
        expect(t.sendMessage).toHaveBeenCalledTimes(1);
        expect(t.child()?.taskRecoveryAttempts).toBe(1);
      }
    );

    test("an already disposed receipt at classification is acknowledged without recovery", async () => {
      const t = await setupChildTask();
      // The failure notification recovered first (disposed); the source handler runs last.
      t.receiptFake.register("entry-1", "prestream-failed", true);

      await streamEnd(
        t.taskService,
        cutEvent(t.childId, { kind: "queued-input", entryId: "entry-1" })
      );

      expect(t.sendMessage).not.toHaveBeenCalled();
      expect(t.child()?.taskStatus).toBe("running");
      expect(t.receiptFake.receipts.has("entry-1")).toBe(false);
    });

    test.each([
      ["still queued", "pending" as const],
      ["already dequeued", { kind: "admitted" as const, turnGeneration: Symbol("continue") }],
    ])(
      "a context-budget warning whose continuation is %s defers instead of prompting",
      async (_label, successor) => {
        const t = await setupChildTask();
        t.receiptFake.register("continue-entry", successor);

        await streamEnd(
          t.taskService,
          cutEvent(t.childId, {
            kind: "context-budget",
            decision: "warn",
            continuationEntryId: "continue-entry",
          })
        );

        expect(t.sendMessage).not.toHaveBeenCalled();
        expect(t.child()?.taskStatus).toBe("running");
        expect(t.receiptFake.receipts.get("continue-entry")?.sourceHandled).toBe(true);
      }
    );

    test.each([
      ["context-budget block", { kind: "context-budget" as const, decision: "block" as const }],
      ["a cut without a receipt", { kind: "queued-input" as const, entryId: "unknown-entry" }],
      ["no stop cause", undefined],
    ])("%s keeps the existing recovery path", async (_label, stopCause) => {
      const t = await setupChildTask();

      await streamEnd(t.taskService, cutEvent(t.childId, stopCause));

      expect(t.sendMessage).toHaveBeenCalledTimes(1);
      expect(t.child()?.taskStatus).toBe("awaiting_report");
      expect(t.child()?.taskRecoveryAttempts).toBe(1);
      expect(t.receiptFake.overrides.disposeQueueCut).not.toHaveBeenCalled();
    });

    test.each(["canceled", "prestream-failed"] as const)(
      "a deferred stream end recovers once when its successor later settles %s",
      async (successor) => {
        const t = await setupChildTask();
        t.receiptFake.register("entry-1");
        await streamEnd(
          t.taskService,
          cutEvent(t.childId, { kind: "queued-input", entryId: "entry-1" })
        );
        expect(t.sendMessage).not.toHaveBeenCalled();

        // Admission is a transfer, not success: the deferral survives it.
        t.receiptFake.record("entry-1", { kind: "admitted", turnGeneration: Symbol("successor") });
        t.receiptFake.notify(t.childId);
        await t.settleEventLock();
        expect(t.sendMessage).not.toHaveBeenCalled();
        expect(t.child()?.taskStatus).toBe("running");

        t.receiptFake.record("entry-1", successor);
        t.receiptFake.notify(t.childId);
        t.receiptFake.notify(t.childId);
        await t.settleEventLock();

        expect(t.sendMessage).toHaveBeenCalledTimes(1);
        expect(recoverySendOptions(t.sendMessage).options?.queueDispatchMode).toBe("turn-end");
        expect(t.child()?.taskStatus).toBe("awaiting_report");
        expect(t.child()?.taskRecoveryAttempts).toBe(1);
        expect(t.receiptFake.receipts.has("entry-1")).toBe(false);

        // Late duplicate after release: never a fallback into ordinary recovery.
        t.receiptFake.notify(t.childId);
        await t.settleEventLock();
        expect(t.sendMessage).toHaveBeenCalledTimes(1);
      }
    );

    test("a deferred stream end settles when the successor streams, and its own end classifies normally", async () => {
      const t = await setupChildTask();
      t.receiptFake.register("entry-1");
      await streamEnd(
        t.taskService,
        cutEvent(t.childId, { kind: "queued-input", entryId: "entry-1" })
      );

      t.receiptFake.record("entry-1", "streaming");
      t.receiptFake.notify(t.childId);
      await t.settleEventLock();
      expect(t.sendMessage).not.toHaveBeenCalled();
      expect(t.receiptFake.receipts.has("entry-1")).toBe(false);

      // The successor's genuine incomplete end (no cut) still recovers.
      await streamEnd(t.taskService, cutEvent(t.childId, undefined, "assistant-successor"));
      expect(t.sendMessage).toHaveBeenCalledTimes(1);
      expect(t.child()?.taskStatus).toBe("awaiting_report");
    });

    test("a terminal interruption clears the deferral, disposes the cut, and removes queued prompts", async () => {
      const t = await setupChildTask();
      t.receiptFake.register("entry-1");
      await streamEnd(
        t.taskService,
        cutEvent(t.childId, { kind: "queued-input", entryId: "entry-1" })
      );

      await t.taskService.failAgentTaskForHardTimeout(t.childId, {
        workflowRunId: "wfr_cut",
        stepId: "explore",
        inputHash: "hash",
        reason: "Task exceeded its hard timeout.",
      });
      expect(t.child()?.taskStatus).toBe("interrupted");
      expect(t.removeQueuedMessagesByDedupeKeyPrefix).toHaveBeenCalledWith(
        t.childId,
        taskRecoveryPromptDedupePrefix(t.childId),
        expect.anything()
      );
      expect(t.receiptFake.receipts.has("entry-1")).toBe(false);

      // A withdrawn continuation after Stop never recovers.
      t.receiptFake.register("entry-1", "canceled");
      t.receiptFake.notify(t.childId);
      await t.settleEventLock();
      expect(t.sendMessage).not.toHaveBeenCalled();
      expect(t.child()?.taskStatus).toBe("interrupted");
    });

    test("a genuine completion clears the deferral so a withdrawn continuation never recovers", async () => {
      const t = await setupChildTask();
      t.receiptFake.register("entry-1");
      await streamEnd(
        t.taskService,
        cutEvent(t.childId, { kind: "queued-input", entryId: "entry-1" })
      );

      await streamEnd(t.taskService, {
        type: "stream-end",
        workspaceId: t.childId,
        messageId: "assistant-final",
        metadata: { model, finishReason: "stop" },
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "agent-report-1",
            toolName: "agent_report",
            input: { reportMarkdown: "Done", title: "Result" },
            state: "output-available",
            output: { success: true },
          },
          { type: "text", text: "Done" },
        ],
      });
      await flushTerminalAttentionDrains(t.taskService);
      expect(t.child()?.taskStatus).toBe("reported");
      expect(t.removeQueuedMessagesByDedupeKeyPrefix).toHaveBeenCalledWith(
        t.childId,
        taskRecoveryPromptDedupePrefix(t.childId),
        expect.anything()
      );

      expect(t.receiptFake.receipts.size).toBe(0);
      t.receiptFake.notify(t.childId);
      await t.settleEventLock();
      expect(t.sendMessage).not.toHaveBeenCalled();
      expect(t.child()?.taskStatus).toBe("reported");
    });

    test("an unrelated turn ending cannot discard the still-pending cut continuation", async () => {
      const t = await setupChildTask();
      t.receiptFake.register("entry-1");
      await streamEnd(
        t.taskService,
        cutEvent(t.childId, { kind: "queued-input", entryId: "entry-1" })
      );
      t.receiptFake.advanceTurn();
      await streamEnd(t.taskService, cutEvent(t.childId, undefined, "unrelated-incomplete-turn"));
      expect(t.child()?.taskStatus).toBe("running");
      expect(t.sendMessage).not.toHaveBeenCalled();
      t.receiptFake.record("entry-1", "canceled");
      t.receiptFake.notify(t.childId);
      await t.settleEventLock();
      expect(t.sendMessage).toHaveBeenCalledTimes(1);
      expect(t.child()?.taskRecoveryAttempts).toBe(1);
      expect(t.receiptFake.receipts.size).toBe(0);
    });

    test.each(["execution", "stop epoch"])(
      "a cut event waiting for the event lock cannot recover after its %s changes",
      async (change) => {
        const t = await setupChildTask({ taskExecutionId: "wst_original" });
        const service = t.taskService as unknown as {
          workspaceEventLocks: MutexMap<string>;
          bumpWorkspaceStopEpoch: (workspaceId: string) => void;
        };
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const held = service.workspaceEventLocks.withLock(t.childId, async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
        t.receiptFake.register("entry-1", "canceled");
        try {
          t.emitStreamEnd(cutEvent(t.childId, { kind: "queued-input", entryId: "entry-1" }));
          if (change === "execution") {
            await t.config.editConfig((cfg) => {
              const entry = findWorkspaceEntry(cfg, t.childId);
              assert(entry);
              entry.workspace.taskExecutionId = "wst_replacement";
              return cfg;
            });
          } else {
            service.bumpWorkspaceStopEpoch(t.childId);
          }
        } finally {
          release.resolve();
          await held;
        }
        await t.settleEventLock();
        expect(t.sendMessage).not.toHaveBeenCalled();
        expect(t.child()?.taskStatus).toBe("running");
        expect(t.child()?.taskRecoveryAttempts).toBeUndefined();
        expect(t.receiptFake.receipts.size).toBe(0);
      }
    );

    test("a delayed startup error and its failure notification share one recovery disposition", async () => {
      const t = await setupChildTask();
      t.receiptFake.register("entry-1");
      await streamEnd(
        t.taskService,
        cutEvent(t.childId, { kind: "queued-input", entryId: "entry-1" })
      );
      const service = t.taskService as unknown as { workspaceEventLocks: MutexMap<string> };
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const held = service.workspaceEventLocks.withLock(t.childId, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      try {
        // The request builder emits its error before returning the failed preparation result.
        // Both handlers wait behind the existing source-event lock until the outcome is known.
        t.emitError({
          type: "error",
          workspaceId: t.childId,
          messageId: "successor",
          error: "Preparation failed",
          errorType: "unknown",
        });
        t.receiptFake.record("entry-1", "prestream-failed");
        t.receiptFake.notify(t.childId);
      } finally {
        release.resolve();
        await held;
      }
      await t.settleEventLock();
      expect(t.sendMessage).toHaveBeenCalledTimes(1);
      expect(t.child()?.taskRecoveryAttempts).toBe(1);
      expect(t.receiptFake.receipts.size).toBe(0);
    });

    test("explicit Stop discards a withdrawn continuation without recovery", async () => {
      const t = await setupChildTask();
      t.receiptFake.register("entry-1");
      await streamEnd(
        t.taskService,
        cutEvent(t.childId, { kind: "queued-input", entryId: "entry-1" })
      );
      t.receiptFake.record("entry-1", "canceled");
      await streamAbort(t.taskService, {
        type: "stream-abort",
        workspaceId: t.childId,
        messageId: "successor",
        abortReason: "user",
      });
      t.receiptFake.notify(t.childId);
      await t.settleEventLock();
      expect(t.sendMessage).not.toHaveBeenCalled();
      expect(t.child()?.taskRecoveryAttempts).toBeUndefined();
      expect(t.receiptFake.receipts.size).toBe(0);
    });

    test("persisted report adoption clears superseded recovery state", async () => {
      const t = await setupChildTask();
      t.receiptFake.register("late-source-entry", "prestream-failed");
      await upsertSubagentReportArtifact({
        workspaceId: t.parentId,
        workspaceSessionDir: path.join(t.config.sessionsDir, t.parentId),
        childTaskId: t.childId,
        parentWorkspaceId: t.parentId,
        ancestorWorkspaceIds: [t.parentId],
        reportMarkdown: "Recovered completed work",
        nowMs: Date.now(),
      });
      const report = await t.taskService.waitForAgentReport(t.childId, {
        requestingWorkspaceId: t.parentId,
        timeoutMs: 10,
      });
      expect(report.reportMarkdown).toBe("Recovered completed work");
      expect(t.child()?.taskStatus).toBe("reported");
      expect(t.receiptFake.receipts.size).toBe(0);
      expect(t.removeQueuedMessagesByDedupeKeyPrefix).toHaveBeenCalledWith(
        t.childId,
        taskRecoveryPromptDedupePrefix(t.childId),
        expect.any(Object)
      );
      t.receiptFake.notify(t.childId);
      await t.settleEventLock();
      expect(t.sendMessage).not.toHaveBeenCalled();
    });

    test("terminal settlement releases a receipt whose source event has not been handled", async () => {
      const t = await setupChildTask();
      t.receiptFake.register("late-source-entry", "prestream-failed");
      await t.taskService.failAgentTaskForHardTimeout(t.childId, {
        workflowRunId: "wfr_late_source",
        stepId: "explore",
        inputHash: "hash",
        reason: "Task exceeded its hard timeout.",
      });
      expect(t.child()?.taskStatus).toBe("interrupted");
      expect(t.receiptFake.receipts.size).toBe(0);
      t.receiptFake.notify(t.childId);
      await t.settleEventLock();
      expect(t.sendMessage).not.toHaveBeenCalled();
    });

    test("the timeout finalization prompt also queues turn-end under the task recovery prefix", async () => {
      const t = await setupChildTask({
        workflowTask: { runId: "wfr_finalize", stepId: "explore" },
      });
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(t.config.sessionsDir, t.parentId),
      });
      await runStore.createRun({
        id: "wfr_finalize",
        workspaceId: t.parentId,
        workflow: {
          name: "finalize",
          description: "Finalize",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return {}; }\n",
        args: {},
        now: "2026-06-04T00:00:00.000Z",
      });
      await runStore.appendStatus("wfr_finalize", "running", "2026-06-04T00:00:01.000Z");

      await t.taskService.requestAgentFinalReportForTimeout(t.childId, {
        workflowRunId: "wfr_finalize",
        stepId: "explore",
        inputHash: "hash",
        finalInstructions: "Summarize what you have.",
        finalizationToken: "token-1",
      });

      expect(t.sendMessage).toHaveBeenCalledTimes(1);
      const { options, internal } = recoverySendOptions(t.sendMessage);
      expect(options?.queueDispatchMode).toBe("turn-end");
      expect(internal).toMatchObject({
        queueDedupeKey: taskRecoveryPromptDedupeKey(t.childId, "timeout-finalization"),
        removableQueueDedupeKey: true,
      });
    });

    test("the error recovery prompt carries the structured-output diagnostic and nothing else", async () => {
      const t = await setupChildTask({ taskStatus: "awaiting_report" });
      const internal = t.taskService as unknown as {
        promptTaskForRequiredCompletionTool: (
          workspaceId: string,
          options: {
            reason?: "startup" | "stream_end" | "error";
            error?: { error: string; errorType?: string };
            structuredOutputDiagnostic?: string;
            expectedAttemptId: string | null;
          }
        ) => Promise<boolean>;
      };
      const diagnostic = `agent_report structuredOutput failed schema validation: ${"x".repeat(600)}\nsecond line`;

      await internal.promptTaskForRequiredCompletionTool(t.childId, {
        reason: "error",
        error: { error: "provider said: SECRET-PROVIDER-DETAIL", errorType: "unknown" },
        structuredOutputDiagnostic: diagnostic,
        expectedAttemptId: null,
      });
      await internal.promptTaskForRequiredCompletionTool(t.childId, {
        reason: "error",
        error: { error: "provider said: SECRET-PROVIDER-DETAIL", errorType: "unknown" },
        expectedAttemptId: null,
      });

      expect(t.sendMessage).toHaveBeenCalledTimes(2);
      const withDiagnostic = recoverySendOptions(t.sendMessage, 0).message ?? "";
      const withoutDiagnostic = recoverySendOptions(t.sendMessage, 1).message ?? "";
      expect(withDiagnostic).toContain("agent_report structuredOutput failed schema validation");
      expect(withDiagnostic).not.toContain("second line");
      expect(withDiagnostic).not.toContain("SECRET-PROVIDER-DETAIL");
      expect(withDiagnostic.split("\n").length).toBe(1);
      expect(withDiagnostic.length - withoutDiagnostic.length).toBeLessThanOrEqual(400 + 4);
      expect(withoutDiagnostic).not.toContain("SECRET-PROVIDER-DETAIL");
    });

    test("regression: budget warning, queued Continue, agent_report cut by queued input, then a final stop yields one report and zero recovery prompts", async () => {
      // Replays the observed child trace through a real AgentSession/MessageQueue/HistoryService
      // with a controlled provider; TaskService classifies each stream end as production would.
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      const parentId = "parent-regression";
      const childId = "child-regression";
      const runId = "wfr_regression";
      const childModel = "openai:gpt-4o";
      await saveWorkspaces(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "parent", parentId),
          projectWorkspace(projectPath, "child", childId, {
            name: "agent_exec_child",
            parentWorkspaceId: parentId,
            agentType: "exec",
            taskStatus: "running",
            taskModelString: childModel,
            workflowTask: { runId, stepId: "research", outputSchema: { type: "object" } },
          }),
        ],
        testTaskSettings(1, 3)
      );
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(config.sessionsDir, parentId),
      });
      await runStore.createRun({
        id: runId,
        workspaceId: parentId,
        workflow: {
          name: "regression",
          description: "Regression",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return {}; }\n",
        args: {},
        now: "2026-06-04T00:00:00.000Z",
      });
      await runStore.appendStatus(runId, "running", "2026-06-04T00:00:01.000Z");

      // Controlled provider (agentSession.tokenBudget.test.ts style).
      type Request = Parameters<AgentSessionAIService["streamMessage"]>[0];
      const requests: Request[] = [];
      const completions: Array<ReturnType<typeof createTurnCompletionController>> = [];
      const requestWaiters = new Map<number, ReturnType<typeof Promise.withResolvers<Request>>>();
      const waitForRequest = (count: number) => {
        let waiter = requestWaiters.get(count);
        if (!waiter) {
          waiter = Promise.withResolvers<Request>();
          requestWaiters.set(count, waiter);
          if (requests.length >= count) waiter.resolve(requests[count - 1]);
        }
        return waiter.promise;
      };
      const historyService = new HistoryService(config);
      const sessionHarness = await createAgentSessionHarness({
        workspaceId: childId,
        config,
        historyService,
        aiServiceOverrides: {
          streamMessage: mock<AgentSessionAIService["streamMessage"]>((request) => {
            requests.push(request);
            sessionHarness.aiEmitter.emit("stream-start", {
              type: "stream-start",
              workspaceId: childId,
              messageId: `assistant-${requests.length}`,
              model: request.modelString,
              startTime: Date.now(),
            });
            const completion = createTurnCompletionController();
            completions.push(completion);
            requestWaiters.get(requests.length)?.resolve(request);
            const close = () => completion.settle({ status: "aborted", abortReason: "system" });
            const signal = sessionHarness.session.closingSignal;
            if (signal.aborted) close();
            else signal.addEventListener("abort", close, { once: true });
            return Promise.resolve(
              Ok({
                messageId: `assistant-${requests.length}`,
                completion: completion.promise.finally(() =>
                  signal.removeEventListener("abort", close)
                ),
              })
            );
          }),
          buildMemorySessionContext: mock(() => Promise.resolve(null)),
        },
      });
      const { session } = sessionHarness;
      spyOn(sessionHarness.aiService, "getWorkspaceMetadata").mockResolvedValue(
        Ok({
          id: childId,
          name: "child",
          projectName: "repo",
          projectPath: config.rootDir,
          namedWorkspacePath: config.rootDir,
          runtimeConfig: { type: "local" },
        } as WorkspaceMetadata)
      );

      // TaskService sees the child through the seam, backed by the real session.
      const listeners = new Set<(workspaceId: string) => void>();
      session.onChatEvent(({ message }) => {
        if (message.type !== "queued-message-changed") return;
        for (const listener of listeners) listener(childId);
      });
      const mocks = createWorkspaceServiceMocks({
        getTurnGeneration: mock(() => session.getTurnGeneration()),
        clearQueueCutReceipts: mock(() => session.clearQueueCutReceipts()),
        getQueueCutReceipt: mock((_workspaceId: string, entryId: string) =>
          session.getQueueCutReceipt(entryId)
        ),
        markQueueCutSourceHandled: mock((_workspaceId: string, entryId: string) =>
          session.markQueueCutSourceHandled(entryId)
        ),
        disposeQueueCut: mock((_workspaceId: string, entryId: string) =>
          session.disposeQueueCut(entryId)
        ),
        onQueuedMessageChanged: mock((listener: (workspaceId: string) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
        hasPendingQueuedOrPreparingTurn: mock(
          () => session.hasQueuedMessages() || session.isPreparingTurn()
        ),
      });
      const { taskService } = createTaskServiceHarness(config, {
        workspaceService: mocks.workspaceService,
      });
      const settleEventLock = () =>
        (
          taskService as unknown as { workspaceEventLocks: MutexMap<string> }
        ).workspaceEventLocks.withLock(childId, () => Promise.resolve());

      try {
        // Turn 1: the child works until the settled step crosses the budget warning.
        expect(
          (
            await session.sendMessage("Research the topic and report.", {
              model: childModel,
              agentId: "exec",
              experiments: { tokenBudget: true },
            })
          ).success
        ).toBe(true);
        await waitForRequest(1);
        const budgetStep: SettledStepBudget = {
          model: childModel,
          usage: { inputTokens: 85_000, outputTokens: 10, totalTokens: 85_010 },
          toolResultChars: 0,
          imageParts: 0,
          sessionHistoryAvailable: true,
          memoryWritable: true,
        };
        const budgetOutcome = await requests[0].onStepSettled?.(budgetStep);
        expect(budgetOutcome?.decision).toBe("warn");
        const continuationEntryId = budgetOutcome?.continuationEntryId;
        expect(continuationEntryId).toBeDefined();
        const budgetCut: StreamEndEvent = {
          type: "stream-end",
          workspaceId: childId,
          messageId: "assistant-1",
          metadata: {
            model: childModel,
            agentId: "exec",
            finishReason: "tool-calls",
            stopCause: { kind: "context-budget", decision: "warn", continuationEntryId },
          },
          parts: [],
        };
        await streamEnd(taskService, budgetCut);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        completions[0].settle({ status: "completed", streamEnd: budgetCut });

        // Turn 2 (queued "Continue"): a schema-shaped agent_report succeeds, then a message
        // queued for the child (task_send_message) cuts the turn at the step boundary.
        await waitForRequest(2);
        const agentReportPart = {
          type: "dynamic-tool" as const,
          toolCallId: "agent-report-1",
          toolName: "agent_report",
          input: { verdict: "supported", confidence: 0.9 },
          state: "output-available" as const,
          output: { success: true },
        };
        expect(
          (
            await historyService.appendToHistory(
              childId,
              createMuxMessage("assistant-2", "assistant", "", { model: childModel }, [
                agentReportPart,
              ])
            )
          ).success
        ).toBe(true);
        expect(
          session.queueMessage("Parent guidance: include the source list.", {
            model: childModel,
            agentId: "exec",
          })
        ).toBe("tool-end");
        const queuedInputCause = requests[1].getQueuedInputStopCause?.();
        expect(queuedInputCause?.kind).toBe("queued-input");
        const queuedInputCut: StreamEndEvent = {
          type: "stream-end",
          workspaceId: childId,
          messageId: "assistant-2",
          metadata: {
            model: childModel,
            agentId: "exec",
            finishReason: "tool-calls",
            stopCause: queuedInputCause,
          },
          parts: [agentReportPart],
        };
        await streamEnd(taskService, queuedInputCut);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        completions[1].settle({ status: "completed", streamEnd: queuedInputCut });

        // Turn 3 (the queued message): the child answers with its final text.
        await waitForRequest(3);
        await settleEventLock();
        const finalTurn: StreamEndEvent = {
          type: "stream-end",
          workspaceId: childId,
          messageId: "assistant-3",
          metadata: { model: childModel, agentId: "exec", finishReason: "stop" },
          parts: [{ type: "text", text: "Sources listed; verdict stands." }],
        };
        await streamEnd(taskService, finalTurn);
        completions[2].settle({ status: "completed", streamEnd: finalTurn });
        await flushTerminalAttentionDrains(taskService);

        // Exactly one finalized report, zero recovery prompts, no recovery budget consumed.
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        const child = findWorkspaceInConfig(config, childId);
        expect(child?.taskStatus).toBe("reported");
        expect(child?.taskRecoveryAttempts).toBeUndefined();
        const report = await readSubagentReportArtifact(
          path.join(config.sessionsDir, parentId),
          childId
        );
        expect(report?.structuredOutput).toEqual({ verdict: "supported", confidence: 0.9 });
        expect(report?.reportMarkdown).toBe("Sources listed; verdict stands.");
        expect(requests).toHaveLength(3);
        // Every cut receipt settled: nothing retained in the session.
        expect(session.getQueueCutReceipt(continuationEntryId!)).toBeUndefined();
        expect(session.getQueueCutReceipt(queuedInputCause!.entryId)).toBeUndefined();
      } finally {
        await session.dispose();
        await sessionHarness.cleanup();
      }
    });
  });

  const rootId = "root-teardown";

  const unrelatedParentId = "1111111111";

  /** Fire only the termination timers immediately; every other timer keeps its delay. */
  function shortenTerminationTimers(): () => void {
    const originalSetTimeout = globalThis.setTimeout;
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      timeout?: number
    ) => {
      if (
        timeout === TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS ||
        timeout === TASK_TERMINATION_STOP_STREAM_AGGREGATE_TIMEOUT_MS
      ) {
        return originalSetTimeout(handler, 0);
      }
      return originalSetTimeout(handler, timeout);
    }) as typeof setTimeout);
    return () => spy.mockRestore();
  }

  interface TreeDescendant {
    id: string;
    parent: string;
    overrides?: Parameters<typeof projectWorkspace>[3];
  }

  async function setupTree(
    descendants: Array<string | TreeDescendant>,
    taskSettings = testTaskSettings(4, 3)
  ) {
    const descendantEntries: TreeDescendant[] = descendants.map((descendant) =>
      typeof descendant === "string" ? { id: descendant, parent: rootId } : descendant
    );
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: unrelatedParentId,
          name: "unrelated-parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "high" },
        },
        projectWorkspace(projectPath, "root", rootId),
        ...descendantEntries.map(({ id, parent, overrides }) =>
          projectWorkspace(projectPath, id, id, {
            parentWorkspaceId: parent,
            agentType: "explore",
            taskStatus: "running",
            ...overrides,
          })
        ),
      ],
      taskSettings
    );
    return { config, projectPath };
  }

  async function waitUntil(condition: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  /** The owned settlement follows the status write asynchronously; poll the authoritative read. */
  async function waitForOutcomeKind(
    taskService: TaskService,
    taskId: string,
    kind: string
  ): Promise<void> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const outcome = await taskService.readAttemptOutcome(taskId, {
        requestingWorkspaceId: rootId,
      });
      if (outcome.kind === kind) return;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${kind}; last ${JSON.stringify(outcome)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  /** Controlled stopStream: hung ids never settle until the test resolves them. */
  function controlledStopStream(hungIds: Set<string>) {
    const pending = new Map<string, ReturnType<typeof Promise.withResolvers<Result<void>>>>();
    const stopStream = mock((workspaceId: string): Promise<Result<void>> => {
      if (!hungIds.has(workspaceId)) return Promise.resolve(Ok(undefined));
      const gate = Promise.withResolvers<Result<void>>();
      pending.set(workspaceId, gate);
      return gate.promise;
    });
    return { stopStream, pending };
  }

  describe("teardown ownership and lock isolation", () => {
    test("a hung descendant stop neither holds the global mutex nor unbounds teardown; its latch is retained", async () => {
      const stuckId = "task-stuck";
      const siblingId = "task-sibling";
      const { config } = await setupTree([stuckId, siblingId]);
      stubStableIds(config, ["unrelatedchild1"]);
      const { stopStream, pending } = controlledStopStream(new Set([stuckId]));
      const { aiService } = createAIServiceMocks(config, { stopStream });
      const clearQueue = mock((_workspaceId: string): Result<void> => Ok(undefined));
      const { workspaceService } = createWorkspaceServiceMocks({ clearQueue });
      const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
      const restoreTimers = shortenTerminationTimers();
      try {
        const waiter = taskService
          .waitForAgentReport(stuckId, { timeoutMs: 5_000, requestingWorkspaceId: rootId })
          .then(
            () => "resolved" as const,
            (error: unknown) => (error instanceof Error ? error.message : "rejected")
          );
        const teardown = taskService.terminateAllDescendantAgentTasks(rootId);
        // The stop is pending (hung) — an unrelated tree must still be able to create tasks.
        await waitUntil(() => pending.has(stuckId), "the hung stop to be issued");
        const unrelated = await taskService.createMany([
          {
            parentWorkspaceId: unrelatedParentId,
            kind: "agent" as const,
            agentId: "explore",
            prompt: "unrelated work",
            title: "Unrelated",
          },
        ]);
        expect(unrelated.success).toBe(true);

        const interrupted = await teardown;
        expect(new Set(interrupted)).toEqual(new Set([stuckId, siblingId]));
        expect(findWorkspaceInConfig(config, stuckId)?.taskStatus).toBe("interrupted");
        expect(findWorkspaceInConfig(config, siblingId)?.taskStatus).toBe("interrupted");
        expect(await waiter).toBe("Parent workspace interrupted");
        // Exactly one queue clear and one stop per descendant, issued while latched.
        expect(clearQueue.mock.calls.map((call) => call[0]).sort()).toEqual(
          [stuckId, siblingId].sort()
        );
        expect(stopStream.mock.calls.filter((call) => call[0] === stuckId)).toHaveLength(1);
        expect(stopStream.mock.calls.filter((call) => call[0] === siblingId)).toHaveLength(1);
        // Hung cleanup keeps the latch; the settled sibling is free.
        expect(taskService.isWorkspaceStopInProgress(stuckId)).toBe(true);
        expect(taskService.isWorkspaceStopInProgress(siblingId)).toBe(false);

        // The original promise settling later is only a recheck, and settlement evidence for a
        // plain (idle-at-capture) child was already recorded, so the latch drops now.
        pending.get(stuckId)!.resolve(Ok(undefined));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(taskService.isWorkspaceStopInProgress(stuckId)).toBe(false);
      } finally {
        restoreTimers();
      }
    });

    test("several hung descendants are bounded by the aggregate deadline, not n × per-child timeout", async () => {
      const hung = ["task-hung-a", "task-hung-b", "task-hung-c"];
      const { config } = await setupTree(hung);
      const { stopStream } = controlledStopStream(new Set(hung));
      const { aiService } = createAIServiceMocks(config, { stopStream });
      const { taskService } = createTaskServiceHarness(config, { aiService });
      const events: string[] = [];
      const originalSetTimeout = globalThis.setTimeout;
      const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
        handler: () => void,
        timeout?: number
      ) => {
        if (timeout === TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS) {
          events.push("child-armed");
          return originalSetTimeout(() => {
            events.push("child-fired");
            handler();
          }, 0);
        }
        if (timeout === TASK_TERMINATION_STOP_STREAM_AGGREGATE_TIMEOUT_MS) {
          events.push("aggregate-armed");
          return originalSetTimeout(handler, 0);
        }
        return originalSetTimeout(handler, timeout);
      }) as typeof setTimeout);
      try {
        const interrupted = await taskService.terminateAllDescendantAgentTasks(rootId);
        expect(new Set(interrupted)).toEqual(new Set(hung));
        // Every descendant's stop is issued and its per-child deadline armed BEFORE the first
        // per-child deadline fires: the waits run concurrently under one aggregate deadline,
        // never chained one 20 s timeout after another.
        expect(stopStream).toHaveBeenCalledTimes(hung.length);
        const firstFired = events.indexOf("child-fired");
        expect(firstFired).toBeGreaterThan(0);
        expect(events.slice(0, firstFired).filter((e) => e === "child-armed").length).toBe(
          hung.length
        );
        expect(events.filter((e) => e === "aggregate-armed")).toHaveLength(1);
        for (const id of hung) {
          expect(findWorkspaceInConfig(config, id)?.taskStatus).toBe("interrupted");
          expect(taskService.isWorkspaceStopInProgress(id)).toBe(true);
        }
      } finally {
        spy.mockRestore();
      }
    });

    test("a latch releases only when the captured owner settled AND its cleanup finished, in either order", async () => {
      const childId = "task-owned";
      const { config } = await setupTree([childId]);
      const { stopStream, pending } = controlledStopStream(new Set([childId]));
      const { aiService } = createAIServiceMocks(config, { stopStream });
      // The child owns an admitted turn at capture; settlement arrives via the seam signal.
      const turnGeneration = Symbol("captured-turn");
      const turnSettledListeners = new Set<(workspaceId: string, turn: symbol) => void>();
      const { workspaceService } = createWorkspaceServiceMocks({
        getActiveTurnGeneration: mock(() => turnGeneration),
        onWorkspaceTurnSettled: mock((listener: (workspaceId: string, turn: symbol) => void) => {
          turnSettledListeners.add(listener);
          return () => turnSettledListeners.delete(listener);
        }),
      });
      const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
      const settleTurn = (turn: symbol) => {
        for (const listener of turnSettledListeners) listener(childId, turn);
      };
      const restoreTimers = shortenTerminationTimers();
      try {
        await taskService.terminateAllDescendantAgentTasks(rootId);
        expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("interrupted");
        // Persisted interrupted status alone is not evidence: owner unsettled, cleanup pending.
        expect(taskService.isWorkspaceStopInProgress(childId)).toBe(true);

        // Order 1: owner settles while cleanup is still pending → still latched.
        settleTurn(Symbol("unrelated-generation"));
        expect(taskService.isWorkspaceStopInProgress(childId)).toBe(true);
        settleTurn(turnGeneration);
        expect(taskService.isWorkspaceStopInProgress(childId)).toBe(true);
        // Cleanup's ORIGINAL promise settling rechecks and now releases.
        pending.get(childId)!.resolve(Ok(undefined));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(taskService.isWorkspaceStopInProgress(childId)).toBe(false);
      } finally {
        restoreTimers();
      }
    });

    test("cleanup settling before the owner keeps the latch until the owner's authoritative settlement", async () => {
      const childId = "task-owned-late";
      const { config } = await setupTree([childId]);
      const { stopStream, pending } = controlledStopStream(new Set([childId]));
      const { aiService } = createAIServiceMocks(config, { stopStream });
      const turnGeneration = Symbol("captured-turn");
      const turnSettledListeners = new Set<(workspaceId: string, turn: symbol) => void>();
      const { workspaceService } = createWorkspaceServiceMocks({
        getActiveTurnGeneration: mock(() => turnGeneration),
        onWorkspaceTurnSettled: mock((listener: (workspaceId: string, turn: symbol) => void) => {
          turnSettledListeners.add(listener);
          return () => turnSettledListeners.delete(listener);
        }),
      });
      const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
      const restoreTimers = shortenTerminationTimers();
      try {
        await taskService.terminateAllDescendantAgentTasks(rootId);
        expect(taskService.isWorkspaceStopInProgress(childId)).toBe(true);
        // Order 2: cleanup resolves (even with stop success) but the owner is still live.
        pending.get(childId)!.resolve(Ok(undefined));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(taskService.isWorkspaceStopInProgress(childId)).toBe(true);
        // Persisted-status callers merely recheck; they cannot manufacture evidence.
        (
          taskService as unknown as { releaseRetainedStopLatches: (id: string) => void }
        ).releaseRetainedStopLatches(childId);
        expect(taskService.isWorkspaceStopInProgress(childId)).toBe(true);
        for (const listener of turnSettledListeners) listener(childId, turnGeneration);
        expect(taskService.isWorkspaceStopInProgress(childId)).toBe(false);
      } finally {
        restoreTimers();
      }
    });

    test("stopping a subtree and terminating a subtree issue clearQueue/stopStream once per descendant outside the mutex", async () => {
      const childId = "task-subtree";
      const grandchildId = "task-subtree-leaf";
      const { config } = await setupTree([childId, { id: grandchildId, parent: childId }]);
      const { stopStream, pending } = controlledStopStream(new Set([grandchildId]));
      const isStreaming = mock(() => true);
      const { aiService } = createAIServiceMocks(config, { stopStream, isStreaming });
      const clearQueue = mock((_workspaceId: string): Result<void> => Ok(undefined));
      const { workspaceService } = createWorkspaceServiceMocks({ clearQueue });
      const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
      const restoreTimers = shortenTerminationTimers();
      try {
        const stopping = taskService.stopDescendantAgentTask(rootId, childId);
        await waitUntil(() => pending.has(grandchildId), "the hung grandchild stop to be issued");
        // Global mutex free while the grandchild's stop hangs.
        const lock = await taskService.acquireTaskCreationLock();
        await lock[Symbol.asyncDispose]();
        const stopped = await stopping;
        expect(stopped.success).toBe(true);
        expect(clearQueue.mock.calls.filter((call) => call[0] === grandchildId)).toHaveLength(1);
        expect(clearQueue.mock.calls.filter((call) => call[0] === childId)).toHaveLength(1);
        expect(stopStream.mock.calls.filter((call) => call[0] === grandchildId)).toHaveLength(1);
        expect(findWorkspaceInConfig(config, grandchildId)?.taskStatus).toBe("interrupted");
        expect(taskService.isWorkspaceStopInProgress(grandchildId)).toBe(true);
        pending.get(grandchildId)!.resolve(Ok(undefined));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(taskService.isWorkspaceStopInProgress(grandchildId)).toBe(false);
      } finally {
        restoreTimers();
      }
    });

    test("an owner settling while Phase A still holds config writes keeps the latch until the planned cleanup ran", async () => {
      const earlyId = "task-early";
      const lateId = "task-late";
      // Leaves interrupt first: the deeper descendant's status persists before its parent's.
      const { config } = await setupTree([lateId, { id: earlyId, parent: lateId }]);
      const { stopStream, pending } = controlledStopStream(new Set([earlyId, lateId]));
      const { aiService } = createAIServiceMocks(config, { stopStream });
      const turnByWorkspace = new Map([
        [earlyId, Symbol("early-turn")],
        [lateId, Symbol("late-turn")],
      ]);
      const turnSettledListeners = new Set<(workspaceId: string, turn: symbol) => void>();
      const clearQueue = mock((_workspaceId: string): Result<void> => Ok(undefined));
      const { workspaceService } = createWorkspaceServiceMocks({
        clearQueue,
        getActiveTurnGeneration: mock((workspaceId: string) => turnByWorkspace.get(workspaceId)),
        onWorkspaceTurnSettled: mock((listener: (workspaceId: string, turn: symbol) => void) => {
          turnSettledListeners.add(listener);
          return () => turnSettledListeners.delete(listener);
        }),
      });
      const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
      // Hold the SECOND descendant's status write open: the first descendant's status is already
      // persisted while Phase A is still inside the mutex, and its owner settles meanwhile.
      const gate = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const originalEdit = config.editConfig.bind(config);
      let heldOnce = false;
      const editSpy = spyOn(config, "editConfig").mockImplementation(async (mutator) => {
        // Hold the first config write that follows the early descendant's persisted status.
        if (!heldOnce && findWorkspaceInConfig(config, earlyId)?.taskStatus === "interrupted") {
          heldOnce = true;
          held.resolve();
          await gate.promise;
        }
        return await originalEdit(mutator);
      });
      const restoreTimers = shortenTerminationTimers();
      try {
        const teardown = taskService.terminateAllDescendantAgentTasks(rootId);
        await Promise.race([
          held.promise,
          teardown.then(() => {
            throw new Error("no config write was held after the early descendant persisted");
          }),
        ]);
        expect(findWorkspaceInConfig(config, earlyId)?.taskStatus).toBe("interrupted");
        expect(taskService.isWorkspaceStopInProgress(earlyId)).toBe(true);
        // Owner settled before the cascade ever issued its cleanup: the planned (not yet
        // started) cleanup still owns the latch, so new input cannot slip in ahead of the
        // unscoped clearQueue/stopStream.
        for (const listener of turnSettledListeners)
          listener(earlyId, turnByWorkspace.get(earlyId)!);
        expect(taskService.isWorkspaceStopInProgress(earlyId)).toBe(true);
        expect(clearQueue).not.toHaveBeenCalled();
        gate.resolve();
        editSpy.mockRestore();
        await teardown;
        expect(clearQueue.mock.calls.filter((call) => call[0] === earlyId)).toHaveLength(1);
        // Cleanup issued (pending stop) — still latched until its ORIGINAL promise settles.
        expect(pending.has(earlyId)).toBe(true);
        expect(taskService.isWorkspaceStopInProgress(earlyId)).toBe(true);
        pending.get(earlyId)!.resolve(Ok(undefined));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(taskService.isWorkspaceStopInProgress(earlyId)).toBe(false);
        // The late descendant's owner never settled: cleanup done or not, it stays latched.
        pending.get(lateId)!.resolve(Ok(undefined));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(taskService.isWorkspaceStopInProgress(lateId)).toBe(true);
      } finally {
        editSpy.mockRestore();
        restoreTimers();
      }
    });
    /** Remove a workspace entry from config on the cascade's FIRST config write (leaves first). */
    function removeEntryOnFirstConfigWrite(config: Config, workspaceId: string): () => void {
      const originalEdit = config.editConfig.bind(config);
      let removed = false;
      const editSpy = spyOn(config, "editConfig").mockImplementation(async (mutator) => {
        if (!removed) {
          removed = true;
          await originalEdit((cfg) => {
            for (const project of cfg.projects.values()) {
              project.workspaces = project.workspaces.filter((ws) => ws.id !== workspaceId);
            }
            return cfg;
          });
        }
        return await originalEdit(mutator);
      });
      return () => editSpy.mockRestore();
    }

    test.each(["stop", "terminate"] as const)(
      "a descendant removed between the subtree snapshot and its status write (%s) still releases only when its owner settled and cleanup finished",
      async (cascade) => {
        const childId = "task-vanished";
        const grandchildId = "task-vanished-leaf";
        const { config } = await setupTree([childId, { id: grandchildId, parent: childId }]);
        const { stopStream, pending } = controlledStopStream(new Set([childId]));
        const { aiService } = createAIServiceMocks(config, { stopStream });
        const childTurn = Symbol("child-turn");
        const turnSettledListeners = new Set<(workspaceId: string, turn: symbol) => void>();
        const { workspaceService } = createWorkspaceServiceMocks({
          getActiveTurnGeneration: mock((workspaceId: string) =>
            workspaceId === childId ? childTurn : undefined
          ),
          onWorkspaceTurnSettled: mock((listener: (workspaceId: string, turn: symbol) => void) => {
            turnSettledListeners.add(listener);
            return () => turnSettledListeners.delete(listener);
          }),
        });
        const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
        // The grandchild's status write is the cascade's first config write; the child vanishes
        // right before it, after the subtree (and its latches) were captured.
        const restoreEdit = removeEntryOnFirstConfigWrite(config, childId);
        const restoreTimers = shortenTerminationTimers();
        try {
          if (cascade === "stop") {
            const stopped = await taskService.stopDescendantAgentTask(rootId, childId);
            expect(stopped).toEqual({ success: true, data: { stoppedTaskIds: [grandchildId] } });
          } else {
            // The hung child stop is reported as a timeout (its workspace is kept in place).
            const terminated = await taskService.terminateDescendantAgentTask(rootId, childId);
            expect(terminated.success).toBe(false);
            if (!terminated.success) {
              expect(terminated.error).toContain(`Timed out stopping task stream (${childId})`);
            }
          }
          restoreEdit();
          expect(findWorkspaceInConfig(config, childId)).toBeUndefined();
          // No status was left to persist for the vanished child, yet its captured owner is
          // still live and its cleanup is pending: the latch must hold (no absent-config bypass).
          expect(stopStream.mock.calls.filter((call) => call[0] === childId)).toHaveLength(1);
          expect(taskService.isWorkspaceStopInProgress(childId)).toBe(true);
          for (const listener of turnSettledListeners) listener(childId, childTurn);
          expect(taskService.isWorkspaceStopInProgress(childId)).toBe(true);
          // ...and release once the owner settled AND the planned cleanup finished.
          pending.get(childId)!.resolve(Ok(undefined));
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(taskService.isWorkspaceStopInProgress(childId)).toBe(false);
        } finally {
          restoreEdit();
          restoreTimers();
        }
      }
    );

    test("a queued task is not reserved while its parent's stop latch is held and is picked up after release", async () => {
      const parentTaskId = "task-latched-parent";
      const queuedId = "task-queued-under-latched";
      const { config } = await setupTree([
        parentTaskId,
        {
          id: queuedId,
          parent: parentTaskId,
          overrides: {
            taskStatus: "queued",
            taskPrompt: "queued work",
            runtimeConfig: { type: "local" },
          },
        },
      ]);
      const { taskService } = createTaskServiceHarness(config);
      const launched: string[] = [];
      const internals = taskService as unknown as {
        startReservedAgentTask: (plan: { taskId: string }) => Promise<void>;
      };
      spyOn(internals, "startReservedAgentTask").mockImplementation((plan) => {
        launched.push(plan.taskId);
        return Promise.resolve();
      });
      const release = taskService.latchWorkspaceStopsInProgress([parentTaskId]);
      try {
        await taskService.maybeStartQueuedTasks();
        // Not even reserved: the record stays "queued" (a "starting" record would be stranded,
        // because the scheduler only ever selects queued ones).
        expect(findWorkspaceInConfig(config, queuedId)?.taskStatus).toBe("queued");
        expect(launched).toEqual([]);
      } finally {
        release();
      }
      await taskService.maybeStartQueuedTasks();
      expect(launched).toEqual([queuedId]);
      expect(findWorkspaceInConfig(config, queuedId)?.taskStatus).toBe("starting");
    });

    test.each(["before rollback", "after rollback"] as const)(
      "a deferred launch is re-picked when its stop latch releases %s",
      async (releaseAt) => {
        const parentTaskId = "task-spawning-parent";
        const spawnedId = "spawnedchild1";
        // The parent runs under a live execution mirror: createMany still admits its spawns after
        // Stop persisted "interrupted", until that execution settles — the realistic window for a
        // launch to meet the parent's held latch.
        const { config } = await setupTree([
          {
            id: parentTaskId,
            parent: rootId,
            overrides: { taskExecutionId: "exec-parent", taskExecutionStatus: "running" },
          },
        ]);
        // Persist the fixture's read-time migrations now. Otherwise a later metadata emit writes
        // them mid-test, and the rollback hold below can intercept that write instead.
        await config.getAllWorkspaceMetadata();
        stubStableIds(config, [spawnedId]);
        const { stopStream, pending } = controlledStopStream(new Set([parentTaskId]));
        const { aiService } = createAIServiceMocks(config, { stopStream });
        const { taskService } = createTaskServiceHarness(config, { aiService });
        const rollbackEntered = Promise.withResolvers<void>();
        const releaseRollback = Promise.withResolvers<void>();
        let holdRollback = releaseAt === "before rollback";
        const originalEditConfig = config.editConfig.bind(config);
        const editSpy = spyOn(config, "editConfig").mockImplementation(async (updater) => {
          if (holdRollback && findWorkspaceInConfig(config, spawnedId)?.taskStatus === "starting") {
            holdRollback = false;
            rollbackEntered.resolve();
            await releaseRollback.promise;
          }
          return originalEditConfig(updater);
        });
        const restoreTimers = shortenTerminationTimers();
        try {
          const teardown = taskService.terminateAllDescendantAgentTasks(rootId);
          await waitUntil(() => pending.has(parentTaskId), "the hung parent stop to be issued");
          expect(taskService.isWorkspaceStopInProgress(parentTaskId)).toBe(true);
          const spawned = await taskService.createMany([
            {
              parentWorkspaceId: parentTaskId,
              kind: "agent" as const,
              agentId: "explore",
              prompt: "spawned during stop",
              title: "Spawned",
            },
          ]);
          expect(spawned).toMatchObject({
            success: true,
            data: [{ taskId: spawnedId, status: "starting" }],
          });
          if (releaseAt === "before rollback") {
            await rollbackEntered.promise;
          } else {
            await waitUntil(
              () => findWorkspaceInConfig(config, spawnedId)?.taskStatus === "queued",
              "the deferred launch to hand its record back"
            );
          }
          const launched: string[] = [];
          const internals = taskService as unknown as {
            startReservedAgentTask: (plan: { taskId: string }) => Promise<void>;
          };
          spyOn(internals, "startReservedAgentTask").mockImplementation((plan) => {
            launched.push(plan.taskId);
            return Promise.resolve();
          });
          await teardown;
          expect(launched).toEqual([]);
          pending.get(parentTaskId)!.resolve(Ok(undefined));
          if (releaseAt === "before rollback") {
            await waitUntil(
              () => !taskService.isWorkspaceStopInProgress(parentTaskId),
              "the parent latch to release while rollback is blocked"
            );
            // The release-time drain sees only "starting" and cannot reserve it. Publishing the
            // later rollback must finish the handoff without needing another scheduler trigger.
            await taskService.maybeStartQueuedTasks();
            expect(findWorkspaceInConfig(config, spawnedId)?.taskStatus).toBe("starting");
            expect(launched).toEqual([]);
            releaseRollback.resolve();
          }
          await waitUntil(
            () => launched.includes(spawnedId),
            "the released launch to be re-picked"
          );
          expect(taskService.isWorkspaceStopInProgress(parentTaskId)).toBe(false);
          expect(findWorkspaceInConfig(config, spawnedId)?.taskStatus).toBe("starting");
        } finally {
          releaseRollback.resolve();
          editSpy.mockRestore();
          restoreTimers();
        }
      }
    );
  });

  describe("attempt outcome and settlement", () => {
    const requesting = { requestingWorkspaceId: rootId };

    async function persistReport(
      config: Config,
      ownerId: string,
      taskId: string,
      markdown: string
    ) {
      await upsertSubagentReportArtifact({
        workspaceId: ownerId,
        workspaceSessionDir: path.join(config.sessionsDir, ownerId),
        childTaskId: taskId,
        parentWorkspaceId: ownerId,
        ancestorWorkspaceIds: [ownerId],
        reportMarkdown: markdown,
        nowMs: Date.now(),
      });
    }

    test("a persisted report wins regardless of config status or a held latch", async () => {
      const taskId = "task-outcome-reported";
      const { config } = await setupTree([
        { id: taskId, parent: rootId, overrides: { taskStatus: "interrupted" } },
      ]);
      await persistReport(config, rootId, taskId, "final answer");
      const { taskService } = createTaskServiceHarness(config);
      // Legacy interrupted config, no owner — the report still decides.
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toMatchObject({
        kind: "reported",
        report: { reportMarkdown: "final answer" },
      });
      // The requesting workspace scopes the artifact read (no scan over all parents): a fresh
      // process asked by an unrelated requester learns nothing.
      const { taskService: unrelatedService } = createTaskServiceHarness(config);
      expect(
        await unrelatedService.readAttemptOutcome(taskId, {
          requestingWorkspaceId: unrelatedParentId,
        })
      ).toMatchObject({ kind: "indeterminate" });
    });

    test("an unreadable report artifact is indeterminate, never positive absence", async () => {
      const taskId = "task-outcome-corrupt";
      const { config } = await setupTree([
        { id: taskId, parent: rootId, overrides: { taskStatus: "interrupted" } },
      ]);
      const reportPath = getSubagentReportArtifactPath(
        path.join(config.sessionsDir, rootId),
        taskId
      );
      await fsPromises.mkdir(path.dirname(reportPath), { recursive: true });
      await fsPromises.writeFile(reportPath, "{ corrupt");
      const { taskService } = createTaskServiceHarness(config);
      const outcome = await taskService.readAttemptOutcome(taskId, requesting);
      expect(outcome.kind).toBe("indeterminate");
      if (outcome.kind === "indeterminate") expect(outcome.reason).toContain("unreadable");
    });

    test("a current-generation preparing turn is live even with interrupted config and no registered stream", async () => {
      const taskId = "task-outcome-preparing";
      const { config } = await setupTree([
        { id: taskId, parent: rootId, overrides: { taskStatus: "interrupted" } },
      ]);
      const { workspaceService } = createWorkspaceServiceMocks({
        getActiveTurnGeneration: mock((workspaceId: string) =>
          workspaceId === taskId ? Symbol("preparing") : undefined
        ),
      });
      const { taskService } = createTaskServiceHarness(config, { workspaceService });
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
        kind: "live",
        executionId: taskId,
      });
    });

    test("paired: an owned reservation is live while the identical config loaded as legacy is indeterminate", async () => {
      const spawnedId = "ownedchild01";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      const { taskService } = createTaskServiceHarness(config);
      const internals = taskService as unknown as {
        startReservedAgentTask: (plan: { taskId: string }) => Promise<void>;
      };
      // Hold the launch so the reservation stays "starting" without any stream or turn.
      const launchGate = Promise.withResolvers<void>();
      spyOn(internals, "startReservedAgentTask").mockImplementation(() => launchGate.promise);
      const created = await taskService.createMany([
        {
          parentWorkspaceId: rootId,
          kind: "agent" as const,
          agentId: "explore",
          prompt: "owned work",
          title: "Owned",
        },
      ]);
      expect(created).toMatchObject({
        success: true,
        data: [{ taskId: spawnedId, status: "starting" }],
      });
      expect(await taskService.readAttemptOutcome(spawnedId, requesting)).toEqual({
        kind: "live",
        executionId: spawnedId,
      });
      launchGate.resolve();

      // Same persisted record, fresh process: nobody in this process owns the attempt.
      const { taskService: legacyService } = createTaskServiceHarness(config);
      const legacy = await legacyService.readAttemptOutcome(spawnedId, requesting);
      expect(legacy.kind).toBe("indeterminate");
      if (legacy.kind === "indeterminate") expect(legacy.reason).toContain("starting");
    });

    test("stopping an owned attempt is cleanup-pending until its latch settles, then terminal-no-report", async () => {
      const taskId = "task-outcome-owned-stop";
      const { config } = await setupTree([
        { id: taskId, parent: rootId, overrides: { taskStatus: "interrupted" } },
      ]);
      const { stopStream, pending } = controlledStopStream(new Set([taskId]));
      const { aiService } = createAIServiceMocks(config, { stopStream });
      const { taskService } = createTaskServiceHarness(config, { aiService });
      const restoreTimers = shortenTerminationTimers();
      try {
        // Reawakening in this process makes the attempt owned (status running, no stream yet).
        expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
        expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
          kind: "live",
          executionId: taskId,
        });
        await taskService.terminateAllDescendantAgentTasks(rootId);
        expect(findWorkspaceInConfig(config, taskId)?.taskStatus).toBe("interrupted");
        expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
          kind: "cleanup-pending",
        });
        pending.get(taskId)!.resolve(Ok(undefined));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(false);
        expect(await taskService.readAttemptOutcome(taskId, requesting)).toMatchObject({
          kind: "terminal-no-report",
        });
      } finally {
        restoreTimers();
      }
    });

    test("paired: stopping an unknown legacy attempt settles its latch but never proves retirement", async () => {
      const taskId = "task-outcome-legacy-stop";
      const { config } = await setupTree([taskId]);
      const { stopStream, pending } = controlledStopStream(new Set([taskId]));
      const { aiService } = createAIServiceMocks(config, { stopStream });
      const { taskService } = createTaskServiceHarness(config, { aiService });
      const restoreTimers = shortenTerminationTimers();
      try {
        // Legacy "running" config with no proven admission in this process.
        const before = await taskService.readAttemptOutcome(taskId, requesting);
        expect(before.kind).toBe("indeterminate");
        await taskService.terminateAllDescendantAgentTasks(rootId);
        expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
          kind: "cleanup-pending",
        });
        pending.get(taskId)!.resolve(Ok(undefined));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(false);
        const after = await taskService.readAttemptOutcome(taskId, requesting);
        expect(after.kind).toBe("indeterminate");
      } finally {
        restoreTimers();
      }
    });

    test("a settlement is bound to its attempt: reawakening invalidates it before new admission", async () => {
      const taskId = "task-outcome-rebound";
      const { config } = await setupTree([
        { id: taskId, parent: rootId, overrides: { taskStatus: "interrupted" } },
      ]);
      const { taskService } = createTaskServiceHarness(config);
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      await taskService.terminateAllDescendantAgentTasks(rootId);
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toMatchObject({
        kind: "terminal-no-report",
      });
      // A new attempt starts: the old settlement must not leak into it...
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
        kind: "live",
        executionId: taskId,
      });
      // ...so a status write without any owner settlement is indeterminate, not retired.
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const ws = project.workspaces.find((entry) => entry.id === taskId);
          if (ws) ws.taskStatus = "interrupted";
        }
        return cfg;
      });
      expect((await taskService.readAttemptOutcome(taskId, requesting)).kind).toBe("indeterminate");
    });

    test("failed reactivation keeps its published attempt: indeterminate until a Stop settles it", async () => {
      const taskId = "task-outcome-reactivation-failed";
      const { config } = await setupTree([
        {
          id: taskId,
          parent: rootId,
          // Project-dir runtime: reach createWorkspaceTurn instead of the missing-checkout preflight.
          overrides: { taskStatus: "interrupted", runtimeConfig: { type: "local" } },
        },
      ]);
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService, aiService } = createTaskServiceHarness(config, { workspaceService });
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      await taskService.terminateAllDescendantAgentTasks(rootId);
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toMatchObject({
        kind: "terminal-no-report",
      });
      const retiredAttemptId = findWorkspaceInConfig(config, taskId)?.taskAttemptId;
      expect(retiredAttemptId).toMatch(/^att_[0-9a-f]{16}$/);

      // A real createWorkspaceTurn failure AFTER the reactivation published its fresh attempt.
      // createWorkspaceTurn can fail past validation (even after a send), so a refusal proves
      // nothing about admission: the fresh identity stays in config and memory (never rolled
      // back to the retired attempt), reads as owned-but-unsettled, and only a Stop settles it.
      const metadata = spyOn(aiService, "getWorkspaceMetadata").mockResolvedValueOnce(
        Err("owner metadata unavailable")
      );
      try {
        const result = await taskService.sendMessageToDescendantAgentTask(
          rootId,
          taskId,
          "Try again",
          "tool-end"
        );
        expect(result).toMatchObject({ success: false, error: { code: "send_failed" } });
        expect(sendMessage).not.toHaveBeenCalled();
        const published = findWorkspaceInConfig(config, taskId)?.taskAttemptId;
        expect(published).toMatch(/^att_[0-9a-f]{16}$/);
        expect(published).not.toBe(retiredAttemptId);
        const outcome = await taskService.readAttemptOutcome(taskId, requesting);
        expect(outcome.kind).toBe("indeterminate");
        if (outcome.kind === "indeterminate") {
          expect(outcome.reason).toContain("without settlement evidence");
        }
        await taskService.terminateAllDescendantAgentTasks(rootId);
        expect(await taskService.readAttemptOutcome(taskId, requesting)).toMatchObject({
          kind: "terminal-no-report",
        });
        expect(findWorkspaceInConfig(config, taskId)?.taskAttemptId).toBe(published);
      } finally {
        metadata.mockRestore();
      }
    });

    test("failed reactivation of a legacy owner publishes an unproven attempt this process owns", async () => {
      const taskId = "task-outcome-reactivation-legacy";
      const { config } = await setupTree([
        {
          id: taskId,
          parent: rootId,
          // Project-dir runtime: reach createWorkspaceTurn instead of the missing-checkout preflight.
          overrides: { taskStatus: "interrupted", runtimeConfig: { type: "local" } },
        },
      ]);
      const { taskService, aiService } = createTaskServiceHarness(config);
      expect(findWorkspaceInConfig(config, taskId)?.taskAttemptId).toBeUndefined();
      const metadata = spyOn(aiService, "getWorkspaceMetadata").mockResolvedValueOnce(
        Err("owner metadata unavailable")
      );
      try {
        expect(
          await taskService.sendMessageToDescendantAgentTask(
            rootId,
            taskId,
            "Try again",
            "tool-end"
          )
        ).toMatchObject({ success: false, error: { code: "send_failed" } });
        // The reactivation stamped the pre-identity entry with a fresh attempt this process owns
        // — marked unproven, because nothing vouches for the unknown prior-process predecessor.
        const entry = findWorkspaceInConfig(config, taskId);
        expect(entry?.taskAttemptId).toMatch(/^att_[0-9a-f]{16}$/);
        expect(entry?.taskAttemptUnproven).toBe(true);
        expect((await taskService.readAttemptOutcome(taskId, requesting)).kind).toBe(
          "indeterminate"
        );
        // A Stop settles THIS process's attempt (same-process authority, as on main for any
        // owned attempt); cross-process authority stays fail-closed through the marker.
        await taskService.terminateAllDescendantAgentTasks(rootId);
        expect(await taskService.readAttemptOutcome(taskId, requesting)).toMatchObject({
          kind: "terminal-no-report",
        });
        const owned = (
          taskService as unknown as {
            ownedAttemptByTaskId: Map<string, { attemptId?: string; receiptEligible: boolean }>;
          }
        ).ownedAttemptByTaskId.get(taskId);
        expect(owned?.attemptId).toBe(entry?.taskAttemptId);
        expect(owned?.receiptEligible).toBe(false);
      } finally {
        metadata.mockRestore();
      }
    });

    test("failed reactivation leaves a concurrently reawakened attempt owned", async () => {
      const taskId = "task-outcome-reactivation-superseded";
      const { config } = await setupTree([
        {
          id: taskId,
          parent: rootId,
          // Project-dir runtime: reach createWorkspaceTurn instead of the missing-checkout preflight.
          overrides: { taskStatus: "interrupted", runtimeConfig: { type: "local" } },
        },
      ]);
      const { taskService, aiService } = createTaskServiceHarness(config);
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      await taskService.terminateAllDescendantAgentTasks(rootId);
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toMatchObject({
        kind: "terminal-no-report",
      });
      let reawaken: Promise<boolean> | undefined;
      const metadata = spyOn(aiService, "getWorkspaceMetadata").mockImplementationOnce(() => {
        // Direct input can reawaken while the rejected task send is awaiting metadata. Its
        // identity CAS serializes on the task-creation lock createWorkspaceTurn holds here, so
        // it completes right after the rejected send releases it.
        reawaken = taskService.markInterruptedTaskRunning(taskId);
        return Promise.resolve(Err("owner metadata unavailable"));
      });
      try {
        expect(
          await taskService.sendMessageToDescendantAgentTask(
            rootId,
            taskId,
            "Try again",
            "tool-end"
          )
        ).toMatchObject({ success: false, error: { code: "send_failed" } });
        expect(await reawaken).toBe(true);
        expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
          kind: "live",
          executionId: taskId,
        });
      } finally {
        metadata.mockRestore();
      }
    });

    test("a launch that fails in this process settles its owned attempt", async () => {
      const spawnedId = "failedchild01";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      const { taskService } = createTaskServiceHarness(config);
      const internals = taskService as unknown as {
        startReservedAgentTask: (plan: { taskId: string }) => Promise<void>;
      };
      spyOn(internals, "startReservedAgentTask").mockImplementation(() =>
        Promise.reject(new Error("fork failed"))
      );
      const created = await taskService.createMany([
        {
          parentWorkspaceId: rootId,
          kind: "agent" as const,
          agentId: "explore",
          prompt: "doomed",
          title: "Doomed",
        },
      ]);
      expect(created.success).toBe(true);
      await waitUntil(
        () => findWorkspaceInConfig(config, spawnedId)?.taskStatus === "interrupted",
        "the failed launch to persist"
      );
      expect(findWorkspaceInConfig(config, spawnedId)?.taskLaunchError).toBe("fork failed");
      await waitForOutcomeKind(taskService, spawnedId, "terminal-no-report");
    });

    test("waitForAttemptSettlement subscribes before re-reading, releases the lock while waiting, and observes a settlement landing mid-read", async () => {
      const taskId = "task-settle-race";
      const { config } = await setupTree([
        { id: taskId, parent: rootId, overrides: { taskStatus: "interrupted" } },
      ]);
      const { stopStream, pending } = controlledStopStream(new Set([taskId]));
      const { aiService } = createAIServiceMocks(config, { stopStream });
      const { taskService } = createTaskServiceHarness(config, { aiService });
      const restoreTimers = shortenTerminationTimers();
      try {
        expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
        await taskService.terminateAllDescendantAgentTasks(rootId);
        const internals = taskService as unknown as {
          inspectAttemptOutcome: (taskId: string, options: unknown) => Promise<unknown>;
          workspaceEventLocks: { withLock: <T>(key: string, op: () => Promise<T>) => Promise<T> };
        };
        const realInspect = internals.inspectAttemptOutcome.bind(taskService);
        // The first (locked) read is stale: the settlement lands while it runs, after the
        // subscription was installed.
        spyOn(internals, "inspectAttemptOutcome").mockImplementationOnce(async () => {
          pending.get(taskId)!.resolve(Ok(undefined));
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(false);
          return { kind: "cleanup-pending" };
        });
        const settled = await taskService.waitForAttemptSettlement(taskId, {
          timeoutMs: 5_000,
          ...requesting,
        });
        expect(settled).toMatchObject({ kind: "terminal-no-report" });
        expect(await realInspect(taskId, requesting)).toMatchObject({ kind: "terminal-no-report" });
        // The lock is free while a waiter is pending (the wait below is bounded by its timeout).
        const lockProbe = await internals.workspaceEventLocks.withLock(taskId, () =>
          Promise.resolve("acquired")
        );
        expect(lockProbe).toBe("acquired");
      } finally {
        restoreTimers();
      }
    });

    test("waitForAttemptSettlement stays bounded while the task's event lock is held", async () => {
      const taskId = "task-settle-locked";
      const { config } = await setupTree([
        { id: taskId, parent: rootId, overrides: { taskStatus: "interrupted" } },
      ]);
      const { taskService } = createTaskServiceHarness(config);
      const internals = taskService as unknown as {
        inspectAttemptOutcome: (taskId: string, options: unknown) => Promise<unknown>;
        workspaceEventLocks: { withLock: <T>(key: string, op: () => Promise<T>) => Promise<T> };
        attemptSettlementListenersByTaskId: Map<string, Set<unknown>>;
      };
      const inspect = spyOn(internals, "inspectAttemptOutcome");
      const gate = Promise.withResolvers<void>();
      // A publication (or any handler) holds the lock for longer than the caller's bound.
      const holding = internals.workspaceEventLocks.withLock(taskId, () => gate.promise);
      const timedOut = await taskService.waitForAttemptSettlement(taskId, {
        timeoutMs: 20,
        ...requesting,
      });
      expect(timedOut).toEqual({ kind: "timeout" });
      const controller = new AbortController();
      const aborted = taskService.waitForAttemptSettlement(taskId, {
        timeoutMs: 5_000,
        abortSignal: controller.signal,
        ...requesting,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      expect(
        await aborted.then(
          () => null,
          (error: unknown) => error
        )
      ).toBeInstanceOf(Error);
      // Nothing ran under the lock for the abandoned waits.
      expect(inspect).not.toHaveBeenCalled();
      gate.resolve();
      await holding;
      await new Promise((resolve) => setTimeout(resolve, 5));
      // Late acquisitions are no-ops: no read, no leaked subscription.
      expect(inspect).not.toHaveBeenCalled();
      expect(internals.attemptSettlementListenersByTaskId.get(taskId)?.size ?? 0).toBe(0);
      // The lock is usable again and a normal read works.
      expect((await taskService.readAttemptOutcome(taskId, requesting)).kind).toBe("indeterminate");
    });

    test("waitForAttemptSettlement returns timeout for pending cleanup, rejects on abort, and returns indeterminate immediately", async () => {
      const taskId = "task-settle-bounds";
      const legacyId = "task-settle-legacy";
      const { config } = await setupTree([
        { id: taskId, parent: rootId, overrides: { taskStatus: "interrupted" } },
        { id: legacyId, parent: rootId, overrides: { taskStatus: "interrupted" } },
      ]);
      const { stopStream, pending } = controlledStopStream(new Set([taskId]));
      const { aiService } = createAIServiceMocks(config, { stopStream });
      const { taskService } = createTaskServiceHarness(config, { aiService });
      const restoreTimers = shortenTerminationTimers();
      try {
        expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
        await taskService.stopDescendantAgentTask(rootId, taskId);
        expect(pending.has(taskId)).toBe(true);
        expect(
          await taskService.waitForAttemptSettlement(taskId, { timeoutMs: 20, ...requesting })
        ).toEqual({ kind: "timeout" });
        const controller = new AbortController();
        const aborted = taskService.waitForAttemptSettlement(taskId, {
          timeoutMs: 5_000,
          abortSignal: controller.signal,
          ...requesting,
        });
        controller.abort();
        expect(
          await aborted.then(
            () => null,
            (error: unknown) => error
          )
        ).toBeInstanceOf(Error);
        // Unknown owner: no wait at all, the caller must not pin a lease on it.
        const started = Date.now();
        expect(
          (
            await taskService.waitForAttemptSettlement(legacyId, {
              timeoutMs: 5_000,
              ...requesting,
            })
          ).kind
        ).toBe("indeterminate");
        expect(Date.now() - started).toBeLessThan(1_000);
        // Settlement while a waiter is pending resolves it with the settled outcome.
        const waiting = taskService.waitForAttemptSettlement(taskId, {
          timeoutMs: 5_000,
          ...requesting,
        });
        pending.get(taskId)!.resolve(Ok(undefined));
        expect(await waiting).toMatchObject({ kind: "terminal-no-report" });
        // Subscriptions do not leak past the wait.
        const listeners = (
          taskService as unknown as {
            attemptSettlementListenersByTaskId: Map<string, Set<unknown>>;
          }
        ).attemptSettlementListenersByTaskId;
        expect(listeners.get(taskId)?.size ?? 0).toBe(0);
        expect(listeners.get(legacyId)?.size ?? 0).toBe(0);
      } finally {
        restoreTimers();
      }
    });

    interface AttemptLedgerInternals {
      ownedAttemptByTaskId: Map<string, { generation: number }>;
      attemptSettlementByTaskId: Map<string, { attempt: { generation: number } }>;
      completedReportsByTaskId: Map<string, unknown>;
      shouldAllowLegacyInvalidWorkflowOutputSchema: (...args: unknown[]) => Promise<boolean>;
    }
    const ledgerInternals = (taskService: TaskService) =>
      taskService as unknown as AttemptLedgerInternals;

    function reportStreamEnd(taskId: string, reportMarkdown: string): StreamEndEvent {
      return {
        type: "stream-end",
        workspaceId: taskId,
        messageId: `assistant-${taskId}`,
        metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: `agent-report-${taskId}`,
            toolName: "agent_report",
            input: { reportMarkdown },
            state: "output-available",
            output: { success: true },
          },
          { type: "text", text: reportMarkdown },
        ],
      };
    }

    test.each(["running", "interrupted"] as const)(
      "publishing the owned attempt's report drops its ledger entries (%s at stream end); the durable report still decides",
      async (statusAtStreamEnd) => {
        const taskId = `task-outcome-published-${statusAtStreamEnd}`;
        const { config } = await setupTree([
          { id: taskId, parent: rootId, overrides: { taskStatus: "interrupted" } },
        ]);
        const { taskService } = createTaskServiceHarness(config);
        const internals = ledgerInternals(taskService);
        expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
        const attempt = internals.ownedAttemptByTaskId.get(taskId);
        expect(attempt).toBeDefined();
        if (statusAtStreamEnd === "interrupted") {
          // Stopped before its stream ended: the no-report receipt is retained until the report
          // that follows makes it redundant.
          await taskService.terminateAllDescendantAgentTasks(rootId);
          expect(internals.attemptSettlementByTaskId.get(taskId)?.attempt).toBe(attempt);
          expect(await taskService.readAttemptOutcome(taskId, requesting)).toMatchObject({
            kind: "terminal-no-report",
          });
        }

        await streamEnd(taskService, reportStreamEnd(taskId, "final answer"));

        expect(findWorkspaceInConfig(config, taskId)?.taskStatus).toBe("reported");
        expect(internals.ownedAttemptByTaskId.has(taskId)).toBe(false);
        expect(internals.attemptSettlementByTaskId.has(taskId)).toBe(false);
        const reported = { kind: "reported", report: { reportMarkdown: "final answer" } };
        expect(await taskService.readAttemptOutcome(taskId, requesting)).toMatchObject(reported);
        // Not just the in-memory cache: the persisted artifact answers, here and in a fresh process.
        internals.completedReportsByTaskId.clear();
        expect(await taskService.readAttemptOutcome(taskId, requesting)).toMatchObject(reported);
        const { taskService: freshService } = createTaskServiceHarness(config);
        expect(await freshService.readAttemptOutcome(taskId, requesting)).toMatchObject(reported);
      }
    );

    test.each([
      ["before publication", "reawakened"],
      ["inside publication", "reawakened"],
      ["inside publication", "not reawakened (control)"],
    ] as const)(
      "an older report blocked %s, attempt %s: it publishes only onto its own attempt's row",
      async (blockPoint, successor) => {
        const taskId = `task-outcome-survive-${blockPoint.replace(" ", "-")}-${successor === "reawakened" ? "r" : "c"}`;
        const { config } = await setupTree([
          { id: taskId, parent: rootId, overrides: { taskStatus: "interrupted" } },
        ]);
        const { taskService } = createTaskServiceHarness(config);
        const internals = ledgerInternals(taskService);
        expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
        await taskService.terminateAllDescendantAgentTasks(rootId);
        const firstAttempt = internals.ownedAttemptByTaskId.get(taskId);
        expect(firstAttempt).toBeDefined();

        const blocked = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let restore: () => void;
        if (blockPoint === "before publication") {
          // The last await finalizeAgentTaskReport takes before publishAgentTaskReport starts.
          const original = internals.shouldAllowLegacyInvalidWorkflowOutputSchema.bind(taskService);
          const spy = spyOn(
            internals,
            "shouldAllowLegacyInvalidWorkflowOutputSchema"
          ).mockImplementationOnce(async (...args: unknown[]) => {
            blocked.resolve();
            await release.promise;
            return original(...args);
          });
          restore = () => spy.mockRestore();
        } else {
          // The publication's own first write (its status flip to "reported"), held before it lands.
          const originalEditConfig = config.editConfig.bind(config);
          let held = false;
          const spy = spyOn(config, "editConfig").mockImplementation(async (updater) => {
            if (!held) {
              const probe = updater(structuredClone(config.loadConfigOrDefault()));
              const probed = Array.from(probe.projects.values())
                .flatMap((project) => project.workspaces)
                .find((workspace) => workspace.id === taskId);
              if (probed?.taskStatus === "reported") {
                held = true;
                blocked.resolve();
                await release.promise;
              }
            }
            return originalEditConfig(updater);
          });
          restore = () => spy.mockRestore();
        }
        try {
          const publication = streamEnd(taskService, reportStreamEnd(taskId, "older report"));
          await blocked.promise;
          if (successor !== "reawakened") {
            // Control: nothing replaced the attempt, so its own late report still completes it.
            release.resolve();
            await publication;
            expect(findWorkspaceInConfig(config, taskId)?.taskStatus).toBe("reported");
            expect(
              await readSubagentReportArtifact(path.join(config.sessionsDir, rootId), taskId)
            ).not.toBeNull();
            return;
          }
          // The user resumes the (still interrupted) task while the older report is in flight.
          expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
          const secondAttempt = internals.ownedAttemptByTaskId.get(taskId);
          const secondAttemptId = findWorkspaceInConfig(config, taskId)?.taskAttemptId;
          expect(secondAttempt).toBeDefined();
          expect(secondAttempt).not.toBe(firstAttempt);
          // A parent awaits the resumed task by its stable id: B's waiter.
          let waiterOutcome: string | undefined;
          void taskService
            .waitForAgentReport(taskId, { timeoutMs: 3_000, requestingWorkspaceId: rootId })
            .then(
              () => {
                waiterOutcome = "resolved";
              },
              (error: unknown) => {
                waiterOutcome = error instanceof Error ? error.message : String(error);
              }
            );
          release.resolve();
          await publication;

          // A report publishes only onto its own attempt's row (the publication is a CAS on the
          // stream's attempt): the successor admitted meanwhile keeps running, stays owned, and
          // no artifact of the older report is published for it.
          expect(findWorkspaceInConfig(config, taskId)).toMatchObject({
            taskStatus: "running",
            taskAttemptId: secondAttemptId,
          });
          expect(waiterOutcome).toBeUndefined();
          expect(internals.ownedAttemptByTaskId.get(taskId)).toBe(secondAttempt);
          expect(
            await readSubagentReportArtifact(path.join(config.sessionsDir, rootId), taskId)
          ).toBeNull();
        } finally {
          release.resolve();
          restore();
        }
      }
    );

    test("a report whose artifact could not be persisted keeps the attempt's ledger entries", async () => {
      const taskId = "task-outcome-unpersisted";
      const { config } = await setupTree([
        { id: taskId, parent: rootId, overrides: { taskStatus: "interrupted" } },
      ]);
      // A directory where the report body must be written fails the ancestor artifact write.
      await fsPromises.mkdir(
        getSubagentReportArtifactPath(path.join(config.sessionsDir, rootId), taskId),
        { recursive: true }
      );
      const { taskService } = createTaskServiceHarness(config);
      const internals = ledgerInternals(taskService);
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      const attempt = internals.ownedAttemptByTaskId.get(taskId);
      expect(attempt).toBeDefined();

      await streamEnd(taskService, reportStreamEnd(taskId, "lost report"));

      expect(findWorkspaceInConfig(config, taskId)?.taskStatus).toBe("reported");
      expect(internals.ownedAttemptByTaskId.get(taskId)).toBe(attempt);
      // A fresh process has no durable report to classify from.
      const { taskService: freshService } = createTaskServiceHarness(config);
      expect((await freshService.readAttemptOutcome(taskId, requesting)).kind).toBe(
        "indeterminate"
      );
    });

    test("a stream end without a report leaves the interrupted attempt's receipt in place", async () => {
      const taskId = "task-outcome-no-report-end";
      const { config } = await setupTree([
        { id: taskId, parent: rootId, overrides: { taskStatus: "interrupted" } },
      ]);
      const { taskService } = createTaskServiceHarness(config);
      const internals = ledgerInternals(taskService);
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      await taskService.terminateAllDescendantAgentTasks(rootId);
      const attempt = internals.ownedAttemptByTaskId.get(taskId);
      expect(attempt).toBeDefined();

      // Cut short by the stop: no explicit `stop` finish, so nothing is promoted to a report.
      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: taskId,
        messageId: `assistant-${taskId}`,
        metadata: { model: "openai:gpt-5.2", finishReason: "abort" },
        parts: [{ type: "text", text: "stopped before reporting" }],
      });

      expect(findWorkspaceInConfig(config, taskId)?.taskStatus).toBe("interrupted");
      expect(internals.ownedAttemptByTaskId.get(taskId)).toBe(attempt);
      expect(internals.attemptSettlementByTaskId.get(taskId)?.attempt).toBe(attempt);
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toMatchObject({
        kind: "terminal-no-report",
      });
    });
  });

  describe("cancellable reservation", () => {
    const spawnArgs = (parentWorkspaceId: string) => ({
      parentWorkspaceId,
      kind: "agent" as const,
      agentId: "explore",
      prompt: "cancellable work",
      title: "Cancellable",
    });
    const configSnapshot = (config: Config) => {
      const snapshot = config.loadConfigOrDefault();
      // JSON.stringify alone drops Map entries and hides metadata migration writes.
      return JSON.stringify({ ...snapshot, projects: [...snapshot.projects] });
    };
    const taskRecordCount = (config: Config) =>
      [...config.loadConfigOrDefault().projects.values()].flatMap((project) =>
        project.workspaces.filter((ws) => ws.parentWorkspaceId != null)
      ).length;

    /** The harness default metadata lookup with a hook run before/after the real read. */
    const metadataMock = (
      config: Config,
      hooks: { before?: () => void; after?: () => Promise<void> | void }
    ) =>
      mock(
        async (
          workspaceId: string,
          options?: Pick<WorkspaceMetadataOptions, "persistMigrations">
        ): Promise<Result<WorkspaceMetadata>> => {
          hooks.before?.();
          const found = await config.getWorkspaceMetadataById(workspaceId, options);
          await hooks.after?.();
          return found ? Ok(found) : Err("not found");
        }
      );
    /** Metadata reads where exactly the Nth call (1-based) blocks on a gate, like a stalled SSH read. */
    const heldMetadataMock = (config: Config, holdCall: number) => {
      const gate = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      let calls = 0;
      const read = mock(
        async (
          workspaceId: string,
          options?: Pick<WorkspaceMetadataOptions, "persistMigrations">
        ): Promise<Result<WorkspaceMetadata>> => {
          calls += 1;
          if (calls === holdCall) {
            held.resolve();
            await gate.promise;
          }
          const found = await config.getWorkspaceMetadataById(workspaceId, options);
          return found ? Ok(found) : Err("not found");
        }
      );
      return { read, gate, held: held.promise, calls: () => calls };
    };
    interface Internals {
      startReservedAgentTask: (plan: { taskId: string }) => Promise<void>;
      materializeReservedTaskWorkspace: (...args: unknown[]) => Promise<unknown>;
      cleanupMaterializedTaskWorkspace: (...args: unknown[]) => Promise<void>;
    }

    test("abort while blocked on the global mutex returns promptly, leaves config untouched and releases the late acquisition", async () => {
      const { config } = await setupTree([]);
      const { taskService } = createTaskServiceHarness(config);
      const before = configSnapshot(config);
      const warned: unknown[][] = [];
      const warnSpy = spyOn(log, "warn").mockImplementation((...args: unknown[]) => {
        warned.push(args);
      });
      const originalSetTimeout = globalThis.setTimeout;
      // Capture the stall warning instead of waiting 30 s; fired by hand once the mutex blocks.
      let warningHandler: (() => void) | undefined;
      const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
        handler: () => void,
        timeout?: number
      ) => {
        if (timeout === TASK_CREATE_WAIT_WARNING_MS) {
          warningHandler = handler;
          return originalSetTimeout(() => undefined, 0);
        }
        return originalSetTimeout(handler, timeout);
      }) as typeof setTimeout);
      const mutexQueue = (taskService as unknown as { mutex: { queue: unknown[] } }).mutex.queue;
      const held = await taskService.acquireTaskCreationLock();
      try {
        const controller = new AbortController();
        const creating = taskService.createMany([spawnArgs(rootId)], {
          abortSignal: controller.signal,
        });
        await waitUntil(() => mutexQueue.length > 0, "the reservation to block on the mutex");
        warningHandler?.();
        expect(
          warned.some(
            (args) =>
              String(args[0]).includes("[task-create]") &&
              (args[1] as { stage?: string } | undefined)?.stage === "mutex"
          )
        ).toBe(true);
        controller.abort();
        const result = await creating;
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toMatch(/^Interrupted/);
          expect(result.error).toContain("mutex");
          expect(result.error).not.toBe("Task interrupted");
        }
      } finally {
        await held[Symbol.asyncDispose]();
        timerSpy.mockRestore();
        warnSpy.mockRestore();
      }
      // The late acquisition released the mutex without doing work.
      const reacquired = await taskService.acquireTaskCreationLock();
      await reacquired[Symbol.asyncDispose]();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(configSnapshot(config)).toBe(before);
    });

    test("abort while blocked on the tree lifecycle lock returns promptly and the late callback is a no-op", async () => {
      const { config } = await setupTree([]);
      const { taskService } = createTaskServiceHarness(config);
      const before = configSnapshot(config);
      const gate = Promise.withResolvers<void>();
      const holding = taskService.withTaskTreeLifecycleLock(rootId, () => gate.promise);
      const controller = new AbortController();
      const creating = taskService.createMany([spawnArgs(rootId)], {
        abortSignal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      const result = await creating;
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("tree-lock");
      gate.resolve();
      await holding;
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(configSnapshot(config)).toBe(before);
    });

    test("abort during read-only preparation discards the late result without touching config or locks", async () => {
      const { config } = await setupTree([]);
      const controller = new AbortController();
      const metadata = metadataMock(config, { before: () => controller.abort() });
      const { aiService } = createAIServiceMocks(config, { getWorkspaceMetadata: metadata });
      const { taskService } = createTaskServiceHarness(config, { aiService });
      const before = configSnapshot(config);
      const recordsBefore = taskRecordCount(config);
      const result = await taskService.createMany([spawnArgs(rootId)], {
        abortSignal: controller.signal,
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("prepare");
      // Let the abandoned read settle before asserting or deleting its config root.
      await metadata.mock.results[0]?.value;
      expect(configSnapshot(config)).toBe(before);
      expect(taskRecordCount(config)).toBe(recordsBefore);
    });

    test("preparation inputs that drift before the mutex fail closed with a retryable error and no commit", async () => {
      const { config } = await setupTree([]);
      let drifted = false;
      const { aiService } = createAIServiceMocks(config, {
        getWorkspaceMetadata: metadataMock(config, {
          after: async () => {
            if (drifted) return;
            drifted = true;
            // The parent moves to another checkout while preparation is in flight.
            await config.editConfig((cfg) => {
              for (const project of cfg.projects.values()) {
                const ws = project.workspaces.find((entry) => entry.id === rootId);
                if (ws) ws.path = `${ws.path}-moved`;
              }
              return cfg;
            });
          },
        }),
      });
      const { taskService } = createTaskServiceHarness(config, { aiService });
      const result = await taskService.createMany([spawnArgs(rootId)]);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/changed|retry/i);
      expect(config.loadConfigOrDefault().projects.values().next().value?.workspaces.length).toBe(
        2
      );
    });

    test("abort before the checkpoint callback is entered: no callback, no commit", async () => {
      const { config } = await setupTree([]);
      const { taskService } = createTaskServiceHarness(config);
      const controller = new AbortController();
      const coordinator = (
        taskService as unknown as {
          desktopInputCoordinator: { withReservations: (...args: unknown[]) => Promise<unknown> };
        }
      ).desktopInputCoordinator;
      const realWithReservations = coordinator.withReservations.bind(coordinator);
      spyOn(coordinator, "withReservations").mockImplementation((...args: unknown[]) => {
        controller.abort();
        return realWithReservations(...args);
      });
      const onTaskReserved = mock(() => undefined);
      const before = configSnapshot(config);
      const result = await taskService.createMany([spawnArgs(rootId)], {
        abortSignal: controller.signal,
        onTaskReserved,
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/desktop-gate|checkpoint/);
      expect(onTaskReserved).not.toHaveBeenCalled();
      expect(configSnapshot(config)).toBe(before);
    });

    test.each(["inside-checkpoint", "config-lock-wait", "after-commit"] as const)(
      "abort %s: the owned reservation is persisted interrupted, never scheduled, and settled",
      async (moment) => {
        const spawnedId = "canceledchild";
        const { config } = await setupTree([]);
        stubStableIds(config, [spawnedId]);
        const { taskService } = createTaskServiceHarness(config);
        const internals = taskService as unknown as Internals;
        const launch = spyOn(internals, "startReservedAgentTask").mockImplementation(() =>
          Promise.resolve()
        );
        const controller = new AbortController();
        // Target the reservation commit itself (the write that follows the checkpoint), not
        // normalization writes made by earlier reads.
        let checkpointed = false;
        const originalEdit = config.editConfig.bind(config);
        const editSpy = spyOn(config, "editConfig").mockImplementation(async (mutator) => {
          if (moment === "config-lock-wait" && checkpointed) controller.abort();
          const result = await originalEdit(mutator);
          if (moment === "after-commit" && checkpointed) controller.abort();
          return result;
        });
        const waiter = taskService.waitForAgentReport(spawnedId, { timeoutMs: 5_000 }).then(
          () => "resolved" as const,
          (error: unknown) => (error instanceof Error ? error.message : "rejected")
        );
        try {
          const result = await taskService.createMany([spawnArgs(rootId)], {
            abortSignal: controller.signal,
            onTaskReserved: () => {
              checkpointed = true;
              if (moment === "inside-checkpoint") controller.abort();
            },
          });
          expect(result.success).toBe(false);
          if (!result.success) expect(result.error).toMatch(/^Interrupted/);
        } finally {
          editSpy.mockRestore();
        }
        const persisted = findWorkspaceInConfig(config, spawnedId);
        expect(persisted?.taskStatus).toBe("interrupted");
        expect(persisted?.taskLaunchError).toBe("Reservation canceled");
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(launch).not.toHaveBeenCalled();
        expect(
          await taskService.readAttemptOutcome(spawnedId, { requestingWorkspaceId: rootId })
        ).toMatchObject({ kind: "terminal-no-report" });
        // Waiters are rejected by the owned reconcile, not left hanging.
        expect(await waiter).not.toBe("resolved");
      }
    );

    test("abort during materialization cleans the materialized workspace and never sends", async () => {
      const spawnedId = "materializedchild";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });
      const internals = taskService as unknown as Internals;
      const controller = new AbortController();
      const fakeRuntime = { deleteWorkspace: mock(() => Promise.resolve(Ok(undefined))) };
      spyOn(internals, "materializeReservedTaskWorkspace").mockImplementation(() => {
        controller.abort();
        return Promise.resolve({
          workspacePath: "/tmp/materialized",
          trunkBranch: "main",
          forkedRuntimeConfig: { type: "local" },
          runtimeForTaskWorkspace: fakeRuntime,
          inheritedProjects: undefined,
        });
      });
      const cleanup = spyOn(internals, "cleanupMaterializedTaskWorkspace").mockImplementation(() =>
        Promise.resolve()
      );
      const created = await taskService.createMany([spawnArgs(rootId)], {
        abortSignal: controller.signal,
      });
      expect(created.success).toBe(true);
      await waitUntil(
        () => findWorkspaceInConfig(config, spawnedId)?.taskStatus === "interrupted",
        "the canceled launch to persist"
      );
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(cleanup.mock.calls[0]?.[3]).toBe(spawnedId);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, spawnedId)?.taskLaunchError).toBe(
        "Reservation canceled"
      );
      await waitForOutcomeKind(taskService, spawnedId, "terminal-no-report");
    });

    test("a held preparation read is cancellable: abort returns before the read releases and no late reservation follows", async () => {
      const { config } = await setupTree([]);
      const metadata = heldMetadataMock(config, 1);
      const before = configSnapshot(config);
      const { aiService } = createAIServiceMocks(config, { getWorkspaceMetadata: metadata.read });
      const { taskService } = createTaskServiceHarness(config, { aiService });
      const onTaskReserved = mock(() => undefined);
      const recordsBefore = taskRecordCount(config);
      const controller = new AbortController();
      const creating = taskService.createMany([spawnArgs(rootId)], {
        abortSignal: controller.signal,
        onTaskReserved,
      });
      await metadata.held;
      controller.abort();
      const result = await creating;
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("prepare");
      // The read is still blocked: cancellation did not wait for it.
      metadata.gate.resolve();
      await metadata.read.mock.results[0]?.value;
      expect(configSnapshot(config)).toBe(before);
      expect(onTaskReserved).not.toHaveBeenCalled();
      expect(taskRecordCount(config)).toBe(recordsBefore);
    });

    test("a held revalidation read under the mutex is cancellable: abort frees the mutex for unrelated creation", async () => {
      const { config } = await setupTree([]);
      // First read (preparation) resolves; the second (revalidation, under the mutex) blocks.
      const metadata = heldMetadataMock(config, 2);
      const { aiService } = createAIServiceMocks(config, { getWorkspaceMetadata: metadata.read });
      const { taskService } = createTaskServiceHarness(config, { aiService });
      const internals = taskService as unknown as Internals;
      spyOn(internals, "startReservedAgentTask").mockImplementation(() => Promise.resolve());
      stubStableIds(config, ["unrelatedchild9"]);
      const recordsBefore = taskRecordCount(config);
      const controller = new AbortController();
      const creating = taskService.createMany([spawnArgs(rootId)], {
        abortSignal: controller.signal,
      });
      await metadata.held;
      controller.abort();
      const result = await creating;
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("revalidate");
      // Mutex released while the revalidation read is still held: an unrelated tree creates.
      const unrelated = await taskService.createMany([spawnArgs(unrelatedParentId)]);
      expect(unrelated.success).toBe(true);
      metadata.gate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Only the unrelated reservation exists; the canceled one never committed.
      expect(taskRecordCount(config)).toBe(recordsBefore + 1);
      expect(findWorkspaceInConfig(config, "unrelatedchild9")?.parentWorkspaceId).toBe(
        unrelatedParentId
      );
    });

    test("reservation reads never persist metadata migrations (owned config writes stay explicit)", async () => {
      const spawnedId = "readonlychild1";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      // Real reader, forwarding the caller's read-only option.
      const { aiService } = createAIServiceMocks(config, {
        getWorkspaceMetadata: mock(
          async (
            workspaceId: string,
            options?: { persistMigrations?: boolean }
          ): Promise<Result<WorkspaceMetadata>> => {
            const found = await config.getWorkspaceMetadataById(workspaceId, options);
            return found ? Ok(found) : Err("not found");
          }
        ),
      });
      const { taskService } = createTaskServiceHarness(config, { aiService });
      const internals = taskService as unknown as Internals;
      spyOn(internals, "startReservedAgentTask").mockImplementation(() => Promise.resolve());
      // The fixture parent has no runtimeConfig: a default (migrating) read would write it.
      expect(findWorkspaceInConfig(config, rootId)?.runtimeConfig).toBeUndefined();
      const editSpy = spyOn(config, "editConfig");
      let writesBeforeCommit = -1;
      let parentRuntimeConfigAtCheckpoint: unknown = "unset";
      const created = await taskService.createMany([spawnArgs(rootId)], {
        onTaskReserved: () => {
          // Preparation + revalidation (both reads) are done; the commit has not run yet.
          writesBeforeCommit = editSpy.mock.calls.length;
          parentRuntimeConfigAtCheckpoint = findWorkspaceInConfig(config, rootId)?.runtimeConfig;
        },
      });
      if (!created.success) throw new Error(`createMany failed: ${created.error}`);
      expect(writesBeforeCommit).toBe(0);
      expect(parentRuntimeConfigAtCheckpoint).toBeUndefined();
      // The child was still created with the parent's (default-filled) runtime.
      expect(findWorkspaceInConfig(config, spawnedId)?.runtimeConfig).toBeDefined();
    });

    test("abort during the post-commit metadata emit still reconciles the reservation and never schedules", async () => {
      const spawnedId = "emitcanceled1";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      const { taskService } = createTaskServiceHarness(config);
      const internals = taskService as unknown as Internals & {
        emitWorkspaceMetadata: (workspaceId: string) => Promise<void>;
      };
      const launch = spyOn(internals, "startReservedAgentTask").mockImplementation(() =>
        Promise.resolve()
      );
      const controller = new AbortController();
      const realEmit = internals.emitWorkspaceMetadata.bind(taskService);
      spyOn(internals, "emitWorkspaceMetadata").mockImplementation(async (workspaceId: string) => {
        await realEmit(workspaceId);
        if (workspaceId === spawnedId) controller.abort();
      });
      const result = await taskService.createMany([spawnArgs(rootId)], {
        abortSignal: controller.signal,
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/^Interrupted/);
      expect(findWorkspaceInConfig(config, spawnedId)?.taskStatus).toBe("interrupted");
      expect(findWorkspaceInConfig(config, spawnedId)?.taskLaunchError).toBe(
        "Reservation canceled"
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(launch).not.toHaveBeenCalled();
    });

    test.each(["capacity-queued", "barrier-requeued"] as const)(
      "a %s plan canceled after createMany returned is never launched when the scheduler rebuilds it",
      async (kind) => {
        const spawnedId = "requeuedchild1";
        const blockerId = "task-capacity-blocker";
        const { config } = await setupTree(
          kind === "capacity-queued" ? [blockerId] : [],
          testTaskSettings(1, 3)
        );
        stubStableIds(config, [spawnedId]);
        const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
        const { taskService } = createTaskServiceHarness(config, { workspaceService });
        const internals = taskService as unknown as Internals;
        spyOn(internals, "materializeReservedTaskWorkspace").mockImplementation(() =>
          Promise.resolve({
            workspacePath: config.loadConfigOrDefault().projects.keys().next().value ?? "/tmp",
            trunkBranch: "main",
            forkedRuntimeConfig: { type: "local" },
            runtimeForTaskWorkspace: {
              deleteWorkspace: mock(() => Promise.resolve(Ok(undefined))),
              getWorkspacePath: () => "/tmp/requeued",
            },
            inheritedProjects: undefined,
          })
        );
        spyOn(internals, "cleanupMaterializedTaskWorkspace").mockImplementation(() =>
          Promise.resolve()
        );
        spyOn(workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(() =>
          Promise.resolve(undefined)
        );
        const controller = new AbortController();
        const releaseBarrier =
          kind === "barrier-requeued"
            ? taskService.latchWorkspaceStopsInProgress([rootId])
            : undefined;
        const created = await taskService.createMany([spawnArgs(rootId)], {
          abortSignal: controller.signal,
        });
        expect(created).toMatchObject({
          success: true,
          data: [{ status: kind === "capacity-queued" ? "queued" : "starting" }],
        });
        await waitUntil(
          () => findWorkspaceInConfig(config, spawnedId)?.taskStatus === "queued",
          "the plan to wait in the queue"
        );
        // Canceled while queued — after createMany already returned Ok.
        controller.abort();
        // Release capacity / the barrier: the scheduler rebuilds the plan from config.
        if (kind === "capacity-queued") {
          expect((await taskService.stopDescendantAgentTask(rootId, blockerId)).success).toBe(true);
        } else {
          releaseBarrier?.();
        }
        await taskService.maybeStartQueuedTasks();
        await waitUntil(
          () => findWorkspaceInConfig(config, spawnedId)?.taskStatus === "interrupted",
          "the rebuilt launch to observe the cancellation"
        );
        expect(sendMessage).not.toHaveBeenCalled();
        expect(findWorkspaceInConfig(config, spawnedId)?.taskLaunchError).toBe(
          "Reservation canceled"
        );
        await waitForOutcomeKind(taskService, spawnedId, "terminal-no-report");
        // A reawakening is a NEW attempt and must not inherit the canceled signal.
        expect(await taskService.markInterruptedTaskRunning(spawnedId)).toBe(true);
        const owned = (
          taskService as unknown as {
            ownedAttemptByTaskId: Map<string, { abortSignal?: AbortSignal }>;
          }
        ).ownedAttemptByTaskId.get(spawnedId);
        expect(owned?.abortSignal).toBeUndefined();
      }
    );

    test.each([
      "abort-observed-by-second-checkpoint",
      "checkpoint-throws",
      "config-commit-throws",
      "config-commit-throws-after-write",
    ] as const)(
      "a checkpointed reservation whose commit fails (%s) is authoritatively settled, never launchable",
      async (failure) => {
        const firstId = "checkpointed01";
        const secondId = "checkpointed02";
        const { config } = await setupTree([]);
        stubStableIds(config, [firstId, secondId]);
        const { taskService } = createTaskServiceHarness(config);
        const internals = taskService as unknown as Internals;
        const launch = spyOn(internals, "startReservedAgentTask").mockImplementation(() =>
          Promise.resolve()
        );
        const controller = new AbortController();
        const checkpointed: string[] = [];
        const originalEdit = config.editConfig.bind(config);
        // Only the reservation COMMIT (the first write after the checkpoint) fails; the fence
        // that follows is an ordinary owned write.
        let commitAttempted = false;
        const editSpy = spyOn(config, "editConfig").mockImplementation(async (mutator) => {
          if (checkpointed.length === 0 || commitAttempted) return await originalEdit(mutator);
          commitAttempted = true;
          if (failure === "config-commit-throws") throw new Error("config write failed");
          const result = await originalEdit(mutator);
          if (failure === "config-commit-throws-after-write") {
            throw new Error("config write acknowledged late");
          }
          return result;
        });
        try {
          const result = await taskService.createMany([spawnArgs(rootId), spawnArgs(rootId)], {
            abortSignal: controller.signal,
            // Runner semantics: the FIRST callback durably checkpoints its task id; the second
            // observes Stop (or its own store failure) and throws before checkpointing.
            onTaskReserved: (index, created) => {
              if (index === 0) {
                checkpointed.push(created.taskId);
                return;
              }
              if (failure === "abort-observed-by-second-checkpoint") {
                controller.abort();
                throw new Error("Interrupted");
              }
              if (failure === "checkpoint-throws") throw new Error("store write failed");
              checkpointed.push(created.taskId);
            },
          });
          expect(result.success).toBe(false);
          if (!result.success) expect(result.error).not.toBe("Task interrupted");
        } finally {
          editSpy.mockRestore();
        }
        expect(checkpointed[0]).toBe(firstId);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(launch).not.toHaveBeenCalled();
        const persisted = findWorkspaceInConfig(config, firstId);
        if (failure === "config-commit-throws-after-write") {
          // The write landed after all: the record must be fenced, never left launchable.
          expect(persisted?.taskStatus).toBe("interrupted");
          expect(persisted?.taskLaunchError).toBeDefined();
        } else {
          expect(persisted).toBeUndefined();
        }
        // The checkpointed attempt belongs to this process: its failure before launch is an
        // authoritative outcome the runner can dispose (failed → one replacement), not a
        // "missing task" it has to keep waiting on.
        expect(
          await taskService.readAttemptOutcome(firstId, { requestingWorkspaceId: rootId })
        ).toMatchObject({ kind: "terminal-no-report" });
        expect(
          await taskService.waitForAttemptSettlement(firstId, {
            timeoutMs: 200,
            requestingWorkspaceId: rootId,
          })
        ).toMatchObject({ kind: "terminal-no-report" });
        // The scheduler cannot pick a fenced record up later.
        await taskService.maybeStartQueuedTasks();
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(launch).not.toHaveBeenCalled();
        // Control: a fresh process owns nothing. It proves the no-report settlement only from the
        // parent's receipt, which exists only when the failed commit's row was written (G2).
        const { taskService: legacyService } = createTaskServiceHarness(config);
        expect(
          (await legacyService.readAttemptOutcome(firstId, { requestingWorkspaceId: rootId })).kind
        ).toBe(
          failure === "config-commit-throws-after-write" ? "terminal-no-report" : "indeterminate"
        );
      }
    );

    test("a Stop landing during send admission is never overwritten by the launch's running transition", async () => {
      const spawnedId = "stoppedduring1";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      const serviceRef: { current?: TaskService } = {};
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
        sendMessage: mock(async (): Promise<Result<void>> => {
          // The runner's interruptRun (Layer 2 cascade) lands while the send is being admitted.
          await serviceRef.current!.terminateAllDescendantAgentTasks(rootId);
          return Ok(undefined);
        }),
      });
      const { taskService } = createTaskServiceHarness(config, { workspaceService });
      serviceRef.current = taskService;
      const internals = taskService as unknown as Internals;
      spyOn(internals, "materializeReservedTaskWorkspace").mockImplementation(() =>
        Promise.resolve({
          workspacePath: config.loadConfigOrDefault().projects.keys().next().value ?? "/tmp",
          trunkBranch: "main",
          forkedRuntimeConfig: { type: "local" },
          runtimeForTaskWorkspace: {
            deleteWorkspace: mock(() => Promise.resolve(Ok(undefined))),
            getWorkspacePath: () => "/tmp/stopped-during",
          },
          inheritedProjects: undefined,
        })
      );
      spyOn(internals, "cleanupMaterializedTaskWorkspace").mockImplementation(() =>
        Promise.resolve()
      );
      spyOn(workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(() =>
        Promise.resolve(undefined)
      );
      // Observe (not replace) the background launch so the assertion runs after its tail: a fixed
      // sleep raced the cascade under load and read the row while it was still "starting".
      const launch = spyOn(internals, "startReservedAgentTask");
      const created = await taskService.createMany([spawnArgs(rootId)]);
      expect(created.success).toBe(true);
      await waitUntil(() => launch.mock.calls.length === 1, "the reserved launch to start");
      await launch.mock.results[0]?.value;
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(findWorkspaceInConfig(config, spawnedId)?.taskStatus).toBe("interrupted");
      // Coherent readback: the stopped attempt is settled, not a stale "running" live child.
      await waitForOutcomeKind(taskService, spawnedId, "terminal-no-report");
    });

    test("abort after send admission cannot un-launch: the execution exists and is stopped through the Layer 2 path", async () => {
      const spawnedId = "admittedchild1";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      const controller = new AbortController();
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
        sendMessage: mock((): Promise<Result<void>> => {
          controller.abort();
          return Promise.resolve(Ok(undefined));
        }),
      });
      const { taskService } = createTaskServiceHarness(config, { workspaceService });
      const internals = taskService as unknown as Internals;
      spyOn(internals, "materializeReservedTaskWorkspace").mockImplementation(() =>
        Promise.resolve({
          workspacePath: config.loadConfigOrDefault().projects.keys().next().value ?? "/tmp",
          trunkBranch: "main",
          forkedRuntimeConfig: { type: "local" },
          runtimeForTaskWorkspace: {
            deleteWorkspace: mock(() => Promise.resolve(Ok(undefined))),
            getWorkspacePath: () => "/tmp/admitted",
          },
          inheritedProjects: undefined,
        })
      );
      const cleanup = spyOn(internals, "cleanupMaterializedTaskWorkspace").mockImplementation(() =>
        Promise.resolve()
      );
      spyOn(workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(() =>
        Promise.resolve(undefined)
      );
      const created = await taskService.createMany([spawnArgs(rootId)], {
        abortSignal: controller.signal,
      });
      expect(created.success).toBe(true);
      await waitUntil(
        () => findWorkspaceInConfig(config, spawnedId)?.taskStatus === "running",
        "the admitted launch to run"
      );
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(cleanup).not.toHaveBeenCalled();
      // Linearization point passed: only Stop ends it.
      expect(await taskService.terminateAllDescendantAgentTasks(rootId)).toEqual([spawnedId]);
      expect(findWorkspaceInConfig(config, spawnedId)?.taskStatus).toBe("interrupted");
    });
  });

  describe("workflow runner integration (real TaskService + adapter)", () => {
    const RUN_ID = "wfr_bulk_checkpoint_stop";
    const FANOUT_SOURCE = `export default function workflow({ agent, parallel }) {
  const results = parallel([
    () => agent("Fan out A", { id: "fanout-0" }),
    () => agent("Fan out B", { id: "fanout-1" }),
  ]);
  return { reportMarkdown: results.join(" | ") };
}
`;

    test("a Stop between bulk checkpoints fails the checkpointed attempt, frees the lease, and the same-run resume replaces each failed step exactly once", async () => {
      const firstIds = ["fanout0first", "fanout1first"];
      const replacementIds = ["fanout0second", "fanout1second"];
      const { config } = await setupTree([]);
      stubStableIds(config, [...firstIds, ...replacementIds]);
      const { taskService } = createTaskServiceHarness(config);
      const internals = taskService as unknown as {
        startReservedAgentTask: (plan: { taskId: string }) => Promise<void>;
        setTaskStatus: (
          taskId: string,
          status: string,
          options?: { onlyFromStatus?: string }
        ) => Promise<boolean>;
      };
      // Every admitted launch completes immediately through the real publication path.
      const launched: string[] = [];
      spyOn(internals, "startReservedAgentTask").mockImplementation(async (plan) => {
        launched.push(plan.taskId);
        await internals.setTaskStatus(plan.taskId, "running", { onlyFromStatus: "starting" });
        await streamEnd(taskService, {
          type: "stream-end",
          workspaceId: plan.taskId,
          messageId: `${plan.taskId}-final`,
          metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
          parts: [
            {
              type: "dynamic-tool",
              toolCallId: `${plan.taskId}-report`,
              toolName: "agent_report",
              input: { reportMarkdown: `report ${plan.taskId}` },
              state: "output-available",
              output: { success: true, report: { reportMarkdown: `report ${plan.taskId}` } },
            },
            // The terminal report is the final assistant response of the turn.
            { type: "text", text: `report ${plan.taskId}` },
          ],
        });
      });

      // Production keeps the run under the parent workspace's session dir; TaskService reads it
      // there to decide whether a workflow-owned child still has a live owner.
      const store = new WorkflowRunStore({
        sessionDir: path.join(config.sessionsDir, rootId),
        staleLeaseMs: 100,
      });
      await store.createRun({
        id: RUN_ID,
        workspaceId: rootId,
        workflow: {
          name: "fanout",
          description: "Fan out",
          scope: "built-in" as const,
          executable: true,
        },
        source: FANOUT_SOURCE,
        args: {},
        now: "2026-05-29T00:00:00.000Z",
      });
      const adapter = new WorkflowTaskServiceAdapter({
        taskService,
        parentWorkspaceId: rootId,
        workflowRunId: RUN_ID,
        defaultAgentId: "explore",
        getProjectTrusted: () => true,
      });
      const createRunner = (runnerId: string) =>
        new WorkflowRunner({
          runStore: store,
          runtimeFactory: new QuickJSRuntimeFactory(),
          taskAdapter: adapter,
          runnerId,
          clock: { nowIso: () => new Date().toISOString(), nowMs: () => Date.now() },
        });

      // The user's Stop lands right after the FIRST bulk checkpoint was durably recorded: the
      // second checkpoint observes the abort and throws before the config commit (the exact
      // UAT sequence).
      const stop = new AbortController();
      const realRecordStepStarted = store.recordStepStarted.bind(store);
      let checkpoints = 0;
      spyOn(store, "recordStepStarted").mockImplementation(async (...args) => {
        const result = await realRecordStepStarted(...args);
        checkpoints += 1;
        if (checkpoints === 1) stop.abort();
        return result;
      });
      const firstRun = createRunner("runner-a").run(RUN_ID, { abortSignal: stop.signal });
      expect(
        await firstRun.then(
          () => null,
          (error: unknown) => error
        )
      ).toBeInstanceOf(Error);

      const afterStop = await store.getRun(RUN_ID);
      // The checkpointed attempt is authoritatively failed (its reservation never committed),
      // not left `started` behind an indeterminate "no attempt owned" read.
      expect(afterStop.steps).toMatchObject([
        { stepId: "fanout-0", taskId: firstIds[0], status: "failed" },
      ]);
      // WorkflowService.interruptRun persists the run's interrupted status around the abort.
      await store.appendStatus(RUN_ID, "interrupted", new Date().toISOString());
      expect(launched).toEqual([]);
      for (const id of firstIds) expect(findWorkspaceInConfig(config, id)).toBeUndefined();
      expect(
        await taskService.readAttemptOutcome(firstIds[0], { requestingWorkspaceId: rootId })
      ).toMatchObject({ kind: "terminal-no-report" });

      // Same run, new runner (the lease was released): exactly one replacement per failed step,
      // and the canceled ids are never admitted.
      await waitUntil(() => checkpoints >= 1, "checkpoint");
      const resumed = await createRunner("runner-b").run(RUN_ID, {
        allowResumeFromInterrupted: true,
      });
      expect(resumed).toEqual({
        reportMarkdown: `report ${replacementIds[0]} | report ${replacementIds[1]}`,
      });
      expect(launched.sort()).toEqual([...replacementIds].sort());
      const finalRun = await store.getRun(RUN_ID);
      expect(finalRun.status).toBe("completed");
      expect(finalRun.steps.map((step) => [step.stepId, step.taskId, step.status]).sort()).toEqual([
        ["fanout-0", replacementIds[0], "completed"],
        ["fanout-1", replacementIds[1], "completed"],
      ]);
      const taskEvents = finalRun.events
        .filter((event) => event.type === "task")
        .map((event) => (event.type === "task" ? `${event.taskId}:${event.status}` : ""));
      expect(taskEvents.filter((entry) => entry.startsWith(firstIds[0]))).toEqual([
        `${firstIds[0]}:started`,
        `${firstIds[0]}:failed`,
      ]);
      expect(taskEvents.filter((entry) => entry.startsWith(firstIds[1]))).toEqual([]);
      for (const id of replacementIds) {
        expect(findWorkspaceInConfig(config, id)?.taskStatus).toBe("reported");
      }
    });
  });
});
