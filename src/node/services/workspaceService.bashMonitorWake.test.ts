import type { TurnCompletion } from "./streamManager";
import {
  FileCompactionCancellationStorage,
  type CompactionCancellation,
} from "./compactionCancellation";
import type { TurnCoordinator } from "./turnCoordinator";
import { describe, expect, test, mock, spyOn } from "bun:test";
import type { WorkspaceService } from "./workspaceService";
import { STOP_UNRECORDED_MESSAGE } from "@/common/constants/workspace";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import { EventEmitter, once } from "events";
import * as fsPromises from "fs/promises";
import path from "path";
import { Err, Ok, type Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import type { AIService } from "./aiService";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { streamText, tool } from "ai";
import { z } from "zod";
import { StreamManager } from "./streamManager";
import { BashMonitorRegistryStore } from "./bashMonitorRegistryStore";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import { makeAgentTaskIntegrationFake } from "./taskWorkspaceSeam.testUtils";
import type { WorkspaceTurnHost } from "./taskWorkspaceSeam";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { SendMessageOptions } from "@/common/orpc/types";
import { createMuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import { waitForCondition } from "./testDispatchHelpers";
import type {
  BashMonitorProcessSnapshot,
  BashMonitorWakeReconciler,
  BashMonitorWakeReconcilerProcessManager,
  BashMonitorWakeDispatch,
} from "./bashMonitorWakeReconciler";
import {
  createDeferred,
  createMockAIService,
  createWorkspaceServiceForTest,
} from "./workspaceService.testHarness";

describe("WorkspaceService bash monitor wake reconciler wiring", () => {
  // The durable auto-retry preference a restarted session reads for this workspace.
  function autoRetryPreferencePath(h: {
    config: { sessionsDir: string };
    workspaceId: string;
  }): string {
    return path.join(h.config.sessionsDir, h.workspaceId, "auto-retry-preference.json");
  }

  async function createWakeWiringService() {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const events = new EventEmitter();
    const backgroundProcessManager = Object.assign(events, {
      cleanup: mock(() => Promise.resolve()),
      notifyMonitorWakeStateChanged: mock(() => undefined),
      getActiveMonitorCount: mock(() => 0),
      pullMonitorWakeSignals: mock(() => []),
      getMonitorWakeDeliveryState: mock(() => Promise.resolve(undefined)),
      acknowledgeMonitorWake: mock(() => undefined),
      dropRetiredMonitor: mock(() => undefined),
      setMessageQueued: mock(() => undefined),
    }) as unknown as BackgroundProcessManager;
    const aiService = createMockAIService({ isStreaming: mock(() => false) });
    const service = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService,
      extensionMetadata: new ExtensionMetadataService(
        path.join(config.rootDir, "wake-wiring-extension-metadata.json")
      ),
      backgroundProcessManager,
    });
    return {
      config,
      historyService,
      aiService,
      backgroundProcessManager,
      service,
      events,
      cleanup,
    };
  }

  async function createActiveWakeHarness(options?: {
    workspaceGoalService?: WorkspaceGoalService;
  }) {
    const fixture = await createWakeWiringService();
    const { config, service, historyService, backgroundProcessManager } = fixture;
    const workspaceId = "monitor-attention-owner";
    await config.addWorkspace("/tmp/monitor-attention-project", {
      id: workspaceId,
      name: workspaceId,
      projectName: "monitor-attention-project",
      projectPath: "/tmp/monitor-attention-project",
      runtimeConfig: { type: "local" },
    });
    const model = "anthropic:claude-sonnet-4-5";
    const aiEmitter = new EventEmitter();
    const requests: Array<Parameters<AIService["streamMessage"]>[0]> = [];
    const completions: Array<ReturnType<typeof Promise.withResolvers<TurnCompletion>>> = [];
    const launched = new EventEmitter();
    let streaming = false;
    const harness = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      backgroundProcessManager,
      aiEmitter,
      workspaceGoalService: options?.workspaceGoalService,
      aiServiceOverrides: {
        isStreaming: () => streaming,
        streamMessage: mock((request: Parameters<AIService["streamMessage"]>[0]) => {
          requests.push(request);
          const completion = Promise.withResolvers<TurnCompletion>();
          completions.push(completion);
          // Session shutdown retires an in-flight handle (as createStartedTurnHandle does), so
          // finish() can drain a turn the test never completed.
          harness.session.closingSignal.addEventListener(
            "abort",
            () => completion.resolve({ status: "aborted", abortReason: "user" }),
            { once: true }
          );
          streaming = true;
          const messageId = "assistant-" + requests.length;
          aiEmitter.emit("stream-start", {
            type: "stream-start",
            workspaceId,
            messageId,
            model,
            startTime: Date.now(),
          });
          launched.emit("start");
          return Promise.resolve(Ok({ messageId, completion: completion.promise }));
        }),
      },
    });
    const internal = service as unknown as {
      aiService: typeof harness.aiService;
      bashMonitorRecoveryPromise: Promise<void>;
      bashMonitorWakeReconciler: BashMonitorWakeReconciler;
      pendingBashMonitorWakeIdleWaitsByOwner: Map<string, Promise<void>>;
      getDelegatedTurnContinuationSendOptions(workspaceId: string): Promise<SendMessageOptions>;
      dispatchBashMonitorWake(dispatch: BashMonitorWakeDispatch): Promise<"in-flight" | "deferred">;
    };
    await internal.bashMonitorRecoveryPromise;
    internal.aiService = harness.aiService;
    service.registerSession(workspaceId, harness.session);
    internal.getDelegatedTurnContinuationSendOptions = () =>
      Promise.resolve({ model, agentId: "exec" });
    const signals: BashMonitorProcessSnapshot[] = [];
    let shown = 0;
    spyOn(backgroundProcessManager, "pullMonitorWakeSignals").mockImplementation(() => [
      ...signals,
    ]);
    spyOn(backgroundProcessManager, "getMonitorWakeDeliveryState").mockImplementation(() =>
      Promise.resolve({ status: "settled", shownThroughOffset: shown, terminalStatusShown: false })
    );
    const reconciler = internal.bashMonitorWakeReconciler;
    const dispatch = spyOn(internal, "dispatchBashMonitorWake");
    const complete = async (finishReason = "stop") => {
      const messageId = "assistant-" + requests.length;
      const message = createMuxMessage(messageId, "assistant", "final answer", {
        model,
        finishReason,
        muxMetadata: requests[requests.length - 1].muxMetadata,
      });
      await historyService.appendToHistory(workspaceId, message);
      const completed = new Promise<void>((resolve) => {
        const unsubscribe = harness.session.onChatEvent(({ message: event }) => {
          if (event.type === "stream-end") {
            unsubscribe();
            resolve();
          }
        });
      });
      streaming = false;
      const streamEnd = {
        type: "stream-end" as const,
        workspaceId,
        parts: [{ type: "text" as const, text: "final answer" }],
        metadata: { model, finishReason },
      };
      aiEmitter.emit("stream-end", { ...streamEnd, messageId });
      completions[requests.length - 1].resolve({ status: "completed", streamEnd });
      await completed;
    };
    const abort = (abortReason: "user" | "system") => {
      const messageId = "assistant-" + requests.length;
      const streamAbort = { type: "stream-abort" as const, workspaceId, metadata: { duration: 1 } };
      streaming = false;
      aiEmitter.emit("stream-abort", { ...streamAbort, messageId, abortReason });
      completions[requests.length - 1].resolve({ status: "aborted", abortReason, streamAbort });
    };
    return {
      ...fixture,
      ...harness,
      workspaceId,
      model,
      requests,
      launched,
      internal,
      reconciler,
      dispatch,
      complete,
      abort,
      stopStream: spyOn(harness.aiService, "stopStream"),
      addAttention: async (offset: number) => {
        signals.splice(
          0,
          signals.length,
          ...["first", "second"].map((processId) => ({
            processId,
            taskId: "bash:" + processId,
            ownerWorkspaceId: workspaceId,
            filter: "READY",
            filterExclude: false,
            script: "watch",
            createdAt: "2026-01-01T00:00:00.000Z",
            retired: false,
            match: { throughOffset: offset, lines: ["READY " + offset], totalMatches: 1 },
          }))
        );
        fixture.events.emit("monitor:match", workspaceId, {});
        await reconciler.reconcile(workspaceId);
      },
      consume: async (offset: number) => {
        shown = offset;
        fixture.events.emit("output:shown", workspaceId, {});
        await reconciler.reconcile(workspaceId);
      },
      finish: async () => {
        await reconciler.dispose(workspaceId);
        await harness.session.dispose();
        await fixture.cleanup();
      },
    };
  }

  test("a wake row already in history is consumed without a dispatch, even behind a compaction boundary", async () => {
    const h = await createActiveWakeHarness();
    const acknowledged = spyOn(h.backgroundProcessManager, "acknowledgeMonitorWake");
    try {
      // The row is durable but its acceptance never reached the watermark (I/O failed until exit);
      // a later compaction moved it out of the window the model sees.
      await h.historyService.appendToHistory(
        h.workspaceId,
        createMuxMessage("wake-delivered", "user", "Monitor matched", {
          timestamp: Date.now(),
          muxMetadata: {
            type: "bash-monitor-wake",
            records: ["first", "second"].map((processId) => ({
              processId,
              wakeUpdatedAt: "2026-01-01T00:00:00.000Z:7",
              kind: "match" as const,
              displayName: processId,
              filter: "READY",
              filterExclude: false,
            })),
          },
        })
      );
      await h.historyService.appendToHistory(
        h.workspaceId,
        createMuxMessage("summary-1", "assistant", "Summary", {
          timestamp: Date.now(),
          compactionBoundary: true,
          compacted: true,
          compactionEpoch: 1,
          muxMetadata: { type: "compaction-summary" },
        })
      );
      await h.addAttention(7);
      expect(h.dispatch).not.toHaveBeenCalled();
      expect(acknowledged).toHaveBeenCalledTimes(2);
      await h.addAttention(12);
      expect(h.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await h.finish();
    }
  });

  test("a wake persisted as an on-send compaction request is consumed without a dispatch", async () => {
    const h = await createActiveWakeHarness();
    const acknowledged = spyOn(h.backgroundProcessManager, "acknowledgeMonitorWake");
    try {
      await h.historyService.appendToHistory(
        h.workspaceId,
        createMuxMessage("wake-compaction", "user", "/compact", {
          timestamp: Date.now(),
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {
              followUpContent: {
                text: "Monitor matched",
                model: h.model,
                agentId: "exec",
                muxMetadata: {
                  type: "bash-monitor-wake",
                  records: ["first", "second"].map((processId) => ({
                    processId,
                    wakeUpdatedAt: "2026-01-01T00:00:00.000Z:7",
                    kind: "match" as const,
                    displayName: processId,
                    filter: "READY",
                    filterExclude: false,
                  })),
                },
              },
            },
          },
        })
      );
      await h.addAttention(7);
      expect(h.dispatch).not.toHaveBeenCalled();
      expect(acknowledged).toHaveBeenCalledTimes(2);
    } finally {
      await h.finish();
    }
  });

  test("an archived owner's wake is held without an idle-retry loop and dispatches on unarchive", async () => {
    const h = await createActiveWakeHarness();
    const send = spyOn(h.service, "sendMessage");
    try {
      await h.config.editConfig((config) => {
        for (const project of config.projects.values()) {
          for (const workspace of project.workspaces) {
            if (workspace.id === h.workspaceId) workspace.archivedAt = new Date().toISOString();
          }
        }
        return config;
      });
      await h.addAttention(7);
      expect(send).not.toHaveBeenCalled();
      expect(h.internal.pendingBashMonitorWakeIdleWaitsByOwner.has(h.workspaceId)).toBe(false);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(2);

      // An unarchive whose restoration fails rolls back to archived; the wake must not have run
      // against the half-restored checkout in between.
      const restoreSnapshotAfterUnarchive = mock(
        (): Promise<Result<void>> => Promise.resolve(Err("restore failed"))
      );
      h.service.setWorktreeArchiveSnapshotService({
        restoreSnapshotAfterUnarchive,
      } as unknown as Parameters<WorkspaceService["setWorktreeArchiveSnapshotService"]>[0]);
      expect((await h.service.unarchive(h.workspaceId)).success).toBe(false);
      expect(restoreSnapshotAfterUnarchive).toHaveBeenCalledTimes(1);
      await h.reconciler.reconcile(h.workspaceId);
      expect(send).not.toHaveBeenCalled();

      restoreSnapshotAfterUnarchive.mockImplementation(() => Promise.resolve(Ok(undefined)));
      // Restoration succeeds but a follow-up step throws: unarchivedAt is already persisted and a
      // retried unarchive would not run the hooks again, so the held attention must still wake.
      spyOn(
        h.internal as unknown as { syncCodeWorkspaceFiles(): Promise<void> },
        "syncCodeWorkspaceFiles"
      ).mockImplementationOnce(() => {
        throw new Error("sync failed");
      });
      expect((await h.service.unarchive(h.workspaceId)).success).toBe(false);
      // Unarchive itself schedules the reconcile; no manual reconcile here.
      await waitForCondition(() => h.requests.length === 1);
    } finally {
      await h.finish();
    }
  });

  test("malformed wake metadata in history neither stalls nor consumes an outstanding wake", async () => {
    const h = await createActiveWakeHarness();
    try {
      await h.historyService.appendToHistory(
        h.workspaceId,
        createMuxMessage("wake-corrupt", "user", "Monitor matched", {
          timestamp: Date.now(),
          muxMetadata: {
            type: "bash-monitor-wake",
            records: [null, "junk", { processId: "first" }],
          } as unknown as MuxMessageMetadata,
        })
      );
      await h.addAttention(7);
      expect(h.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await h.finish();
    }
  });

  test("the SDK answers in the original stream after repeated owed wakes are consumed", async () => {
    const h = await createActiveWakeHarness();
    let step = 0;
    let offset = 0;
    const sdkModel = new MockLanguageModelV3({
      doStream: () => {
        step++;
        const chunks: LanguageModelV3StreamPart[] =
          step <= 6
            ? [
                {
                  type: "tool-call",
                  toolCallId: "tool-" + step,
                  toolName: step % 2 === 1 ? "held_tool" : "task_await",
                  input: "{}",
                },
              ]
            : [
                { type: "text-start", id: "answer" },
                { type: "text-delta", id: "answer", delta: "final answer" },
                { type: "text-end", id: "answer" },
              ];
        chunks.push({
          type: "finish",
          finishReason: { unified: step <= 6 ? "tool-calls" : "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        });
        return Promise.resolve({
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        });
      },
    });
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      const engine = new StreamManager(h.historyService) as unknown as {
        createStopWhenCondition(
          request: Pick<Parameters<AIService["streamMessage"]>[0], "hasQueuedMessages">
        ): Array<(options: { steps: unknown[] }) => boolean>;
      };
      const result = streamText({
        model: sdkModel,
        prompt: "run the monitored tasks",
        stopWhen: engine.createStopWhenCondition(h.requests[0]),
        tools: {
          held_tool: tool({
            inputSchema: z.object({}),
            execute: async () => {
              offset += 10;
              await h.addAttention(offset);
              expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(2);
              return "foreground finished";
            },
          }),
          task_await: tool({
            inputSchema: z.object({}),
            execute: async () => {
              await h.consume(offset);
              return "READY";
            },
          }),
        },
      });
      expect(await result.text).toBe("final answer");
      expect(step).toBe(7);
      expect(h.dispatch).toHaveBeenCalled();
      await h.complete();
      await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
      await h.reconciler.reconcile(h.workspaceId);
      expect(h.requests).toHaveLength(1);
      const history = await h.historyService.getHistoryFromLatestBoundary(h.workspaceId);
      expect(history.success && history.data.map((row) => row.role)).toEqual(["user", "assistant"]);
    } finally {
      await h.finish();
    }
  });

  test.each([false, true])(
    "owed monitor attention never cuts an active tool (native=%s)",
    async (providerExecuted) => {
      const h = await createActiveWakeHarness();
      try {
        expect(
          (await h.session.sendMessage("original", { model: h.model, agentId: "exec" })).success
        ).toBe(true);
        for (const offset of [10, 20, 30]) {
          h.aiEmitter.emit("tool-call-start", {
            type: "tool-call-start",
            workspaceId: h.workspaceId,
            messageId: "assistant-1",
            toolCallId: "held-tool",
            toolName: "bash",
            args: {},
            timestamp: Date.now(),
          });
          await h.addAttention(offset);
          expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(2);
          expect(h.dispatch).toHaveBeenCalled();
          expect(h.requests[0].hasQueuedMessages?.("tool-end")).toBe(false);
          h.aiEmitter.emit("tool-call-end", {
            type: "tool-call-end",
            workspaceId: h.workspaceId,
            messageId: "assistant-1",
            toolCallId: "held-tool",
            toolName: "bash",
            result: {},
            providerExecuted,
            timestamp: Date.now(),
          });
          expect(h.stopStream).not.toHaveBeenCalled();
          await h.consume(offset);
          expect(h.requests[0].hasQueuedMessages?.("tool-end")).toBe(false);
        }
        await h.complete();
        await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
        await h.reconciler.reconcile(h.workspaceId);
        expect(h.requests).toHaveLength(1);
        const history = await h.historyService.getHistoryFromLatestBoundary(h.workspaceId);
        expect(history.success && history.data.map((row) => row.role)).toEqual([
          "user",
          "assistant",
        ]);
        expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
      } finally {
        await h.finish();
      }
    }
  );

  test("owed attention does not hold a delegated completion open or inherit its closed correlation", async () => {
    const h = await createActiveWakeHarness();
    const correlation = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_turn",
      ownerWorkspaceId: "parent",
      turnId: "turn",
    };
    try {
      await h.session.sendMessage(
        "delegated",
        { model: h.model, agentId: "exec", muxMetadata: correlation },
        { synthetic: true, agentInitiated: true }
      );
      await h.addAttention(10);
      expect(h.service.hasPendingWorkspaceTurnContinuation(h.workspaceId, correlation)).toBe(false);
      expect(h.service.hasPendingBashMonitorWakeContinuation(h.workspaceId)).toBe(false);
      const next = new Promise<void>((resolve) => h.launched.once("start", resolve));
      await h.complete();
      await next;
      expect(h.requests).toHaveLength(2);
      expect(h.requests[0].muxMetadata).toEqual(correlation);
      expect(h.requests[1].muxMetadata).toBeUndefined();
    } finally {
      await h.finish();
    }
  });

  test("owed attention on an inactive sub-agent resumes it under the continuation the task integration opens", async () => {
    const h = await createActiveWakeHarness();
    const closed = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_closed",
      ownerWorkspaceId: "parent",
      turnId: "turn-1",
    };
    const fresh = { taskHandleId: "wst_fresh", ownerWorkspaceId: "parent", turnId: "turn-2" };
    const order: string[] = [];
    const reactivate = mock(
      async (workspaceId: string, prompt: string, send: WorkspaceTurnHost["sendMessage"]) => {
        const sent = await send(
          workspaceId,
          prompt,
          {
            model: h.model,
            agentId: "exec",
            muxMetadata: { type: "workspace-turn-task", ...fresh },
          },
          {
            acceptanceOrigin: "automatic",
            requireIdle: true,
            onAccepted: () => {
              order.push("turn");
            },
          }
        );
        return sent.success ? Ok(undefined) : Err("continuation send failed");
      }
    );
    h.service.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({ reactivateInactiveAgentTaskFromBashMonitorWake: reactivate })
    );
    spyOn(h.backgroundProcessManager, "acknowledgeMonitorWake").mockImplementation(() => {
      order.push("wake");
    });
    try {
      await h.session.sendMessage(
        "delegated",
        { model: h.model, agentId: "exec", muxMetadata: closed },
        { synthetic: true, agentInitiated: true }
      );
      await h.addAttention(10);
      const next = new Promise<void>((resolve) => h.launched.once("start", resolve));
      await h.complete();
      await next;
      expect(reactivate).toHaveBeenCalledWith(
        h.workspaceId,
        expect.any(String),
        expect.any(Function)
      );
      expect(h.requests).toHaveLength(2);
      // The resumed turn streams under the fresh continuation: neither the closed one nor unowned.
      expect(h.requests[1].muxMetadata).toEqual({ type: "workspace-turn-task", ...fresh });
      const history = await h.historyService.getHistoryFromLatestBoundary(h.workspaceId);
      expect(history.success).toBe(true);
      if (!history.success) return;
      const wakeRow = history.data.findLast(
        (message) =>
          message.role === "user" && message.metadata?.muxMetadata?.type === "bash-monitor-wake"
      );
      // The row keeps its wake type (the reconciler's proof of delivery) and carries the correlation.
      expect(wakeRow?.metadata?.muxMetadata).toMatchObject({
        type: "bash-monitor-wake",
        workspaceTurn: fresh,
      });
      expect(wakeRow?.metadata?.synthetic).toBe(true);
      // The continuation's own acceptance runs before the wake's two monitors are acknowledged.
      expect(order).toEqual(["turn", "wake", "wake"]);
    } finally {
      await h.finish();
    }
  });

  test("a wake the task integration declines, fails, or throws before sending dispatches plainly", async () => {
    const h = await createActiveWakeHarness();
    const integrations = [
      mock(() => Promise.resolve(null)),
      mock(() => Promise.resolve(Err("maxParallelAgentTasks exceeded"))),
      mock(() => Promise.reject(new Error("config unreadable"))),
    ];
    try {
      for (const [index, reactivate] of integrations.entries()) {
        h.service.setAgentTaskIntegration(
          makeAgentTaskIntegrationFake({
            reactivateInactiveAgentTaskFromBashMonitorWake: reactivate,
          })
        );
        const started = new Promise<void>((resolve) => h.launched.once("start", resolve));
        if (index > 0) await h.complete();
        await h.addAttention(10 * (index + 1));
        await started;
        expect(reactivate).toHaveBeenCalledTimes(1);
        expect(h.requests).toHaveLength(index + 1);
        expect(h.requests[index].muxMetadata).toBeUndefined();
      }
    } finally {
      await h.finish();
    }
  });

  test("full context discard retires owed attention before the active turn becomes idle", async () => {
    const h = await createActiveWakeHarness();
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      await h.addAttention(10);
      const token = await h.reconciler.beginFullHistoryClear(h.workspaceId);
      await h.reconciler.finishFullHistoryClear(token);
      await h.complete();
      await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
      await h.reconciler.reconcile(h.workspaceId);
      expect(h.requests).toHaveLength(1);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
    } finally {
      await h.finish();
    }
  });

  test("output after retirement wakes when fast Stop settlement completes", async () => {
    const h = await createActiveWakeHarness();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let stopping: ReturnType<WorkspaceService["interruptStream"]> | undefined;
    try {
      h.service.setAgentTaskIntegration(
        makeAgentTaskIntegrationFake({
          terminateAllDescendantAgentTasks: async () => {
            entered.resolve();
            await release.promise;
            return [];
          },
        })
      );
      stopping = h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true });
      await entered.promise;
      await h.addAttention(20);
      expect(h.requests).toHaveLength(0);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(2);
      const launched = once(h.launched, "start");
      release.resolve();
      expect(await stopping).toEqual(Ok(undefined));
      await launched;
      expect(h.requests).toHaveLength(1);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
    } finally {
      release.resolve();
      await stopping;
      await h.finish();
    }
  });

  test("outer Stop preserves physical completion through exact cleanup retry", async () => {
    const h = await createActiveWakeHarness();
    try {
      spyOn(h.historyService, "neutralizeCompactionRecoveryUnderHistoryLock").mockRejectedValueOnce(
        new Error("cleanup unavailable")
      );
      expect(await h.service.interruptStream(h.workspaceId)).toEqual(Err(STOP_UNRECORDED_MESSAGE));
      const storage = h.historyService.getCompactionCancellationStorage(h.workspaceId);
      const cancellation = (
        h.session as unknown as { compactionCancellation: CompactionCancellation }
      ).compactionCancellation;
      // Downgrade cleanup fails before publication; the local Stop still owns its exact retry.
      expect(await storage.read()).toBeNull();
      const failed = await cancellation.read();
      expect(failed).toMatchObject({ version: 1 });
      expect(cancellation.needsPersistence).toBe(true);
      expect(await cancellation.retry()).toBe("applied");
      expect(await storage.read()).toMatchObject({ version: 2, nonce: failed?.nonce });
      expect(await h.session.isAutomaticSendBlocked()).toBe(false);
    } finally {
      await h.finish();
    }
  });

  test("failed descendant Stop cleanup stays V1 across restart", async () => {
    const h = await createActiveWakeHarness();
    h.service.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        terminateAllDescendantAgentTasks: () => Promise.reject(new Error("descendant unavailable")),
      })
    );
    const foreign = await createAgentSessionHarness({
      workspaceId: h.workspaceId,
      config: h.config,
      historyService: new HistoryService(h.config),
    });
    try {
      // Preserve the existing API result; swallowed cleanup errors confer no settlement proof.
      expect(await h.service.interruptStream(h.workspaceId)).toEqual(Ok(undefined));
      expect(
        await h.historyService.getCompactionCancellationStorage(h.workspaceId).read()
      ).toMatchObject({ version: 1 });
      expect(await foreign.session.isAutomaticSendBlocked()).toBe(true);
    } finally {
      await foreign.session.dispose();
      await foreign.cleanup();
      await h.finish();
    }
  });

  test.each(
    (["retirement", "descendants"] as const).flatMap((phase) =>
      [false, true].map((superseded) => ({ phase, superseded }))
    )
  )(
    "hard Stop remains V1 until outer $phase finishes across instances (superseded=$superseded)",
    async ({ phase, superseded }) => {
      const h = await createActiveWakeHarness();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      if (phase === "retirement") {
        const consume = h.reconciler.consumeCurrent.bind(h.reconciler);
        spyOn(h.reconciler, "consumeCurrent").mockImplementationOnce(async (...args) => {
          const result = await consume(...args);
          entered.resolve();
          await release.promise;
          return result;
        });
      } else {
        h.service.setAgentTaskIntegration(
          makeAgentTaskIntegrationFake({
            terminateAllDescendantAgentTasks: async () => {
              entered.resolve();
              await release.promise;
              return [];
            },
          })
        );
      }
      const foreign = await createAgentSessionHarness({
        workspaceId: h.workspaceId,
        config: h.config,
        historyService: new HistoryService(h.config),
      });
      let stopping: Promise<unknown> | undefined;
      try {
        stopping = h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true });
        await entered.promise;
        expect(
          await h.historyService.getCompactionCancellationStorage(h.workspaceId).read()
        ).toMatchObject({ version: 1, scope: { kind: "unresolved" } });
        expect(await foreign.session.isAutomaticSendBlocked()).toBe(true);
        expect(
          (
            await foreign.session.sendMessage(
              "too early",
              { model: h.model, agentId: "exec" },
              { acceptanceOrigin: "automatic" }
            )
          ).success
        ).toBe(false);
        if (superseded) expect(await foreign.session.cancelCompaction()).toEqual(Ok(undefined));
        const successor = superseded
          ? await h.historyService.getCompactionCancellationStorage(h.workspaceId).read()
          : null;
        release.resolve();
        expect(await stopping).toEqual(Ok(undefined));
        const completed = await h.historyService
          .getCompactionCancellationStorage(h.workspaceId)
          .read();
        if (superseded) expect(completed).toEqual(successor);
        else expect(completed).toMatchObject({ version: 2 });
        expect(
          (
            await foreign.session.sendMessage(
              "fresh after cleanup",
              { model: h.model, agentId: "exec" },
              { acceptanceOrigin: "automatic" }
            )
          ).success
        ).toBe(!superseded);
      } finally {
        release.resolve();
        await stopping;
        await foreign.session.dispose();
        await foreign.cleanup();
        await h.finish();
      }
    }
  );

  test("hard Stop retires owed attention without disarming future idle wakes", async () => {
    const h = await createActiveWakeHarness();
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      await h.addAttention(10);
      spyOn(h.aiService, "stopStream").mockImplementation(async () => {
        h.abort("user");
        await h.session.waitForIdle();
        return Ok(undefined);
      });
      spyOn(h.aiService, "isStreaming").mockReturnValue(false);
      expect(
        (await h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true }))
          .success
      ).toBe(true);
      await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
      await h.reconciler.reconcile(h.workspaceId);
      expect(h.requests).toHaveLength(1);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
      await h.addAttention(20);
      expect(h.requests).toHaveLength(2);
    } finally {
      await h.finish();
    }
  });

  test.each(["retained", "generation mismatch"] as const)(
    "%s Stop leaves fresh monitor attention owed without spinning and manual replacement re-arms it",
    async (kind) => {
      const h = await createActiveWakeHarness();
      const internal = h.internal as typeof h.internal & {
        scheduleBashMonitorWakeReconcileAfterIdle(ownerWorkspaceId: string): void;
      };
      // Suppress a broken immediate retry so the refusal is a bounded assertion, not a timeout.
      const idleRetry = spyOn(
        internal,
        "scheduleBashMonitorWakeReconcileAfterIdle"
      ).mockImplementation(() => undefined);
      try {
        if (kind === "retained") await h.session.cancelCompaction(true);
        else {
          expect(await h.session.interruptStream()).toEqual(Ok(undefined));
          await h.historyService.getContinuousCompactionJournal(h.workspaceId).advanceGeneration();
        }
        const storage = h.historyService.getCompactionCancellationStorage(h.workspaceId);
        const stop = await storage.read();
        await h.addAttention(20);
        expect(idleRetry).not.toHaveBeenCalled();
        expect(h.requests).toHaveLength(0);
        expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(2);
        expect((await storage.read())?.nonce).toBe(stop?.nonce);
        const history = await h.historyService.getHistoryFromLatestBoundary(h.workspaceId);
        expect(history).toEqual(Ok([]));
        idleRetry.mockRestore();
        await h.session.sendMessage("manual replacement", { model: h.model, agentId: "exec" });
        await h.complete();
        await h.reconciler.reconcile(h.workspaceId);
        expect(h.requests).toHaveLength(2);
        expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
      } finally {
        await h.finish();
      }
    }
  );

  test("a cancellation write failure still completes successful hard-Stop cleanup", async () => {
    const h = await createActiveWakeHarness();
    const descendants = mock(() => Promise.resolve(["child"]));
    h.service.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({ terminateAllDescendantAgentTasks: descendants })
    );
    const partialDeleted = spyOn(h.historyService, "deletePartial");
    const queueRestored = spyOn(h.session, "restoreQueueToInput");
    const accountingEntered = Promise.withResolvers<void>();
    const releaseAccounting = Promise.withResolvers<void>();
    const policy = h.session as unknown as {
      recordGoalAccountingFromUsage(input: unknown): Promise<void>;
    };
    spyOn(policy, "recordGoalAccountingFromUsage").mockImplementation(async () => {
      accountingEntered.resolve();
      await releaseAccounting.promise;
    });
    const stopSession = h.session.interruptStream.bind(h.session);
    let sessionResult: Awaited<ReturnType<AgentSession["interruptStream"]>> | undefined;
    spyOn(h.session, "interruptStream").mockImplementation(async (...args) => {
      sessionResult = await stopSession(...args);
      return sessionResult;
    });
    let interrupt: Promise<Result<void>> | undefined;
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      await h.addAttention(10);
      spyOn(h.aiService, "stopStream").mockImplementation(() => {
        h.abort("user");
        return Promise.resolve(Ok(undefined));
      });
      spyOn(h.aiService, "isStreaming").mockReturnValue(false);
      spyOn(FileCompactionCancellationStorage.prototype, "mutate").mockImplementationOnce(() =>
        Promise.reject(new Error("cancellation write failed"))
      );
      let returned = false;
      interrupt = h.service.interruptStream(h.workspaceId, {
        abandonPartial: true,
        retireBashMonitorAttention: true,
      });
      const settled = interrupt.then(() => {
        returned = true;
      });
      await accountingEntered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(returned).toBe(false);
      releaseAccounting.resolve();
      expect(await interrupt).toEqual(Err(STOP_UNRECORDED_MESSAGE));
      await settled;
      expect(sessionResult).toMatchObject({ success: false, error: "cancellation write failed" });
      expect(partialDeleted).toHaveBeenCalledWith(h.workspaceId);
      expect(descendants).toHaveBeenCalledWith(h.workspaceId);
      expect(queueRestored).toHaveBeenCalledTimes(1);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
      expect(h.session.isBusy()).toBe(false);
    } finally {
      releaseAccounting.resolve();
      await interrupt;
      await h.session.cancelCompaction();
      await h.finish();
    }
  });

  test("hard Stop does not wait behind a wake admission holding the history lock", async () => {
    const h = await createActiveWakeHarness();
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      await h.addAttention(10);
      const release = createDeferred<void>();
      const locks = (
        h.service as unknown as {
          bashMonitorHistoryLocks: { withLock<T>(key: string, op: () => Promise<T>): Promise<T> };
        }
      ).bashMonitorHistoryLocks;
      const held = locks.withLock(h.workspaceId, () => release.promise);
      spyOn(h.aiService, "stopStream").mockImplementation(async () => {
        h.abort("user");
        await h.session.waitForIdle();
        return Ok(undefined);
      });
      spyOn(h.aiService, "isStreaming").mockReturnValue(false);
      expect(
        (await h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true }))
          .success
      ).toBe(true);
      release.resolve();
      await held;
      await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
      await h.reconciler.reconcile(h.workspaceId);
      expect(h.requests).toHaveLength(1);
    } finally {
      await h.finish();
    }
  });

  test("a hard Stop whose retirement failed reports it and the retirement lands before any later wake", async () => {
    const h = await createActiveWakeHarness();
    let registryListAll: { mockRestore(): void } | undefined;
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      await h.addAttention(10);
      // The service owns a single registry store, so the prototype spy reaches exactly it.
      // Lazy rejection: the stop's I/O crosses a macrotask boundary before the retirement reads
      // the registry, and an eager mockRejectedValueOnce promise trips bun's unhandled-rejection
      // detector in that gap.
      registryListAll = spyOn(BashMonitorRegistryStore.prototype, "listAll").mockImplementationOnce(
        () => Promise.reject(new Error("transient registry read"))
      );
      spyOn(h.aiService, "stopStream").mockImplementation(async () => {
        h.abort("user");
        await h.session.waitForIdle();
        return Ok(undefined);
      });
      spyOn(h.aiService, "isStreaming").mockReturnValue(false);
      // The stream stopped, but the dismissal is only in memory, so the Stop reports it.
      expect(
        await h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true })
      ).toEqual(Err(STOP_UNRECORDED_MESSAGE));
      expect(h.stopStream).toHaveBeenCalledTimes(1);
      await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
      await h.reconciler.reconcile(h.workspaceId);
      // The stop's idle reconcile retried the retirement instead of re-dispatching the output.
      expect(h.requests).toHaveLength(1);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
      const woke = new Promise<void>((resolve) => h.launched.once("start", resolve));
      await h.addAttention(20);
      await woke;
      expect(h.requests).toHaveLength(2);
    } finally {
      registryListAll?.mockRestore();
      await h.finish();
    }
  });

  test("a failed hard Stop keeps owed attention for the idle wake", async () => {
    const h = await createActiveWakeHarness();
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      await h.addAttention(10);
      h.stopStream.mockResolvedValueOnce(Err("stop failed"));
      expect(
        (await h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true }))
          .success
      ).toBe(false);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(2);
      const woke = new Promise<void>((resolve) => h.launched.once("start", resolve));
      await h.complete();
      await woke;
      await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
      await h.reconciler.reconcile(h.workspaceId);
      expect(h.requests).toHaveLength(2);
    } finally {
      await h.finish();
    }
  });

  test.each([
    "success",
    "failure",
    "partial failure",
    "superseded",
    "local supersession",
    "closing",
  ] as const)(
    "failed physical Stop waits for its outer cleanup before natural completion qualifies (%s)",
    async (outcome) => {
      const h = await createActiveWakeHarness();
      const release = Promise.withResolvers<void>();
      const terminate = mock(async () => {
        await release.promise;
        if (outcome === "failure") throw new Error("descendant cleanup failed");
        return [];
      });
      if (outcome === "partial failure") {
        spyOn(h.historyService, "deletePartial").mockImplementationOnce(async () => {
          await release.promise;
          throw new Error("partial cleanup failed");
        });
      }
      const releaseLatch = mock(() => undefined);
      const restoreQueue = spyOn(h.session, "restoreQueueToInput");
      h.service.setAgentTaskIntegration(
        makeAgentTaskIntegrationFake({
          terminateAllDescendantAgentTasks: terminate,
          latchHardInterruptCascade: () => releaseLatch,
        })
      );
      const foreign = await createAgentSessionHarness({
        workspaceId: h.workspaceId,
        config: h.config,
        historyService: new HistoryService(h.config),
      });
      try {
        await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
        await h.addAttention(10);
        h.stopStream.mockResolvedValueOnce(Err("stop failed"));
        // The original physical error returns while descendant cleanup is still held.
        expect(
          await h.service.interruptStream(h.workspaceId, {
            retireBashMonitorAttention: true,
            abandonPartial: outcome === "partial failure",
          })
        ).toEqual(Err("stop failed"));
        expect(terminate).toHaveBeenCalledTimes(outcome === "partial failure" ? 0 : 1);
        expect(releaseLatch).not.toHaveBeenCalled();
        expect(restoreQueue).not.toHaveBeenCalled();
        const cleanup = [
          ...(h.service as unknown as { pendingWorkspaceCleanup: Set<Promise<void>> })
            .pendingWorkspaceCleanup,
        ];
        expect(cleanup).toHaveLength(1);
        await h.complete();
        const storage = h.historyService.getCompactionCancellationStorage(h.workspaceId);
        const stopped = await storage.read();
        expect(stopped).toMatchObject({ version: 1 });
        expect(await foreign.session.isAutomaticSendBlocked()).toBe(true);
        expect(h.requests).toHaveLength(1);
        expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(2);
        if (outcome === "superseded") {
          expect(await foreign.session.cancelCompaction()).toEqual(Ok(undefined));
        }
        if (outcome === "local supersession") {
          expect(await h.session.cancelCompaction()).toEqual(Ok(undefined));
        }
        if (outcome === "closing") h.session.beginShutdown();
        const successor = await storage.read();
        const woke = outcome === "success" ? once(h.launched, "start") : undefined;
        release.resolve();
        await Promise.all(cleanup);
        expect(releaseLatch).toHaveBeenCalledTimes(1);
        expect(restoreQueue).toHaveBeenCalledTimes(
          outcome === "partial failure" || outcome === "local supersession" || outcome === "closing"
            ? 0
            : 1
        );
        if (woke) {
          await woke;
          expect(h.requests).toHaveLength(2);
          expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
        } else {
          expect(await storage.read()).toEqual(
            outcome === "superseded" || outcome === "local supersession" ? successor : stopped
          );
          expect(await foreign.session.isAutomaticSendBlocked()).toBe(true);
          expect(h.requests).toHaveLength(1);
        }
      } finally {
        release.resolve();
        await foreign.session.dispose();
        await foreign.cleanup();
        await h.finish();
      }
    }
  );

  test("failed Stop monitor retirement debt does not hold workspace cleanup during shutdown", async () => {
    const h = await createActiveWakeHarness();
    const release = Promise.withResolvers<void>();
    const releaseLatch = mock(() => undefined);
    h.service.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        latchHardInterruptCascade: () => releaseLatch,
        terminateAllDescendantAgentTasks: async () => {
          await release.promise;
          return [];
        },
      })
    );
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      // A persistence failure has no retirement receipt. Only the finalizer may await its retry.
      spyOn(h.reconciler, "consumeCurrent").mockRejectedValueOnce(new Error("retirement failed"));
      h.stopStream.mockResolvedValueOnce(Err("stop failed"));
      expect(
        await h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true })
      ).toEqual(Err("stop failed"));
      const cleanup = [
        ...(h.service as unknown as { pendingWorkspaceCleanup: Set<Promise<void>> })
          .pendingWorkspaceCleanup,
      ];
      expect(cleanup).toHaveLength(1);
      release.resolve();
      await h.complete();
      h.service.beginShutdown();
      await h.session.finishShutdown();
      await Promise.all(cleanup);
      expect(releaseLatch).toHaveBeenCalledTimes(1);
      expect(
        (h.service as unknown as { pendingWorkspaceCleanup: Set<Promise<void>> })
          .pendingWorkspaceCleanup.size
      ).toBe(0);
      expect(
        await h.historyService.getCompactionCancellationStorage(h.workspaceId).read()
      ).toMatchObject({ version: 1 });
    } finally {
      release.resolve();
      await h.finish();
    }
  });

  test("an interrupt without retireBashMonitorAttention keeps owed attention for the idle wake", async () => {
    const h = await createActiveWakeHarness();
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      await h.addAttention(10);
      spyOn(h.aiService, "stopStream").mockImplementation(async () => {
        h.abort("system");
        await h.session.waitForIdle();
        return Ok(undefined);
      });
      spyOn(h.aiService, "isStreaming").mockReturnValue(false);
      expect((await h.service.interruptStream(h.workspaceId)).success).toBe(true);
      await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
      await h.reconciler.reconcile(h.workspaceId);
      expect(h.requests).toHaveLength(2);
    } finally {
      await h.finish();
    }
  });

  test("a wake deferred as its idle wait hands off installs the next idle wait", async () => {
    const h = await createActiveWakeHarness();
    try {
      const internal = h.internal as typeof h.internal & {
        scheduleBashMonitorWakeReconcileAfterIdle(ownerWorkspaceId: string): void;
      };
      const waits = h.internal.pendingBashMonitorWakeIdleWaitsByOwner;
      internal.scheduleBashMonitorWakeReconcileAfterIdle(h.workspaceId);
      const handedOff = waits.get(h.workspaceId);
      let replacedDuringHandoff: boolean | undefined;
      spyOn(h.reconciler, "scheduleReconcile").mockImplementationOnce(() => {
        // A turn that started as the wait resolved defers the wake from inside the wait's own
        // hand-off; the finished wait must not swallow the re-arm as a duplicate.
        internal.scheduleBashMonitorWakeReconcileAfterIdle(h.workspaceId);
        replacedDuringHandoff = waits.get(h.workspaceId) !== handedOff;
      });
      await handedOff;
      expect(replacedDuringHandoff).toBe(true);
      await waits.get(h.workspaceId);
    } finally {
      await h.finish();
    }
  });

  test("hard Stop during a wake's acceptance window keeps the wake from streaming", async () => {
    const h = await createActiveWakeHarness();
    try {
      let stop: Promise<Result<void>> | undefined;
      const unsubscribe = h.session.onChatEvent(({ message: event }) => {
        // The wake's user row is emitted past the point of no return and before PREPARING.
        if (event.type === "message" && event.role === "user" && stop == null) {
          stop = h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true });
        }
      });
      await h.addAttention(10);
      unsubscribe();
      expect(stop).toBeDefined();
      expect((await stop!).success).toBe(true);
      expect(h.requests).toHaveLength(0);
      expect(h.session.isBusy()).toBe(false);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
      await h.addAttention(20);
      expect(h.requests).toHaveLength(1);
    } finally {
      await h.finish();
    }
  });

  test("a Stop that disables auto-retry interrupts the stream without waiting on the opt-out write", async () => {
    const h = await createActiveWakeHarness();
    const release = createDeferred<void>();
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      const stopStream = spyOn(h.aiService, "stopStream").mockImplementation(async () => {
        h.abort("user");
        await h.session.waitForIdle();
        return Ok(undefined);
      });
      const optOut = h.session.setAutoRetryEnabled.bind(h.session);
      spyOn(h.session, "setAutoRetryEnabled").mockImplementation(async (enabled, options) => {
        await release.promise;
        return optOut(enabled, options);
      });
      const stop = h.service.interruptStream(h.workspaceId, {
        retireBashMonitorAttention: true,
        disableAutoRetry: true,
      });
      // The abort reaches the stream while the preference write is still pending.
      await waitForCondition(() => stopStream.mock.calls.length === 1);
      let stopSettled = false;
      void stop.then(() => {
        stopSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopSettled).toBe(false);
      release.resolve();
      expect((await stop).success).toBe(true);
    } finally {
      release.resolve();
      await h.finish();
    }
  });

  test("a Stop that disables auto-retry withdraws the wake before releasing the retry gate", async () => {
    const h = await createActiveWakeHarness();
    try {
      let wakeWithdrawnAtOptOut: boolean | undefined;
      const optOut = h.session.setAutoRetryEnabled.bind(h.session);
      spyOn(h.session, "setAutoRetryEnabled").mockImplementation(async (enabled, options) => {
        // The opt-out releases the idle gate a pending wake waits behind; retirement must already
        // have withdrawn the wake's dispatch by then.
        wakeWithdrawnAtOptOut = h.dispatch.mock.calls[0]?.[0].cancelSignal.aborted;
        return optOut(enabled, options);
      });
      let stop: Promise<Result<void>> | undefined;
      const unsubscribe = h.session.onChatEvent(({ message: event }) => {
        if (event.type === "message" && event.role === "user" && stop == null) {
          stop = h.service.interruptStream(h.workspaceId, {
            retireBashMonitorAttention: true,
            disableAutoRetry: true,
          });
        }
      });
      await h.addAttention(10);
      unsubscribe();
      expect((await stop!).success).toBe(true);
      expect(wakeWithdrawnAtOptOut).toBe(true);
      expect(h.requests).toHaveLength(0);
      const persisted = JSON.parse(
        await fsPromises.readFile(autoRetryPreferencePath(h), "utf-8")
      ) as { enabled?: boolean };
      expect(persisted.enabled).toBe(false);
    } finally {
      await h.finish();
    }
  });

  test("hard Stop during a wake's acceptance window is acknowledged only once the wake's abandon marker is durable", async () => {
    const h = await createActiveWakeHarness();
    const release = createDeferred<void>();
    try {
      const sessionInternal = h.session as unknown as {
        persistAutoRetryState(): Promise<void>;
      };
      const persist = sessionInternal.persistAutoRetryState.bind(h.session);
      const persisting = createDeferred<void>();
      spyOn(sessionInternal, "persistAutoRetryState").mockImplementation(async () => {
        persisting.resolve();
        await release.promise;
        return persist();
      });
      let stop: Promise<Result<void>> | undefined;
      const unsubscribe = h.session.onChatEvent(({ message: event }) => {
        if (event.type === "message" && event.role === "user" && stop == null) {
          stop = h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true });
        }
      });
      const attention = h.addAttention(10);
      await persisting.promise;
      unsubscribe();
      let stopSettled = false;
      void stop!.then(() => {
        stopSettled = true;
      });
      // Retirement has consumed the signals; Stop still waits for the withdrawn send's marker.
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopSettled).toBe(false);
      release.resolve();
      expect((await stop!).success).toBe(true);
      await attention;
      const persisted = JSON.parse(
        await fsPromises.readFile(autoRetryPreferencePath(h), "utf-8")
      ) as { startupAutoRetryAbandon?: { reason: string; userMessageId?: string } };
      expect(persisted.startupAutoRetryAbandon?.reason).toBe("aborted");
      expect(persisted.startupAutoRetryAbandon?.userMessageId).toBeDefined();
      expect(h.requests).toHaveLength(0);
    } finally {
      release.resolve();
      await h.finish();
    }
  });

  test("hard Stop during a wake's acceptance window fails until the withdrawn wake's abandon marker is written", async () => {
    const h = await createActiveWakeHarness();
    try {
      const preferencePath = autoRetryPreferencePath(h);
      // A directory at the preference path makes the marker write fail (EISDIR).
      await fsPromises.mkdir(preferencePath, { recursive: true });
      let stop: Promise<Result<void>> | undefined;
      const unsubscribe = h.session.onChatEvent(({ message: event }) => {
        if (event.type === "message" && event.role === "user" && stop == null) {
          stop = h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true });
        }
      });
      await h.addAttention(10);
      unsubscribe();
      expect(stop).toBeDefined();
      expect(await stop!).toEqual(Err(STOP_UNRECORDED_MESSAGE));
      expect(h.requests).toHaveLength(0);
      expect(h.session.isBusy()).toBe(false);
      // The obligation outlives the joined send: a later Stop retries the write once it can succeed.
      await fsPromises.rmdir(preferencePath);
      expect(
        (await h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true }))
          .success
      ).toBe(true);
      const persisted = JSON.parse(await fsPromises.readFile(preferencePath, "utf-8")) as {
        startupAutoRetryAbandon?: { reason: string; userMessageId?: string };
      };
      expect(persisted.startupAutoRetryAbandon?.reason).toBe("aborted");
      expect(persisted.startupAutoRetryAbandon?.userMessageId).toBeDefined();
    } finally {
      await h.finish();
    }
  });

  test("output arriving while a hard Stop waits behind a wake's acceptance stays owed", async () => {
    const h = await createActiveWakeHarness();
    const release = createDeferred<void>();
    try {
      const acknowledging = createDeferred<void>();
      const reconcilerInternal = h.reconciler as unknown as {
        args: { processManager: BashMonitorWakeReconcilerProcessManager };
      };
      spyOn(reconcilerInternal.args.processManager, "acknowledgeMonitorWake").mockImplementation(
        async () => {
          acknowledging.resolve();
          await release.promise;
        }
      );
      const attention = h.addAttention(10);
      await acknowledging.promise;
      // Acceptance holds the reconciler lock; the Stop snapshots the frontier (10) on entry and waits.
      const stop = h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true });
      const later = h.addAttention(20);
      release.resolve();
      expect((await stop).success).toBe(true);
      await Promise.all([attention, later]);
      // Only the frontier the Stop saw was retired; the newer output woke the idle agent.
      expect(h.requests).toHaveLength(1);
    } finally {
      release.resolve();
      await h.finish();
    }
  });

  test.each([
    ["the failing goal sync", "goal-sync"],
    ["the acceptance I/O owed after a failed goal sync", "acceptance"],
  ] as const)(
    "hard Stop during %s records the abandon marker for the withdrawn wake",
    async (_, at) => {
      let stop: Promise<Result<void>> | undefined;
      const requestStop = () => {
        stop ??= h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true });
      };
      const h = await createActiveWakeHarness({
        workspaceGoalService: {
          assertPricedModelForBudgetedGoal: () => Promise.resolve(Ok(undefined)),
          recordStreamStarted: () => undefined,
          // Goal sync runs past the point of no return and fails; the failure path still awaits
          // acceptance, so Stop can land during either await.
          syncGoalModeWithChatTail: () => {
            if (at === "goal-sync") requestStop();
            return Promise.reject(new Error("goal sync failed"));
          },
        } as unknown as WorkspaceGoalService,
      });
      if (at === "acceptance") {
        spyOn(h.backgroundProcessManager, "acknowledgeMonitorWake").mockImplementation(requestStop);
      }
      try {
        await h.addAttention(10);
        expect(stop).toBeDefined();
        expect((await stop!).success).toBe(true);
        const persisted = JSON.parse(
          await fsPromises.readFile(autoRetryPreferencePath(h), "utf-8")
        ) as { startupAutoRetryAbandon?: { reason: string; userMessageId?: string } };
        const history = await h.historyService.getHistoryFromLatestBoundary(h.workspaceId);
        const wakeRow = history.success
          ? history.data.filter((row) => row.role === "user").at(-1)
          : undefined;
        expect(wakeRow).toBeDefined();
        expect(persisted.startupAutoRetryAbandon).toEqual({
          reason: "aborted",
          userMessageId: wakeRow!.id,
        });
        expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
        expect(h.requests).toHaveLength(0);
      } finally {
        await h.finish();
      }
    }
  );

  test.each(["options", "pricing"] as const)(
    "wake yields when a turn starts during %s admission",
    async (gate) => {
      const h = await createActiveWakeHarness();
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const options = { model: h.model, agentId: "exec" };
      if (gate === "options") {
        spyOn(h.internal, "getDelegatedTurnContinuationSendOptions").mockImplementationOnce(
          async () => {
            entered.resolve();
            await release.promise;
            return options;
          }
        );
      } else {
        const internal = h.service as unknown as {
          assertPricedModelForBudgetedGoal(): Promise<Result<void, SendMessageError>>;
        };
        spyOn(internal, "assertPricedModelForBudgetedGoal").mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return Ok(undefined);
        });
      }
      try {
        const attention = h.addAttention(10);
        await entered.promise;
        await h.session.sendMessage("original", options);
        release.resolve();
        await attention;
        expect(h.requests).toHaveLength(1);
        expect(h.requests[0].hasQueuedMessages?.("tool-end")).toBe(false);
        await h.consume(10);
        await h.complete();
        await h.reconciler.reconcile(h.workspaceId);
        expect(h.requests).toHaveLength(1);
      } finally {
        release.resolve();
        await h.finish();
      }
    }
  );

  test("unconsumed attention coalesces after natural completion and idle attention starts promptly", async () => {
    const h = await createActiveWakeHarness();
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      await h.addAttention(10);
      await h.reconciler.reconcile(h.workspaceId);
      expect(h.requests).toHaveLength(1);
      const next = new Promise<void>((resolve) => h.launched.once("start", resolve));
      await h.complete();
      await next;
      expect(h.requests).toHaveLength(2);
      await h.reconciler.reconcile(h.workspaceId);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
      await h.complete();
      await h.addAttention(20);
      expect(h.requests).toHaveLength(3);
    } finally {
      await h.finish();
    }
  });

  test.each([false, true])(
    "manual tool-end input takes precedence over owed bash attention (native=%s)",
    async (providerExecuted) => {
      const h = await createActiveWakeHarness();
      try {
        await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
        await h.addAttention(10);
        expect(
          (
            await h.service.sendMessage(h.workspaceId, "manual", {
              model: h.model,
              agentId: "exec",
              queueDispatchMode: "tool-end",
            })
          ).success
        ).toBe(true);
        expect(h.requests[0].hasQueuedMessages?.("tool-end")).toBe(true);
        h.aiEmitter.emit("tool-call-end", {
          type: "tool-call-end",
          workspaceId: h.workspaceId,
          messageId: "assistant-1",
          toolCallId: "tool",
          toolName: "bash",
          result: {},
          providerExecuted,
          timestamp: Date.now(),
        });
        expect(h.stopStream).toHaveBeenCalledTimes(providerExecuted ? 1 : 0);
        await h.consume(10);
        const next = new Promise<void>((resolve) => h.launched.once("start", resolve));
        if (providerExecuted) {
          h.abort("system");
        } else {
          await h.complete("tool-calls");
        }
        await next;
        expect(h.requests).toHaveLength(2);
        const history = await h.historyService.getHistoryFromLatestBoundary(h.workspaceId);
        expect(
          history.success &&
            history.data.filter((row) => row.role === "user").map((row) => row.parts[0])
        ).toEqual([
          expect.objectContaining({ type: "text", text: "original" }),
          expect.objectContaining({ type: "text", text: "manual" }),
        ]);
      } finally {
        await h.finish();
      }
    }
  );

  test("monitor lifecycle and shown-output events poke the reconciler", async () => {
    const { service, events, cleanup } = await createWakeWiringService();
    const scheduleReconcile = mock(() => undefined);
    const discardProcess = mock(() => Promise.resolve());
    const upsert = mock(() => Promise.resolve());
    const remove = mock(() => Promise.resolve());
    const recordTerminal = mock(() => Promise.resolve());
    const internal = service as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
      bashMonitorWakeReconciler: {
        scheduleReconcile: typeof scheduleReconcile;
        discardProcess: typeof discardProcess;
      };
      bashMonitorRegistryStore: {
        upsert: typeof upsert;
        remove: typeof remove;
        recordTerminal: typeof recordTerminal;
      };
    };
    try {
      await internal.bashMonitorRecoveryPromise;
      internal.bashMonitorWakeReconciler = { scheduleReconcile, discardProcess };
      internal.bashMonitorRegistryStore = { upsert, remove, recordTerminal };
      const armed = {
        processId: "proc",
        taskId: "bash:proc",
        workspaceId: "owner",
        filter: "READY",
        filterExclude: false,
        script: "run",
        createdAt: "2026-08-31T12:00:00.000Z",
      };
      events.emit("monitor:match", "owner", {});
      events.emit("output:shown", "owner", {});
      events.emit("monitor:armed", "owner", armed);
      events.emit("monitor:stopped", "owner", {
        processId: "proc",
        reason: "canceled",
        armMetadata: armed,
      });
      for (let attempt = 0; attempt < 10 && scheduleReconcile.mock.calls.length < 4; attempt++) {
        await Promise.resolve();
      }

      expect(upsert).toHaveBeenCalledWith(armed);
      expect(discardProcess).toHaveBeenCalledWith("owner", "proc", armed.createdAt);
      expect(remove).toHaveBeenCalledWith("owner", "proc", armed.createdAt);
      expect(scheduleReconcile).toHaveBeenCalledTimes(4);
    } finally {
      await cleanup();
    }
  });

  test("workspace removal drain waits for armed and failed-monitor registry writes", async () => {
    const { service, events, cleanup } = await createWakeWiringService();
    let releaseArmed: (() => void) | undefined;
    let releaseLost: (() => void) | undefined;
    const armedGate = new Promise<void>((resolve) => {
      releaseArmed = resolve;
    });
    const lostGate = new Promise<void>((resolve) => {
      releaseLost = resolve;
    });
    const upsert = mock((payload: { processId: string }) =>
      payload.processId === "armed-proc" ? armedGate : Promise.resolve()
    );
    const recordLost = mock(() => lostGate);
    const internal = service as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
      bashMonitorWakeReconciler: { scheduleReconcile(workspaceId: string): void };
      bashMonitorRegistryStore: {
        upsert: typeof upsert;
        recordTerminal(): Promise<void>;
        recordLost: typeof recordLost;
      };
      drainBashMonitorPersistence(workspaceId: string): Promise<void>;
    };
    try {
      await internal.bashMonitorRecoveryPromise;
      internal.bashMonitorWakeReconciler = { scheduleReconcile: () => undefined };
      internal.bashMonitorRegistryStore = {
        upsert,
        recordTerminal: () => Promise.resolve(),
        recordLost,
      };
      const armed = {
        processId: "armed-proc",
        taskId: "bash:armed-proc",
        workspaceId: "owner",
        filter: "READY",
        filterExclude: false,
        script: "run",
        createdAt: "2026-09-01T00:01:00.000Z",
      };
      events.emit("monitor:armed", "owner", armed);
      let armedDrained = false;
      const armedDrain = internal.drainBashMonitorPersistence("owner").then(() => {
        armedDrained = true;
      });
      await Promise.resolve();
      expect(armedDrained).toBe(false);
      releaseArmed?.();
      await armedDrain;

      const failed = { ...armed, processId: "failed-proc", taskId: "bash:failed-proc" };
      events.emit("monitor:stopped", "owner", {
        processId: failed.processId,
        reason: "failed",
        armMetadata: failed,
        failureMessage: "transport unavailable",
      });
      for (let attempt = 0; attempt < 20 && recordLost.mock.calls.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      let failureDrained = false;
      const failureDrain = internal.drainBashMonitorPersistence("owner").then(() => {
        failureDrained = true;
      });
      await Promise.resolve();
      expect(failureDrained).toBe(false);
      releaseLost?.();
      await failureDrain;
    } finally {
      await cleanup();
    }
  });

  test("runtime failure recreates missing registry evidence from arm metadata", async () => {
    const { config, service, events, cleanup } = await createWakeWiringService();
    const scheduleReconcile = mock(() => undefined);
    const internal = service as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
      bashMonitorWakeReconciler: { scheduleReconcile: typeof scheduleReconcile };
    };
    // Read the evidence back through a fresh store: it must be durable, not only in memory.
    const registry = new BashMonitorRegistryStore(config);
    try {
      await internal.bashMonitorRecoveryPromise;
      internal.bashMonitorWakeReconciler = { scheduleReconcile };
      const armMetadata = {
        processId: "failed-proc",
        taskId: "bash:failed-proc",
        workspaceId: "owner",
        filter: "READY",
        filterExclude: false,
        script: "run",
        createdAt: "2026-08-31T12:00:00.000Z",
      };

      events.emit("monitor:stopped", "owner", {
        processId: "failed-proc",
        reason: "failed",
        armMetadata,
        failureMessage: "transport unavailable",
        failedOperations: ["readOutput"],
        failedMatch: {
          lines: ["READY before failure"],
          totalMatches: 1,
          droppedLines: 0,
          matchedThroughOffset: 12,
        },
      });

      let rows = await registry.listAll("owner");
      for (let attempt = 0; attempt < 20 && rows.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        rows = await registry.listAll("owner");
      }
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        processId: "failed-proc",
        lost: {
          reason: "runtime-failure",
          failureMessage: "transport unavailable",
          failedOperations: ["readOutput"],
          failedMatch: { lines: ["READY before failure"] },
        },
      });
      expect(scheduleReconcile).toHaveBeenCalledWith("owner");
    } finally {
      await cleanup();
    }
  });

  test("runtime failure persistence retries before scheduling its wake", async () => {
    const { service, events, cleanup } = await createWakeWiringService();
    const scheduleReconcile = mock(() => undefined);
    const upsert = mock(() => Promise.resolve());
    let lostAttempts = 0;
    const recordLost = mock(() => {
      lostAttempts++;
      return lostAttempts === 1
        ? Promise.reject(new Error("transient registry write failure"))
        : Promise.resolve();
    });
    const internal = service as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
      bashMonitorWakeReconciler: { scheduleReconcile: typeof scheduleReconcile };
      bashMonitorRegistryStore: {
        upsert: typeof upsert;
        recordTerminal(): Promise<void>;
        recordLost: typeof recordLost;
      };
    };
    try {
      await internal.bashMonitorRecoveryPromise;
      internal.bashMonitorWakeReconciler = { scheduleReconcile };
      internal.bashMonitorRegistryStore = {
        upsert,
        recordTerminal: () => Promise.resolve(),
        recordLost,
      };
      const armMetadata = {
        processId: "retry-failed-proc",
        taskId: "bash:retry-failed-proc",
        workspaceId: "owner",
        filter: "READY",
        filterExclude: false,
        script: "run",
        createdAt: "2026-08-31T12:14:00.000Z",
      };

      events.emit("monitor:stopped", "owner", {
        processId: armMetadata.processId,
        reason: "failed",
        armMetadata,
        failureMessage: "transport unavailable",
      });
      for (let attempt = 0; attempt < 40 && scheduleReconcile.mock.calls.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(recordLost).toHaveBeenCalledTimes(2);
      expect(scheduleReconcile).toHaveBeenCalledWith("owner");
    } finally {
      await cleanup();
    }
  });

  test("cancellation invalidates a scheduled runtime failure persistence retry", async () => {
    const { service, events, cleanup } = await createWakeWiringService();
    const scheduleReconcile = mock(() => undefined);
    const discardProcess = mock(() => Promise.resolve());
    const upsert = mock(() => Promise.resolve());
    const remove = mock(() => Promise.resolve());
    const recordLost = mock(() => Promise.reject(new Error("transient registry write failure")));
    const internal = service as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
      bashMonitorWakeReconciler: {
        scheduleReconcile: typeof scheduleReconcile;
        discardProcess: typeof discardProcess;
      };
      bashMonitorRegistryStore: {
        upsert: typeof upsert;
        remove: typeof remove;
        recordTerminal(): Promise<void>;
        recordLost: typeof recordLost;
      };
    };
    try {
      await internal.bashMonitorRecoveryPromise;
      internal.bashMonitorWakeReconciler = { scheduleReconcile, discardProcess };
      internal.bashMonitorRegistryStore = {
        upsert,
        remove,
        recordTerminal: () => Promise.resolve(),
        recordLost,
      };
      const armMetadata = {
        processId: "canceled-retry-proc",
        taskId: "bash:canceled-retry-proc",
        workspaceId: "owner",
        filter: "READY",
        filterExclude: false,
        script: "run",
        createdAt: "2026-08-31T12:15:00.000Z",
      };
      events.emit("monitor:stopped", "owner", {
        processId: armMetadata.processId,
        reason: "failed",
        armMetadata,
        failureMessage: "transport unavailable",
      });
      for (let attempt = 0; attempt < 20 && recordLost.mock.calls.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      events.emit("monitor:stopped", "owner", {
        processId: armMetadata.processId,
        reason: "canceled",
        armMetadata,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(recordLost).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith("owner", armMetadata.processId, armMetadata.createdAt);
      expect(discardProcess).toHaveBeenCalledWith(
        "owner",
        armMetadata.processId,
        armMetadata.createdAt
      );
      // The invalidated chain must also release its tracking entry so the
      // per-process failure-persist map stays bounded by in-flight chains.
      const tracking = (
        service as unknown as { activeBashMonitorFailurePersists: Map<string, unknown> }
      ).activeBashMonitorFailurePersists;
      expect(tracking.size).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("late monitor pokes are ignored after removal begins", async () => {
    const { service, cleanup } = await createWakeWiringService();
    const scheduleReconcile = mock(() => undefined);
    const internal = service as unknown as {
      removingWorkspaces: Set<string>;
      bashMonitorWakeReconciler: { scheduleReconcile: typeof scheduleReconcile };
      scheduleBashMonitorWakeReconcile(workspaceId: string): void;
    };
    try {
      internal.bashMonitorWakeReconciler = { scheduleReconcile };
      internal.removingWorkspaces.add("removed-owner");

      internal.scheduleBashMonitorWakeReconcile("removed-owner");

      expect(scheduleReconcile).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("full clears preconsume and postconsume wakes while truncations leave them alone", async () => {
    const { service, cleanup } = await createWakeWiringService();
    const order: string[] = [];
    const internal = service as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
      bashMonitorWakeReconciler: {
        beginFullHistoryClear(workspaceId: string): Promise<{ ownerWorkspaceId: string }>;
        finishFullHistoryClear(token: { ownerWorkspaceId: string }): Promise<void>;
      };
      clearHistoryWithRetiredBashMonitorWakes<T>(
        workspaceId: string,
        clear: () => Promise<Result<T>>,
        options?: { discardUnacceptedOnSuccess?: boolean }
      ): Promise<Result<T>>;
    };
    try {
      await internal.bashMonitorRecoveryPromise;
      internal.bashMonitorWakeReconciler = {
        beginFullHistoryClear: (workspaceId) => {
          order.push("pre");
          return Promise.resolve({ ownerWorkspaceId: workspaceId });
        },
        finishFullHistoryClear: () => {
          order.push("post");
          return Promise.resolve();
        },
      };
      const truncate = await internal.clearHistoryWithRetiredBashMonitorWakes(
        "owner",
        () => {
          order.push("truncate");
          return Promise.resolve(Ok(undefined));
        },
        { discardUnacceptedOnSuccess: false }
      );
      expect(truncate.success).toBe(true);
      expect(order).toEqual(["truncate"]);

      const clear = await internal.clearHistoryWithRetiredBashMonitorWakes(
        "owner",
        () => {
          order.push("clear");
          return Promise.resolve(Ok(undefined));
        },
        { discardUnacceptedOnSuccess: true }
      );
      expect(clear.success).toBe(true);
      expect(order).toEqual(["truncate", "pre", "clear", "post"]);
    } finally {
      await cleanup();
    }
  });

  test("startup schedules reconciliation only for pre-construction registry rows", async () => {
    const { service, cleanup } = await createWakeWiringService();
    const scheduleReconcile = mock(() => undefined);
    const internal = service as unknown as {
      constructedAtMs: number;
      bashMonitorWakeReconciler: { scheduleReconcile: typeof scheduleReconcile };
      bashMonitorRegistryStore: {
        listOwnerWorkspaceIds(): Promise<{ ownerWorkspaceIds: string[]; scanFailed: boolean }>;
        listAll(workspaceId: string): Promise<Array<{ createdAt: string }>>;
      };
      recoverBashMonitorStateAfterRestart(): Promise<void>;
    };
    try {
      internal.constructedAtMs = Date.parse("2026-08-31T12:00:00.000Z");
      internal.bashMonitorWakeReconciler = { scheduleReconcile };
      internal.bashMonitorRegistryStore = {
        listOwnerWorkspaceIds: () =>
          Promise.resolve({
            ownerWorkspaceIds: ["old", "new", "invalid"],
            scanFailed: false,
          }),
        listAll: (workspaceId) =>
          Promise.resolve([
            {
              createdAt:
                workspaceId === "old"
                  ? "2026-08-31T11:59:00.000Z"
                  : workspaceId === "invalid"
                    ? "not-a-date"
                    : "2026-08-31T12:01:00.000Z",
            },
          ]),
      };

      await internal.recoverBashMonitorStateAfterRestart();
      expect(scheduleReconcile).toHaveBeenCalledTimes(2);
      expect(scheduleReconcile).toHaveBeenCalledWith("old");
      expect(scheduleReconcile).toHaveBeenCalledWith("invalid");
    } finally {
      await cleanup();
    }
  });

  test("startup retries a partial registry scan before scheduling reconciliation", async () => {
    const { service, cleanup } = await createWakeWiringService();
    const scheduleReconcile = mock(() => undefined);
    let scans = 0;
    const internal = service as unknown as {
      constructedAtMs: number;
      bashMonitorWakeReconciler: { scheduleReconcile: typeof scheduleReconcile };
      bashMonitorRegistryStore: {
        listOwnerWorkspaceIds(): Promise<{ ownerWorkspaceIds: string[]; scanFailed: boolean }>;
        listAll(workspaceId: string): Promise<Array<{ createdAt: string }>>;
      };
      recoverBashMonitorStateAfterRestart(): Promise<void>;
    };
    try {
      internal.constructedAtMs = Date.parse("2026-08-31T12:00:00.000Z");
      internal.bashMonitorWakeReconciler = { scheduleReconcile };
      internal.bashMonitorRegistryStore = {
        listOwnerWorkspaceIds: () => {
          scans++;
          return Promise.resolve({ ownerWorkspaceIds: ["owner"], scanFailed: scans === 1 });
        },
        listAll: () =>
          scans === 1
            ? Promise.reject(new Error("transient owner scan failure"))
            : Promise.resolve([{ createdAt: "2026-08-31T11:59:00.000Z" }]),
      };

      await internal.recoverBashMonitorStateAfterRestart();

      expect(scans).toBe(2);
      expect(scheduleReconcile).toHaveBeenCalledWith("owner");
    } finally {
      await cleanup();
    }
  });

  test("busy owners defer reconciliation without queueing a synthetic turn", async () => {
    const { config, service, cleanup } = await createWakeWiringService();
    const workspaceId = "busy-wake-owner";
    await config.addWorkspace("/tmp/busy-wake-project", {
      id: workspaceId,
      name: workspaceId,
      projectName: "busy-wake-project",
      projectPath: "/tmp/busy-wake-project",
      runtimeConfig: { type: "local" },
    });
    const afterIdle = mock(() => undefined);
    const onAccepted = mock(() => Promise.resolve());
    const onDeferred = mock(() => Promise.resolve());
    const internal = service as unknown as {
      hasPendingQueuedOrPreparingTurn(workspaceId: string): boolean;
      scheduleBashMonitorWakeReconcileAfterIdle(workspaceId: string): void;
      dispatchBashMonitorWake(dispatch: {
        ownerWorkspaceId: string;
        prompt: string;
        muxMetadata: { type: "bash-monitor-wake"; records: [] };
        cancelSignal: AbortSignal;
        onAccepted(): Promise<void>;
        onDeferred(): Promise<void>;
      }): Promise<"in-flight" | "deferred">;
    };
    try {
      internal.hasPendingQueuedOrPreparingTurn = () => true;
      internal.scheduleBashMonitorWakeReconcileAfterIdle = afterIdle;
      const outcome = await internal.dispatchBashMonitorWake({
        ownerWorkspaceId: workspaceId,
        prompt: "wake",
        muxMetadata: { type: "bash-monitor-wake", records: [] },
        cancelSignal: new AbortController().signal,
        onAccepted,
        onDeferred,
      });
      expect(outcome).toBe("deferred");
      expect(afterIdle).toHaveBeenCalledWith(workspaceId);
      expect(onAccepted).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("active session-backed streams defer monitor attention until idle", async () => {
    const { config, aiService, service, cleanup } = await createWakeWiringService();
    const workspaceId = "streaming-wake-owner";
    await config.addWorkspace("/tmp/streaming-wake-project", {
      id: workspaceId,
      name: workspaceId,
      projectName: "streaming-wake-project",
      projectPath: "/tmp/streaming-wake-project",
      runtimeConfig: { type: "local" },
    });
    const afterIdle = mock(() => undefined);
    const internal = service as unknown as {
      hasPendingQueuedOrPreparingTurn(workspaceId: string): boolean;
      scheduleBashMonitorWakeReconcileAfterIdle(workspaceId: string): void;
      getDelegatedTurnContinuationSendOptions(workspaceId: string): Promise<object>;
      dispatchBashMonitorWake(dispatch: {
        ownerWorkspaceId: string;
        prompt: string;
        muxMetadata: { type: "bash-monitor-wake"; records: [] };
        cancelSignal: AbortSignal;
        onAccepted(): Promise<void>;
        onDeferred(): Promise<void>;
      }): Promise<"in-flight" | "deferred">;
    };
    try {
      spyOn(service.getOrCreateSession(workspaceId), "isBusy").mockReturnValue(true);
      spyOn(aiService, "isStreaming").mockReturnValue(true);
      internal.hasPendingQueuedOrPreparingTurn = () => false;
      internal.scheduleBashMonitorWakeReconcileAfterIdle = afterIdle;
      internal.getDelegatedTurnContinuationSendOptions = () => Promise.resolve({});
      const sendMessage = spyOn(service, "sendMessage").mockResolvedValue(Ok(undefined));

      const outcome = await internal.dispatchBashMonitorWake({
        ownerWorkspaceId: workspaceId,
        prompt: "wake",
        muxMetadata: { type: "bash-monitor-wake", records: [] },
        cancelSignal: new AbortController().signal,
        onAccepted: () => Promise.resolve(),
        onDeferred: () => Promise.resolve(),
      });

      expect(outcome).toBe("deferred");
      expect(sendMessage).not.toHaveBeenCalled();
      expect(afterIdle).toHaveBeenCalledWith(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("pending mid-stream compaction defers monitor attention like an active turn", async () => {
    const { config, service, cleanup } = await createWakeWiringService();
    const workspaceId = "compacting-wake-owner";
    await config.addWorkspace("/tmp/compacting-wake-project", {
      id: workspaceId,
      name: workspaceId,
      projectName: "compacting-wake-project",
      projectPath: "/tmp/compacting-wake-project",
      runtimeConfig: { type: "local" },
    });
    const afterIdle = mock(() => undefined);
    const internal = service as unknown as {
      scheduleBashMonitorWakeReconcileAfterIdle(workspaceId: string): void;
      getDelegatedTurnContinuationSendOptions(workspaceId: string): Promise<object>;
      dispatchBashMonitorWake(dispatch: {
        ownerWorkspaceId: string;
        prompt: string;
        muxMetadata: { type: "bash-monitor-wake"; records: [] };
        cancelSignal: AbortSignal;
        onAccepted(): Promise<void>;
        onDeferred(): Promise<void>;
      }): Promise<"in-flight" | "deferred">;
    };
    try {
      // Between the stopped stream and its compaction request the coordinator is idle and no
      // stream is running; only the session's pending flag marks the turn work.
      const session = service.getOrCreateSession(workspaceId);
      const { coordinator } = session as unknown as { coordinator: TurnCoordinator };
      const token = coordinator.beginCompactionObservation("legacy");
      if (token == null) throw new Error("Expected compaction observation");
      coordinator.setCompactionStage(token, "stopping");
      internal.scheduleBashMonitorWakeReconcileAfterIdle = afterIdle;
      internal.getDelegatedTurnContinuationSendOptions = () => Promise.resolve({});
      const sendMessage = spyOn(service, "sendMessage").mockResolvedValue(Ok(undefined));

      const outcome = await internal.dispatchBashMonitorWake({
        ownerWorkspaceId: workspaceId,
        prompt: "wake",
        muxMetadata: { type: "bash-monitor-wake", records: [] },
        cancelSignal: new AbortController().signal,
        onAccepted: () => Promise.resolve(),
        onDeferred: () => Promise.resolve(),
      });

      expect(outcome).toBe("deferred");
      expect(sendMessage).not.toHaveBeenCalled();
      expect(afterIdle).toHaveBeenCalledWith(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("withdrawn idle wake rolls back admission and permits a fresh delivery", async () => {
    const h = await createActiveWakeHarness();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const append = h.historyService.acceptCompactionReplacement.bind(h.historyService);
    spyOn(h.historyService, "acceptCompactionReplacement").mockImplementationOnce(
      async (...args) => {
        entered.resolve();
        await release.promise;
        return append(...args);
      }
    );
    const controller = new AbortController();
    const accepted = mock(() => Promise.resolve());
    const deferred = mock(() => Promise.resolve());
    const send = (cancelSignal: AbortSignal) =>
      h.internal.dispatchBashMonitorWake({
        ownerWorkspaceId: h.workspaceId,
        prompt: "wake",
        muxMetadata: { type: "bash-monitor-wake", records: [] },
        cancelSignal,
        onAccepted: accepted,
        onDeferred: deferred,
      });
    try {
      const dispatch = send(controller.signal);
      await entered.promise;
      controller.abort();
      release.resolve();
      await dispatch;
      expect(accepted).not.toHaveBeenCalled();
      expect(deferred).toHaveBeenCalledTimes(1);
      expect(h.requests).toHaveLength(0);
      expect(h.session.hasQueuedMessages()).toBe(false);
      const history = await h.historyService.getHistoryFromLatestBoundary(h.workspaceId);
      expect(history.success && history.data).toEqual([]);
      await send(new AbortController().signal);
      expect(h.requests).toHaveLength(1);
      expect(accepted).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await h.finish();
    }
  });

  test("superseding queued sub-agent progress skips its continuation-failure callbacks", async () => {
    const { config, service, cleanup } = await createWakeWiringService();
    const workspaceId = "superseded-progress-owner";
    await config.addWorkspace("/tmp/superseded-progress-project", {
      id: workspaceId,
      name: workspaceId,
      projectName: "superseded-progress-project",
      projectPath: "/tmp/superseded-progress-project",
      runtimeConfig: { type: "local" },
    });
    const session = service.getOrCreateSession(workspaceId);
    const options: SendMessageOptions = { model: "gpt-4", agentId: "exec" };
    try {
      // A progress report queued into an owner that runs as a delegated turn carries callbacks
      // that settle that turn as interrupted; supersession by the terminal report must not fire them.
      const progressCanceled = mock(() => undefined);
      const wakeCanceled = mock(() => undefined);
      expect(
        session.queueMessage("progress", options, {
          synthetic: true,
          agentInitiated: true,
          dedupeKey: "agent-report:child:wst_1:call-1",
          removableDedupeKey: true,
          onCanceled: progressCanceled,
        })
      ).toBe("tool-end");
      expect(
        session.queueMessage("wake", options, {
          synthetic: true,
          agentInitiated: true,
          dedupeKey: "bash-monitor-wake:owner:1",
          removableDedupeKey: true,
          onCanceled: wakeCanceled,
        })
      ).toBe("tool-end");

      expect(
        service.removeQueuedMessagesByDedupeKeyPrefix(workspaceId, "agent-report:child:wst_1:", {
          cancelReason: "superseded",
          skipCancelCallbacks: true,
        })
      ).toEqual(Ok(1));
      // Withdrawal (the default) still notifies, so wake bookkeeping keeps working.
      expect(
        service.removeQueuedMessagesByDedupeKeyPrefix(workspaceId, "bash-monitor-wake:", {
          cancelReason: "withdrawn",
        })
      ).toEqual(Ok(1));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(progressCanceled).not.toHaveBeenCalled();
      expect(wakeCanceled).toHaveBeenCalledWith("withdrawn");
      expect(session.hasQueuedMessages()).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
