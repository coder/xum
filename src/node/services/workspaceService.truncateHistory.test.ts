import { CompactionPendingState } from "./compactionPendingState";
import * as historyScanner from "./historyScanner";
import type { TurnCoordinator } from "./turnCoordinator";
import { describe, expect, test, mock, spyOn } from "bun:test";
import { ContextManagementService } from "./contextManagement/contextManagementService";
import { WorkspaceService } from "./workspaceService";
import type { AgentSession } from "./agentSession";
import {
  createAgentSessionHarness,
  createStartedTurnHandle,
  createStreamLifecycleMocks,
} from "./agentSession.testHarness";
import type { AutoCompactionUsageState } from "@/common/utils/compaction/autoCompactionCheck";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import path from "path";
import { Err, Ok } from "@/common/types/result";
import { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import type { AIService } from "./aiService";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import {
  awaitPendingBranchSummary,
  startAbandonedBranchSummaryInBackground,
  type BranchSummaryAiService,
} from "./branchSummary";
import type { InitStateManager } from "./initStateManager";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import { createMuxMessage } from "@/common/types/message";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { drainPendingDispatches, waitForCondition } from "./testDispatchHelpers";
import { sandboxHostService } from "./sandbox/sandboxHostService";
import type { BashMonitorWakeReconciler } from "./bashMonitorWakeReconciler";
import {
  createCompactionAdmissionMocks,
  writePlanFile,
  createDeferred,
  mockBackgroundProcessManager,
  setWorkspaceGoalOk,
} from "./workspaceService.testHarness";

// Partial-truncation fixtures: truncateHistory(0.5) sizes its cut by token counts of the whole
// serialized rows, so two near-equal rows can round either way and remove both. A clearly
// larger first row makes 50% remove exactly that row.
const LONGER_FIRST_ROW_TEXT =
  "before the cut: this first row is deliberately several times longer than the row kept after it";

describe("WorkspaceService truncateHistory goal acknowledgment", () => {
  async function createServices(aiServiceOverride?: AIService) {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    const aiService =
      aiServiceOverride ??
      ({
        ...createStreamLifecycleMocks(),
        on: mock(() => undefined),
        isStreaming: mock(() => false),
      } as unknown as AIService);
    const initStateManager = {
      on: mock(() => undefined),
      getInitState: mock(() => null),
    } as unknown as InitStateManager;
    const workspaceService = new WorkspaceService(
      config,
      historyService,
      aiService,
      new ContextManagementService({ config, historyService, aiService }),
      initStateManager,
      extensionMetadata,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
    const goalService = new WorkspaceGoalService(config, historyService, extensionMetadata);
    workspaceService.setWorkspaceGoalService(goalService);
    return { aiService, config, historyService, workspaceService, goalService, cleanup };
  }

  test.each(["send", "resume", "resume-replaced"] as const)(
    "service %s pricing cannot adopt a later Stop or replacement intent",
    async (kind) => {
      const { config, historyService, workspaceService, goalService, cleanup } =
        await createServices();
      const workspaceId = `pricing-cancellation-${kind}`;
      await config.addWorkspace("/tmp/pricing-cancellation-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "pricing-cancellation-project",
        projectPath: "/tmp/pricing-cancellation-project",
        runtimeConfig: { type: "local" },
      });
      const h = await createAgentSessionHarness({
        workspaceId,
        config,
        historyService,
        workspaceGoalService: goalService,
      });
      workspaceService.registerSession(workspaceId, h.session);
      const stream = spyOn(h.aiService, "streamMessage");
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("prior", "user", "old request")
      );
      await h.session.cancelCompaction(true);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const pricing = goalService.assertPricedModelForBudgetedGoal.bind(goalService);
      spyOn(goalService, "assertPricedModelForBudgetedGoal").mockImplementationOnce(
        async (...args) => {
          entered.resolve();
          await release.promise;
          return pricing(...args);
        }
      );
      const dispatch =
        kind === "send"
          ? workspaceService.sendMessage(workspaceId, "stale input", {
              model: "openai:gpt-4o",
              agentId: "exec",
            })
          : workspaceService.resumeStream(workspaceId, { model: "openai:gpt-4o", agentId: "exec" });
      try {
        await entered.promise;
        if (kind === "resume-replaced")
          h.session.queueMessage("new input", { model: "openai:gpt-4o", agentId: "exec" });
        else expect(await h.session.interruptStream()).toEqual(Ok(undefined));
        release.resolve();
        const result = await dispatch;
        if (kind === "send") expect(result.success).toBe(false);
        else expect(result).toEqual(Ok({ started: false }));
        const persisted = await historyService.getLastMessages(workspaceId, 10);
        expect(persisted.success && persisted.data.map((row) => row.id)).toEqual(["prior"]);
        expect(
          await historyService.getCompactionCancellationStorage(workspaceId).read()
        ).not.toBeNull();
        expect(stream).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await dispatch;
        await workspaceService.disposeSession(workspaceId);
        await cleanup();
      }
    }
  );

  test.each(["send", "resume"] as const)(
    "service %s pricing preserves the frontier against a foreign backend Stop",
    async (kind) => {
      const { config, historyService, workspaceService, goalService, cleanup } =
        await createServices();
      const workspaceId = `foreign-pricing-cancellation-${kind}`;
      await config.addWorkspace("/tmp/pricing-cancellation-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "pricing-cancellation-project",
        projectPath: "/tmp/pricing-cancellation-project",
        runtimeConfig: { type: "local" },
      });
      const h = await createAgentSessionHarness({
        workspaceId,
        config,
        historyService,
        workspaceGoalService: goalService,
      });
      workspaceService.registerSession(workspaceId, h.session);
      const stream = spyOn(h.aiService, "streamMessage");
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("prior", "user", "old request")
      );
      const foreign = await createAgentSessionHarness({
        workspaceId,
        config,
        historyService: new HistoryService(config),
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const pricing = goalService.assertPricedModelForBudgetedGoal.bind(goalService);
      spyOn(goalService, "assertPricedModelForBudgetedGoal").mockImplementationOnce(
        async (...args) => {
          entered.resolve();
          await release.promise;
          return pricing(...args);
        }
      );
      const dispatch =
        kind === "send"
          ? workspaceService.sendMessage(workspaceId, "stale input", {
              model: "openai:gpt-4o",
              agentId: "exec",
            })
          : workspaceService.resumeStream(workspaceId, { model: "openai:gpt-4o", agentId: "exec" });
      try {
        await entered.promise;
        expect(await foreign.session.interruptStream()).toEqual(Ok(undefined));
        const stopped = await historyService.getCompactionCancellationStorage(workspaceId).read();
        expect(stopped).not.toBeNull();
        release.resolve();
        const result = await dispatch;
        if (kind === "send") expect(result.success).toBe(false);
        else expect(result.success && result.data?.started).toBe(false);
        const persisted = await historyService.getLastMessages(workspaceId, 10);
        expect(persisted.success && persisted.data.map((row) => row.id)).toEqual(["prior"]);
        expect(
          await historyService.getCompactionCancellationStorage(workspaceId).read()
        ).not.toBeNull();
        expect(stream).not.toHaveBeenCalled();
        expect(await historyService.getCompactionCancellationStorage(workspaceId).read()).toEqual(
          stopped
        );
      } finally {
        release.resolve();
        await dispatch;
        await workspaceService.disposeSession(workspaceId);
        await foreign.session.dispose();
        await cleanup();
      }
    }
  );

  test.each(["pricing", "queue"] as const)(
    "automatic family work admitted before a foreign Stop stays fenced through %s",
    async (stage) => {
      const { config, historyService, workspaceService, goalService, cleanup } =
        await createServices();
      const workspaceId = `foreign-family-${stage}`;
      await config.addWorkspace("/tmp/foreign-family-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "foreign-family-project",
        projectPath: "/tmp/foreign-family-project",
        runtimeConfig: { type: "local" },
      });
      const h = await createAgentSessionHarness({
        workspaceId,
        config,
        historyService,
        workspaceGoalService: goalService,
      });
      const foreign = await createAgentSessionHarness({
        workspaceId,
        config,
        historyService: new HistoryService(config),
      });
      workspaceService.registerSession(workspaceId, h.session);
      const streamStarted = Promise.withResolvers<void>();
      const stream = spyOn(h.aiService, "streamMessage").mockImplementation(() => {
        streamStarted.resolve();
        return Promise.resolve(Ok(createStartedTurnHandle(h.session.closingSignal)));
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("prior", "user", "old request")
      );
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const failed = Promise.withResolvers<void>();
      const price = goalService.assertPricedModelForBudgetedGoal.bind(goalService);
      const busy = stage === "queue" ? spyOn(h.session, "isBusy").mockReturnValue(true) : undefined;
      if (stage === "pricing")
        spyOn(goalService, "assertPricedModelForBudgetedGoal").mockImplementationOnce(
          async (...args) => {
            entered.resolve();
            await release.promise;
            return price(...args);
          }
        );
      const options = { model: "openai:gpt-4o", agentId: "exec" };
      const dispatched = workspaceService.sendMessage(workspaceId, "stale child trigger", options, {
        acceptanceOrigin: "automatic",
        synthetic: true,
        agentInitiated: true,
        preTurnMessages: [
          createMuxMessage("child-payload", "assistant", "stale child payload", {
            synthetic: true,
          }),
        ],
        onAcceptedPreStreamFailure: () => {
          failed.resolve();
        },
      });
      try {
        if (stage === "pricing") await entered.promise;
        else {
          expect(await dispatched).toEqual(Ok(undefined));
          expect(h.session.hasQueuedMessages()).toBe(true);
        }
        expect(await foreign.session.interruptStream()).toEqual(Ok(undefined));
        const stopped = await historyService.getCompactionCancellationStorage(workspaceId).read();
        expect(stopped?.version).toBe(2);
        release.resolve();
        busy?.mockRestore();
        if (stage === "queue") {
          h.session.drainQueuedMessagesIfIdle();
          await Promise.race([failed.promise, streamStarted.promise]);
          expect(stream).not.toHaveBeenCalled();
          await h.session.waitForIdle();
        } else expect((await dispatched).success).toBe(false);
        const rows = await historyService.getLastMessages(workspaceId, 10);
        expect(rows.success && rows.data.map((row) => row.id)).toEqual(["prior"]);
        expect(stream).not.toHaveBeenCalled();
        expect(await historyService.getCompactionCancellationStorage(workspaceId).read()).toEqual(
          stopped
        );
        // The fence belongs to the old admission, not to the automatic origin itself.
        expect(
          await workspaceService.sendMessage(workspaceId, "fresh child trigger", options, {
            acceptanceOrigin: "automatic",
            synthetic: true,
            agentInitiated: true,
          })
        ).toEqual(Ok(undefined));
        expect(stream).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        busy?.mockRestore();
        await dispatched;
        await workspaceService.disposeSession(workspaceId);
        await foreign.session.dispose();
        await cleanup();
      }
    }
  );

  test("requireIdle sends carry a live idle-admission probe re-evaluated at session gates", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cJ6NI): the preflight count check at
    // sendMessage entry is a one-shot snapshot — a manual send can enter
    // preflight during the later admission awaits, before the continuation
    // makes the session busy. The forwarded admissionStale probe must sample
    // the LIVE preflight count so AgentSession's admission gates (re-evaluated
    // up to the last gate before the pre-turn batch becomes irrevocable) can
    // refuse the continuation.
    const { config, workspaceService, cleanup } = await createServices();
    const workspaceId = "require-idle-admission-probe";
    const internalAccess = workspaceService as unknown as {
      sessions: Map<string, AgentSession>;
      preflightSendCounts: Map<string, number>;
    };
    try {
      await config.addWorkspace("/tmp/require-idle-probe-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "require-idle-probe-project",
        projectPath: "/tmp/require-idle-probe-project",
        runtimeConfig: { type: "local" },
      });
      let capturedProbe: (() => boolean) | undefined;
      const fakeSession = {
        ...createCompactionAdmissionMocks(),
        isBusy: mock(() => false),
        emitMetadata: mock(() => undefined),
        drainQueuedMessagesIfIdle: mock(() => undefined),
        sendMessage: mock(
          (_msg: string, _opts: unknown, internal?: { admissionStale?: () => boolean }) => {
            capturedProbe = internal?.admissionStale;
            return Promise.resolve(Ok(undefined));
          }
        ),
      } as unknown as AgentSession;
      internalAccess.sessions.set(workspaceId, fakeSession);

      const result = await workspaceService.sendMessage(
        workspaceId,
        "Continue working on the goal.",
        { model: "openai:gpt-4o", agentId: "exec" },
        { synthetic: true, agentInitiated: true, requireIdle: true, goalContinuation: true }
      );
      expect(result.success).toBe(true);
      expect(typeof capturedProbe).toBe("function");

      // Live sampling: idle (only the continuation itself would hold a slot).
      expect(capturedProbe?.()).toBe(false);
      // A manual send entering preflight while the continuation is still in
      // its admission awaits (continuation slot + manual slot) flips the
      // probe stale — even though the entry snapshot passed.
      internalAccess.preflightSendCounts.set(workspaceId, 2);
      expect(capturedProbe?.()).toBe(true);
      internalAccess.preflightSendCounts.delete(workspaceId);
    } finally {
      internalAccess.sessions.delete(workspaceId);
      await cleanup();
    }
  });

  test("idle wait follows auto-retry startup into the resumed stream", async () => {
    const { workspaceService, cleanup } = await createServices();
    const workspaceId = "idle-wait-auto-retry-starting";
    const chatEvents = new EventEmitter();
    let busy = false;
    let pendingAutoRetry = true;
    const idleWaiters: Array<() => void> = [];
    const waitForIdle = mock(() => {
      if (!busy) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    });
    interface WaitSessionEvent {
      message: { type: string };
    }
    const session = {
      closingSignal: new AbortController().signal,
      isBusy: mock(() => busy),
      hasActiveOrPendingTurnWork: mock(() => busy),
      hasQueuedMessages: mock(() => false),
      hasPendingAutoRetry: mock(() => pendingAutoRetry),
      waitForIdle,
      onChatEvent: mock((listener: (event: WaitSessionEvent) => void) => {
        chatEvents.on("chat-event", listener);
        return () => chatEvents.off("chat-event", listener);
      }),
    } as unknown as AgentSession;
    const internalWorkspaceService = workspaceService as unknown as {
      sessions: Map<string, AgentSession>;
    };

    try {
      internalWorkspaceService.sessions.set(workspaceId, session);
      let resolved = false;
      const waitPromise = workspaceService.waitForIdleAndNoQueuedMessages(workspaceId).then(() => {
        resolved = true;
      });
      await Promise.resolve();

      chatEvents.emit("chat-event", { message: { type: "auto-retry-starting" } });
      await Promise.resolve();
      expect(resolved).toBe(false);

      busy = true;
      chatEvents.emit("chat-event", { message: { type: "stream-lifecycle" } });
      await waitForCondition(() => idleWaiters.length === 1);
      expect(resolved).toBe(false);

      busy = false;
      pendingAutoRetry = false;
      idleWaiters.splice(0).forEach((resolve) => resolve());
      await waitPromise;

      expect(resolved).toBe(true);
      expect(waitForIdle).toHaveBeenCalledTimes(1);
    } finally {
      internalWorkspaceService.sessions.delete(workspaceId);
      await cleanup();
    }
  });

  test("idle wait outlasts a pending mid-stream compaction request", async () => {
    const { workspaceService, cleanup } = await createServices();
    const workspaceId = "idle-wait-pending-compaction";
    const session = workspaceService.getOrCreateSession(workspaceId);
    const { coordinator } = session as unknown as { coordinator: TurnCoordinator };
    const token = coordinator.beginCompactionObservation("legacy");
    if (token == null) throw new Error("Expected compaction observation");
    try {
      coordinator.setCompactionStage(token, "stopping");
      let resolved = false;
      const waitPromise = workspaceService.waitForIdleAndNoQueuedMessages(workspaceId).then(() => {
        resolved = true;
      });
      await drainPendingDispatches();
      expect(resolved).toBe(false);

      // The compaction request never became a turn: no stream event fires, only the window closes.
      coordinator.finishCompactionObservation(token);
      await waitPromise;
      expect(resolved).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("destructive clear waits for startup monitor recovery discovery", async () => {
    const { historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-waits-for-monitor-recovery";
    const recovery = createDeferred<void>();
    const internal = workspaceService as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
    };
    internal.bashMonitorRecoveryPromise = recovery.promise;
    const truncateSpy = spyOn(historyService, "clearCompactionHistoryUnderHistoryLock");

    try {
      const clearPromise = workspaceService.truncateHistory(workspaceId, 1.0);
      await drainPendingDispatches();
      expect(truncateSpy).not.toHaveBeenCalled();

      recovery.resolve();
      expect(await clearPromise).toEqual(Ok(undefined));
      expect(truncateSpy).toHaveBeenCalledTimes(1);
    } finally {
      recovery.resolve();
      truncateSpy.mockRestore();
      await cleanup();
    }
  });

  test.each(
    (["clear", "replace"] as const).flatMap((kind) =>
      (["barrier", "post-deletion"] as const).map((failure) => ({ kind, failure }))
    )
  )("full $kind accounts for actual deletion when $failure fails", async ({ kind, failure }) => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const id = `clear-receipt-${kind}-${failure}`;
    const h = await createAgentSessionHarness({ workspaceId: id, config, historyService });
    workspaceService.registerSession(id, h.session);
    try {
      await config.addWorkspace("/tmp/clear-receipt-project", {
        id,
        name: id,
        projectName: "clear-receipt-project",
        projectPath: "/tmp/clear-receipt-project",
        runtimeConfig: { type: "local" },
      });
      expect(
        (await historyService.appendToHistory(id, createMuxMessage("old", "user", "old"))).success
      ).toBe(true);
      const storage = historyService.getCompactionCancellationStorage(id);
      const internal = workspaceService as unknown as {
        bashMonitorRecoveryPromise: Promise<void>;
        bashMonitorWakeReconciler: BashMonitorWakeReconciler;
        contextMutationEpochs: Map<string, number>;
      };
      await internal.bashMonitorRecoveryPromise;
      const priorEpoch = internal.contextMutationEpochs.get(id) ?? 0;
      const finish = spyOn(internal.bashMonitorWakeReconciler, "finishFullHistoryClear");
      const emit = spyOn(h.session, "emitChatEvent");
      if (failure === "barrier") {
        spyOn(internal.bashMonitorWakeReconciler, "beginFullHistoryClear").mockRejectedValueOnce(
          new Error("barrier unavailable")
        );
      } else {
        const clear = historyService.clearCompactionHistoryUnderHistoryLock.bind(historyService);
        spyOn(historyService, "clearCompactionHistoryUnderHistoryLock").mockImplementationOnce(
          async (...args) => {
            await clear(...args);
            throw new Error("post-deletion unavailable");
          }
        );
      }
      const result = await (
        kind === "clear"
          ? workspaceService.truncateHistory(id)
          : workspaceService.replaceHistory(id, createMuxMessage("new", "user", "new"))
      ).catch((error: unknown) => Err(String(error)));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain(`${failure} unavailable`);
      const history = await historyService.getHistoryFromLatestBoundary(id);
      expect(history.success && history.data.map((row) => row.id)).toEqual(
        failure === "barrier" ? ["old"] : []
      );
      expect(await storage.read()).toBeNull();
      expect(internal.contextMutationEpochs.get(id) ?? 0).toBe(
        priorEpoch + (failure === "post-deletion" ? 1 : 0)
      );
      if (failure === "post-deletion") {
        expect(finish).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith({ type: "delete", historySequences: [0] });
      } else {
        expect(finish).not.toHaveBeenCalled();
        expect(emit.mock.calls.some(([event]) => event.type === "delete")).toBe(false);
      }
    } finally {
      mock.restore();
      await h.session.dispose();
      await h.cleanup();
      await cleanup();
    }
  });

  test.each([
    ["clear", false],
    ["clear", true],
    ["replace", false],
    ["replace", true],
  ] as const)(
    "full %s deletes malformed summaries and recovers failed cancellation (delete failure=%s)",
    async (kind, failDeletion) => {
      const { config, historyService, workspaceService, cleanup } = await createServices();
      const workspaceId = `clear-malformed-summary-${kind}-${failDeletion}`;
      const h = await createAgentSessionHarness({ workspaceId, config, historyService });
      workspaceService.registerSession(workspaceId, h.session);
      try {
        await config.addWorkspace("/tmp/clear-malformed-summary-project", {
          id: workspaceId,
          name: workspaceId,
          projectName: "clear-malformed-summary-project",
          projectPath: "/tmp/clear-malformed-summary-project",
          runtimeConfig: { type: "local" },
        });
        const summary = createMuxMessage("damaged-summary", "assistant", "summary", {
          compactionBoundary: true,
          muxMetadata: {
            type: "compaction-summary",
            pendingFollowUp: { text: "obsolete input", model: "openai:gpt-4o", agentId: "exec" },
          },
        });
        expect((await historyService.appendToHistory(workspaceId, summary)).success).toBe(true);
        const chatPath = path.join(config.sessionsDir, workspaceId, "chat.jsonl");
        const damaged = JSON.stringify({ ...summary, parts: null }) + "\n";
        await fsPromises.writeFile(chatPath, damaged);
        // Ordinary Stop still refuses unsafe row-wise repair; explicit full deletion can
        // recover a workspace already left with that failed cancellation's blocking debt.
        expect((await h.session.cancelCompaction(true)).success).toBe(false);
        const foreign = new HistoryService(config);
        const generation = await foreign
          .getContinuousCompactionJournal(workspaceId)
          .captureGeneration();
        const storage = foreign.getCompactionCancellationStorage(workspaceId);
        const clear = () =>
          kind === "clear"
            ? workspaceService.truncateHistory(workspaceId)
            : workspaceService.replaceHistory(
                workspaceId,
                createMuxMessage("replacement", "assistant", "new context")
              );
        if (failDeletion) {
          const failing = spyOn(
            historyService,
            "clearCompactionHistoryUnderHistoryLock"
          ).mockRejectedValueOnce(new Error("deletion unavailable"));
          expect((await clear()).success).toBe(false);
          failing.mockRestore();
          expect(await fsPromises.readFile(chatPath, "utf8")).toBe(damaged);
          expect(await storage.read()).toBeNull();
        }
        expect(await clear()).toEqual(Ok(undefined));
        const remaining = await historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(remaining.success && remaining.data.map((row) => row.id)).toEqual(
          kind === "clear" ? [] : ["replacement"]
        );
        expect(await storage.read()).toMatchObject({ retainUntilReplacement: true });
        // A producer captured by another HistoryService before deletion cannot re-publish
        // its old boundary into the new epoch, even though the malformed row is now gone.
        const committed = mock(() => undefined);
        expect(
          await foreign.persistBoundaryWithTailCopies(workspaceId, summary, [], false, undefined, {
            publication: { generation },
            onCommitted: committed,
          })
        ).toEqual(Err("Compaction publication changed"));
        expect(committed).not.toHaveBeenCalled();
        expect(
          (
            await h.session.sendMessage("manual input after clear", {
              model: "openai:gpt-4o",
              agentId: "exec",
            })
          ).success
        ).toBe(true);
        expect(await storage.read()).toBeNull();
        const sent = await historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(sent.success && sent.data.filter((row) => row.role === "user")).toHaveLength(1);
      } finally {
        await h.session.dispose();
        await h.cleanup();
        await cleanup();
      }
    }
  );

  test("full chat clear preserves the goal and requires user acknowledgment", async () => {
    const { config, historyService, workspaceService, goalService, cleanup } =
      await createServices();
    const workspaceId = "clear-goal-workspace";
    try {
      await config.addWorkspace("/tmp/clear-goal-project", {
        id: workspaceId,
        name: "clear-goal-workspace",
        projectName: "clear-goal-project",
        projectPath: "/tmp/clear-goal-project",
        runtimeConfig: { type: "local" },
      });
      const created = await setWorkspaceGoalOk(goalService, {
        workspaceId,
        objective: "Keep pursuing the objective",
      });
      const appendResult = await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("clear-goal-message", "user", "please remember this", {})
      );
      expect(appendResult.success).toBe(true);

      const nowSpy = spyOn(Date, "now").mockReturnValue(1_234_567);
      try {
        const result = await workspaceService.truncateHistory(workspaceId, 1.0);
        expect(result.success).toBe(true);
      } finally {
        nowSpy.mockRestore();
      }

      expect(await goalService.getGoal(workspaceId)).toMatchObject({
        goalId: created.goalId,
        objective: created.objective,
        requireUserAcknowledgmentSinceMs: 1_234_567,
      });
    } finally {
      await cleanup();
    }
  });

  test("full chat clear without a goal does not create goal state", async () => {
    const { config, historyService, workspaceService, goalService, cleanup } =
      await createServices();
    const workspaceId = "clear-without-goal-workspace";
    try {
      await config.addWorkspace("/tmp/clear-without-goal-project", {
        id: workspaceId,
        name: "clear-without-goal-workspace",
        projectName: "clear-without-goal-project",
        projectPath: "/tmp/clear-without-goal-project",
        runtimeConfig: { type: "local" },
      });

      const result = await workspaceService.truncateHistory(workspaceId, 1.0);

      expect(result.success).toBe(true);
      expect(await goalService.getGoal(workspaceId)).toBeNull();
      expect(
        await historyService.getCompactionCancellationStorage(workspaceId).read()
      ).toMatchObject({ retainUntilReplacement: true });
    } finally {
      await cleanup();
    }
  });

  test("context reset appends a boundary and preserves transcript history", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-preserves-history";
    try {
      await config.addWorkspace("/tmp/context-reset-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-project",
        projectPath: "/tmp/context-reset-project",
        runtimeConfig: { type: "local" },
      });
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            createMuxMessage("pre-reset-user", "user", "before reset", {})
          )
        ).success
      ).toBe(true);

      const result = await workspaceService.resetContext(workspaceId);

      expect(result).toEqual({ success: true, data: "reset" });
      const activeWindow = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(activeWindow.success).toBe(true);
      const activeIds = activeWindow.success ? activeWindow.data.map((message) => message.id) : [];
      expect(activeIds).toHaveLength(1);
      expect(activeIds[0]?.startsWith("context-reset-")).toBe(true);
      expect(
        activeWindow.success ? activeWindow.data[0]?.metadata?.contextBoundaryKind : undefined
      ).toBe("reset");

      const allMessages: string[] = [];
      const iterateResult = await historyService.iterateFullHistory(
        workspaceId,
        "forward",
        (messages) => {
          allMessages.push(...messages.map((message) => message.id));
        }
      );
      expect(iterateResult.success).toBe(true);
      expect(allMessages).toHaveLength(2);
      expect(allMessages[0]).toBe("pre-reset-user");
      expect(allMessages[1]?.startsWith("context-reset-")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("start-here replacement does not auto-compact the next send from stale usage", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "start-here-clears-usage-state";
    const streamMessage = mock((..._args: unknown[]) =>
      Promise.resolve(Ok(createStartedTurnHandle(harness.session.closingSignal)))
    );
    const harness = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiServiceOverrides: {
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
    });
    try {
      await config.addWorkspace("/tmp/start-here-usage-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "start-here-usage-project",
        projectPath: "/tmp/start-here-usage-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-start-here-user", "user", "long conversation", {})
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-start-here-assistant", "assistant", "long reply", {
          model: "openai:gpt-4o",
          contextUsage: { inputTokens: 95_000, outputTokens: 200, totalTokens: 95_200 },
        })
      );

      (workspaceService as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
        workspaceId,
        harness.session
      );
      (harness.session as unknown as { lastUsageState?: AutoCompactionUsageState }).lastUsageState =
        {
          lastContextUsage: createDisplayUsage(
            { inputTokens: 95_000, outputTokens: 200, totalTokens: 95_200 },
            "openai:gpt-4o"
          ),
        };

      expect(
        (
          await workspaceService.replaceHistory(
            workspaceId,
            createMuxMessage("start-here-summary", "assistant", "Start Here summary", {
              compacted: "user",
            }),
            { mode: "append-compaction-boundary" }
          )
        ).success
      ).toBe(true);
      expect(
        (
          await harness.session.sendMessage("follow-up after start here", {
            model: "openai:gpt-4o",
            agentId: "exec",
          })
        ).success
      ).toBe(true);

      const activeWindow = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(activeWindow.success).toBe(true);
      const activeMessages = activeWindow.success ? activeWindow.data : [];
      expect(
        activeMessages.filter(
          (message) => message.metadata?.muxMetadata?.type === "compaction-request"
        )
      ).toHaveLength(0);
      expect(activeMessages.find((message) => message.role === "user")?.parts[0]).toMatchObject({
        type: "text",
        text: "follow-up after start here",
      });
      expect(streamMessage).toHaveBeenCalledTimes(1);
    } finally {
      await harness.session.dispose();
      await cleanup();
    }
  });

  test("context reset is a no-op when repeated without provider-eligible messages", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-noop";
    try {
      await config.addWorkspace("/tmp/context-reset-noop-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-noop-project",
        projectPath: "/tmp/context-reset-noop-project",
        runtimeConfig: { type: "local" },
      });
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            createMuxMessage("pre-reset-user", "user", "before reset", {})
          )
        ).success
      ).toBe(true);

      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "reset",
      });
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "noop",
      });

      let boundaryCount = 0;
      const iterateResult = await historyService.iterateFullHistory(
        workspaceId,
        "forward",
        (messages) => {
          boundaryCount += messages.filter(
            (message) => message.metadata?.contextBoundaryKind === "reset"
          ).length;
        }
      );
      expect(iterateResult.success).toBe(true);
      expect(boundaryCount).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("context reset discards persisted post-compaction carryover", async () => {
    // An RLM compaction persists cumulative read-file paths / loaded skills
    // (post-compaction.json). A reset starts a NEW context segment: without
    // discarding that state, a later turn would inject PRE-reset read paths
    // (even in a fresh session after a restart), resurrecting context the
    // reset was meant to discard.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-post-compaction";
    try {
      await config.addWorkspace("/tmp/context-reset-post-compaction-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-post-compaction-project",
        projectPath: "/tmp/context-reset-post-compaction-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      const sessionDir = path.join(config.sessionsDir, workspaceId);
      await fsPromises.mkdir(sessionDir, { recursive: true });
      const pendingStatePath = path.join(sessionDir, "post-compaction.json");
      const pending = new CompactionPendingState(
        pendingStatePath,
        historyService.getCompactionPendingHistory(workspaceId)
      );
      expect(
        (
          await pending.publishBoundary({
            summaryMessage: createMuxMessage("summary", "assistant", "Summary", {
              compacted: "user",
              compactionBoundary: true,
              compactionEpoch: 1,
            }),
            tailCopies: [],
            updateExisting: false,
            publication: { generation: undefined },
            attachments: { diffs: [], loadedSkills: [], readFiles: ["/tmp/pre-reset-read.ts"] },
            isCurrent: () => true,
            shouldPersist: () => true,
            onCommitted: () => undefined,
          })
        ).success
      ).toBe(true);

      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "reset",
      });

      const stateExists = await fsPromises.access(pendingStatePath).then(
        () => true,
        () => false
      );
      expect(stateExists).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("context reset repairs an empty directory at the pending-state path", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-carryover-not-durable";
    try {
      await config.addWorkspace("/tmp/context-reset-carryover-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-carryover-project",
        projectPath: "/tmp/context-reset-carryover-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      // Invalid optional state should heal without blocking a durable history reset.
      const pendingStatePath = path.join(config.sessionsDir, workspaceId, "post-compaction.json");
      await fsPromises.mkdir(pendingStatePath, { recursive: true });

      const result = await workspaceService.resetContext(workspaceId);
      expect(result.success).toBe(true);
      expect(
        await fsPromises.stat(pendingStatePath).catch((error: unknown) => error)
      ).toMatchObject({ code: "ENOENT" });
    } finally {
      await cleanup();
    }
  });

  test.each(
    (["reset", "clear", "replace"] as const).flatMap((operation) =>
      (["legacy", "future", "current"] as const).map((format) => ({ operation, format }))
    )
  )(
    "empty-history $operation durably fences initial $format carryover",
    async ({ operation, format }) => {
      const { config, historyService, workspaceService, cleanup } = await createServices();
      const workspaceId = "empty-history-carryover";
      try {
        await config.addWorkspace("/tmp/empty-history-carryover", {
          id: workspaceId,
          name: workspaceId,
          projectName: "empty-history-carryover",
          projectPath: "/tmp/empty-history-carryover",
          runtimeConfig: { type: "local" },
        });
        const pendingPath = path.join(config.sessionsDir, workspaceId, "post-compaction.json");
        let original = JSON.stringify({
          version: format === "future" ? 9 : 1,
          createdAt: 1,
          diffs: [],
          loadedSkills: [],
          readFiles: ["/tmp/discarded.ts"],
        });
        await fsPromises.mkdir(path.dirname(pendingPath), { recursive: true });
        await fsPromises.writeFile(pendingPath, original);
        const pending = new CompactionPendingState(
          pendingPath,
          historyService.getCompactionPendingHistory(workspaceId)
        );
        const journal = historyService.getContinuousCompactionJournal(workspaceId);
        if (format === "current") {
          await journal.advanceGeneration();
          expect(
            (
              await pending.publishBoundary({
                summaryMessage: createMuxMessage("A", "assistant", "", {
                  compacted: "user",
                  compactionBoundary: true,
                  compactionEpoch: 1,
                }),
                tailCopies: [],
                updateExisting: false,
                publication: { generation: await journal.captureGeneration() },
                attachments: { diffs: [], loadedSkills: [], readFiles: ["/tmp/discarded.ts"] },
                isCurrent: () => true,
                shouldPersist: () => true,
                onCommitted: () => undefined,
              })
            ).success
          ).toBe(true);
          original = await fsPromises.readFile(pendingPath, "utf8");
        }
        expect((await pending.load(() => true))?.attachments.readFiles).toEqual(
          format === "future" ? undefined : ["/tmp/discarded.ts"]
        );
        if (format !== "current") expect(await journal.captureGeneration()).toBeUndefined();
        const result =
          operation === "reset"
            ? await workspaceService.resetContext(workspaceId)
            : operation === "clear"
              ? await workspaceService.truncateHistory(workspaceId, 1)
              : await workspaceService.replaceHistory(
                  workspaceId,
                  createMuxMessage("replacement", "user", "New context")
                );
        expect(result.success).toBe(true);
        if (operation === "reset") expect(result).toEqual({ success: true, data: "noop" });
        expect(await journal.captureGeneration()).toBeDefined();
        if (format === "future")
          expect(await fsPromises.readFile(pendingPath, "utf8")).toBe(original);
        else
          expect(await fsPromises.stat(pendingPath).catch((error: unknown) => error)).toMatchObject(
            {
              code: "ENOENT",
            }
          );
        expect(await pending.load(() => true)).toBeUndefined();
        await workspaceService.disposeSession(workspaceId);
        const restarted = new CompactionPendingState(
          pendingPath,
          new HistoryService(config).getCompactionPendingHistory(workspaceId)
        );
        expect(await restarted.load(() => true)).toBeUndefined();
      } finally {
        await cleanup();
      }
    }
  );

  test("late no-op reset cleanup preserves a foreign successor after its committed fence", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "empty-reset-successor";
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let resetting: ReturnType<WorkspaceService["resetContext"]> | undefined;
    try {
      await config.addWorkspace("/tmp/empty-reset-successor", {
        id: workspaceId,
        name: workspaceId,
        projectName: "empty-reset-successor",
        projectPath: "/tmp/empty-reset-successor",
        runtimeConfig: { type: "local" },
      });
      const capture = historyService.fenceEmptyContext.bind(historyService);
      spyOn(historyService, "fenceEmptyContext").mockImplementationOnce(async (...args) => {
        const captured = await capture(...args);
        entered.resolve();
        await release.promise;
        return captured;
      });
      resetting = workspaceService.resetContext(workspaceId);
      await entered.promise;
      const foreign = new HistoryService(config);
      const foreignJournal = foreign.getContinuousCompactionJournal(workspaceId);
      await foreignJournal.advanceGeneration();
      const generation = await foreignJournal.captureGeneration();
      const pendingPath = path.join(config.sessionsDir, workspaceId, "post-compaction.json");
      const pending = new CompactionPendingState(
        pendingPath,
        foreign.getCompactionPendingHistory(workspaceId)
      );
      expect(
        (
          await pending.publishBoundary({
            summaryMessage: createMuxMessage("B", "assistant", "New context", {
              compacted: "user",
              compactionBoundary: true,
              compactionEpoch: 1,
            }),
            tailCopies: [],
            updateExisting: false,
            publication: { generation },
            attachments: { diffs: [], loadedSkills: [], readFiles: ["/tmp/successor.ts"] },
            isCurrent: () => true,
            shouldPersist: () => true,
            onCommitted: () => undefined,
          })
        ).success
      ).toBe(true);
      release.resolve();
      expect(await resetting).toEqual({ success: true, data: "noop" });
      expect(await foreignJournal.captureGeneration()).toBe(generation);
      expect((await pending.load(() => true))?.attachments.readFiles).toEqual([
        "/tmp/successor.ts",
      ]);
    } finally {
      release.resolve();
      await resetting;
      await cleanup();
    }
  });

  test.each(["absent", "probe error"] as const)(
    "post-compaction metadata avoids only proven absent pending scans (%s)",
    async (state) => {
      const { config, historyService, workspaceService, cleanup } = await createServices();
      const workspaceId = "pending-metadata-scan";
      try {
        await config.addWorkspace("/tmp/pending-metadata-project", {
          id: workspaceId,
          name: workspaceId,
          projectName: "pending-metadata-project",
          projectPath: "/tmp/pending-metadata-project",
          runtimeConfig: { type: "local" },
        });
        const edited = createMuxMessage("edited", "assistant", "");
        edited.parts = [
          {
            type: "dynamic-tool",
            toolCallId: "edit",
            toolName: "file_edit_replace_string",
            state: "output-available",
            input: { path: "/tmp/from-history.ts" },
            output: { success: true, diff: "changed" },
          },
        ];
        expect((await historyService.appendToHistory(workspaceId, edited)).success).toBe(true);
        const pendingPath = path.join(config.sessionsDir, workspaceId, "post-compaction.json");
        const stat = fsPromises.stat;
        const probe = spyOn(fsPromises, "stat").mockImplementation((async (
          ...args: Parameters<typeof fsPromises.stat>
        ) => {
          if (state === "probe error" && args[0] === pendingPath)
            throw Object.assign(new Error("Probe denied"), { code: "EACCES" });
          return stat(...args);
        }) as typeof fsPromises.stat);
        const proof = spyOn(historyScanner, "readCompactionPendingHistoryObservation");
        const fallback = spyOn(historyService, "getHistoryFromLatestBoundary");
        using _spies = {
          [Symbol.dispose]: () => {
            probe.mockRestore();
            proof.mockRestore();
            fallback.mockRestore();
          },
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(
            (await workspaceService.getPostCompactionState(workspaceId)).trackedFilePaths
          ).toEqual(["/tmp/from-history.ts"]);
        }
        expect(proof).toHaveBeenCalledTimes(state === "absent" ? 0 : 2);
        expect(fallback).toHaveBeenCalledTimes(2);
        probe.mockRestore();

        // A fresh store models another backend publishing after the earlier absence checks.
        const foreign = new HistoryService(config);
        const pending = new CompactionPendingState(
          pendingPath,
          foreign.getCompactionPendingHistory(workspaceId)
        );
        expect(
          (
            await pending.publishBoundary({
              summaryMessage: createMuxMessage("published", "assistant", "Summary", {
                compacted: "user",
                compactionBoundary: true,
                compactionEpoch: 1,
              }),
              tailCopies: [],
              updateExisting: false,
              publication: {
                generation: await foreign
                  .getContinuousCompactionJournal(workspaceId)
                  .captureGeneration(),
              },
              attachments: {
                diffs: [{ path: "/tmp/published.ts", diff: "changed", truncated: false }],
                loadedSkills: [],
                readFiles: [],
              },
              isCurrent: () => true,
              shouldPersist: () => true,
              onCommitted: () => undefined,
            })
          ).success
        ).toBe(true);
        proof.mockClear();
        fallback.mockClear();
        expect(
          (await workspaceService.getPostCompactionState(workspaceId)).trackedFilePaths
        ).toEqual(["/tmp/published.ts"]);
        expect(proof).toHaveBeenCalledTimes(1);
        expect(fallback).not.toHaveBeenCalled();
      } finally {
        await cleanup();
      }
    }
  );

  test.each([
    "current",
    "foreign boundary",
    "reset",
    "future",
    "directory",
    "nonempty directory",
  ] as const)(
    "post-compaction metadata qualifies pending paths against history (%s)",
    async (change) => {
      const { config, historyService, workspaceService, cleanup } = await createServices();
      const workspaceId = "pending-path-qualification";
      try {
        await config.addWorkspace("/tmp/pending-path-project", {
          id: workspaceId,
          name: workspaceId,
          projectName: "pending-path-project",
          projectPath: "/tmp/pending-path-project",
          runtimeConfig: { type: "local" },
        });
        const pendingPath = path.join(config.sessionsDir, workspaceId, "post-compaction.json");
        const pending = new CompactionPendingState(
          pendingPath,
          historyService.getCompactionPendingHistory(workspaceId)
        );
        expect(
          (
            await pending.publishBoundary({
              summaryMessage: createMuxMessage("A", "assistant", "A", {
                compacted: "user",
                compactionBoundary: true,
                compactionEpoch: 1,
              }),
              tailCopies: [],
              updateExisting: false,
              publication: { generation: undefined },
              attachments: {
                diffs: [{ path: "/tmp/pending.ts", diff: "changed", truncated: false }],
                loadedSkills: [],
                readFiles: [],
              },
              isCurrent: () => true,
              shouldPersist: () => true,
              onCommitted: () => undefined,
            })
          ).success
        ).toBe(true);
        if (change === "foreign boundary")
          expect(
            (
              await historyService.appendToHistory(
                workspaceId,
                createMuxMessage("B", "assistant", "B", {
                  compacted: "user",
                  compactionBoundary: true,
                  compactionEpoch: 2,
                })
              )
            ).success
          ).toBe(true);
        else if (change === "reset")
          expect((await historyService.clearHistory(workspaceId)).success).toBe(true);
        const future = '{"version":9,"diffs":[{"path":"/tmp/future.ts"}]}\n';
        if (change === "future") await fsPromises.writeFile(pendingPath, future);
        if (change === "directory" || change === "nonempty directory") {
          await fsPromises.unlink(pendingPath);
          await fsPromises.mkdir(pendingPath);
          if (change === "nonempty directory")
            await fsPromises.writeFile(path.join(pendingPath, "keep"), "Owned content");
        }
        const proof = spyOn(historyScanner, "readCompactionPendingHistoryObservation");
        using _proof = { [Symbol.dispose]: () => proof.mockRestore() };
        expect(
          (await workspaceService.getPostCompactionState(workspaceId)).trackedFilePaths
        ).toEqual(change === "current" ? ["/tmp/pending.ts"] : []);
        expect(proof).toHaveBeenCalledTimes(1);
        if (change === "future")
          expect(await fsPromises.readFile(pendingPath, "utf8")).toBe(future);
        if (change === "directory")
          expect(await fsPromises.stat(pendingPath).catch((error: unknown) => error)).toMatchObject(
            { code: "ENOENT" }
          );
        if (change === "nonempty directory")
          expect(await fsPromises.readFile(path.join(pendingPath, "keep"), "utf8")).toBe(
            "Owned content"
          );
      } finally {
        await cleanup();
      }
    }
  );

  test("context reset fails when the sandbox invalidation is not durable", async () => {
    // The reset's kernel-vars invalidation is only durable once the
    // empty-snapshot tombstone publishes; the in-memory reset-pending guard
    // dies with the process. Reporting Ok on a failed publish would hide that
    // a restart can resurrect the cleared (potentially sensitive) vars, so
    // the failure must reach the caller as a partial-failure error.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-sandbox-invalidation";
    try {
      await config.addWorkspace("/tmp/context-reset-sandbox-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-sandbox-project",
        projectPath: "/tmp/context-reset-sandbox-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      const discardSpy = spyOn(sandboxHostService, "discardScope").mockImplementationOnce(() =>
        Promise.reject(new Error("journal write failed"))
      );

      try {
        const result = await workspaceService.resetContext(workspaceId);
        expect(result.success).toBe(false);
        expect(result.success ? "" : result.error).toContain("durably invalidated");
        expect(result.success ? "" : result.error).toContain("journal write failed");

        // A retry reaches the no-op branch (the boundary row already
        // landed) — it must RE-ATTEMPT the pending cleanup, not report
        // success while the invalidation is still not durable: a restart
        // could otherwise restore pre-reset kernel vars across the boundary.
        discardSpy.mockImplementationOnce(() => Promise.reject(new Error("journal write failed")));
        const retry = await workspaceService.resetContext(workspaceId);
        expect(retry.success).toBe(false);
        expect(retry.success ? "" : retry.error).toContain("durably invalidated");
      } finally {
        discardSpy.mockRestore();
      }

      // Once cleanup succeeds, the retry settles as a clean noop (the
      // chat-side boundary already applied; the real discard re-runs and
      // lands durably).
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "noop",
      });
    } finally {
      await cleanup();
    }
  });

  test("full history clear durably discards sandbox kernel state", async () => {
    // A full /clear removes the transcript; kernel vars DERIVED from it (and
    // restorable from the latest durable snapshot after a restart) must not
    // stay readable through the sandbox — same invalidation boundary as
    // resetContext. Partial truncation keeps context, so it must NOT discard.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "full-clear-sandbox-discard";
    try {
      await config.addWorkspace("/tmp/full-clear-sandbox-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "full-clear-sandbox-project",
        projectPath: "/tmp/full-clear-sandbox-project",
        runtimeConfig: { type: "local" },
      });
      // A larger first row: 50% removes only it, keeping the truncation genuinely partial
      // (a one-message 50% empties history and routes as a full clear).
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", LONGER_FIRST_ROW_TEXT, {})
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user-b", "user", "still here", {})
      );
      const discardSpy = spyOn(sandboxHostService, "discardScope").mockImplementation(() =>
        Promise.resolve()
      );
      try {
        expect(await workspaceService.truncateHistory(workspaceId, 0.5)).toEqual({
          success: true,
          data: undefined,
        });
        expect(discardSpy).not.toHaveBeenCalled();

        expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
          success: true,
          data: undefined,
        });
        expect(discardSpy).toHaveBeenCalledTimes(1);

        // Same partial-failure posture as resetContext: history IS cleared,
        // but a non-durable invalidation must fail the operation (a restart
        // could otherwise resurrect the cleared vars from the snapshot).
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage("pre-clear-user-2", "user", "before second clear", {})
        );
        discardSpy.mockImplementationOnce(() => Promise.reject(new Error("journal write failed")));
        const failed = await workspaceService.truncateHistory(workspaceId);
        expect(failed.success).toBe(false);
        expect(failed.success ? "" : failed.error).toContain("durably invalidated");
      } finally {
        discardSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context-discarding mutations drain in-flight refine passes", async () => {
    // A streaming refine pass distills the current transcript; reset and
    // full clear discard it, so both must cancel + drain the pass before
    // mutating (a late proposal would otherwise describe discarded context).
    // Partial truncation keeps context and must NOT drain.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-drains-refine";
    try {
      await config.addWorkspace("/tmp/clear-drains-refine-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-drains-refine-project",
        projectPath: "/tmp/clear-drains-refine-project",
        runtimeConfig: { type: "local" },
      });
      // A larger first row keeps the 50% truncation genuinely partial (see the sandbox
      // discard test above).
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", LONGER_FIRST_ROW_TEXT, {})
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user-b", "user", "still here", {})
      );
      const drained: string[] = [];
      workspaceService.setRefinePassCanceller({
        cancelInFlightRefinePass: (id) => {
          drained.push(id);
          return Promise.resolve();
        },
      });

      expect((await workspaceService.truncateHistory(workspaceId, 0.5)).success).toBe(true);
      expect(drained).toHaveLength(0);

      expect((await workspaceService.truncateHistory(workspaceId)).success).toBe(true);
      expect(drained).toEqual([workspaceId]);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      expect((await workspaceService.resetContext(workspaceId)).success).toBe(true);
      expect(drained).toEqual([workspaceId, workspaceId]);
    } finally {
      await cleanup();
    }
  });

  test("context-discarding mutations block send admission across their awaits (r40)", async () => {
    // SECURITY: a full clear awaits the refine drain + cross-process lock
    // BETWEEN its busy check and the truncation. A send admitted during that
    // window would snapshot the pre-clear transcript and stream across the
    // clear, repopulating the cleared context — so the mutation publishes an
    // admission guard BEFORE its first await: new sends reject at the door
    // and concurrent mutations are refused.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-blocks-sends";
    try {
      await config.addWorkspace("/tmp/clear-blocks-sends-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-blocks-sends-project",
        projectPath: "/tmp/clear-blocks-sends-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );
      const drainStarted = createDeferred<void>();
      const releaseDrain = createDeferred<void>();
      workspaceService.setRefinePassCanceller({
        cancelInFlightRefinePass: async () => {
          drainStarted.resolve();
          await releaseDrain.promise;
        },
      });

      const clearPromise = workspaceService.truncateHistory(workspaceId);
      await drainStarted.promise;

      // Mid-await: the guard is already published.
      const sendResult = await workspaceService.sendMessage(workspaceId, "hello", {
        model: "anthropic:claude-sonnet-4-6",
        thinkingLevel: "off",
        toolPolicy: [],
        agentId: "exec",
      });
      expect(sendResult).toEqual({
        success: false,
        error: {
          type: "unknown",
          raw: "Workspace history is being cleared or reset. Please wait and try again.",
        },
      });
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: false,
        error: "A context reset or clear is already in progress for this workspace.",
      });

      releaseDrain.resolve();
      expect(await clearPromise).toEqual({ success: true, data: undefined });
      // Guard released: a follow-up mutation is admitted again.
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "noop",
      });
    } finally {
      await cleanup();
    }
  });

  test("full clear fails closed when a turn starts during its awaits (r40)", async () => {
    // A turn start that bypasses send admission (in-turn compaction retries
    // crossing a transient idle gap) can begin streaming while the clear sits
    // in its refine drain/lock awaits. The busy recheck under the guard +
    // lock must fail the mutation instead of truncating under a live stream.
    let streaming = false;
    const aiService = {
      ...createStreamLifecycleMocks(),
      on: mock(() => undefined),
      isStreaming: mock(() => streaming),
    } as unknown as AIService;
    const { config, historyService, workspaceService, cleanup } = await createServices(aiService);
    const workspaceId = "clear-recheck-busy";
    try {
      await config.addWorkspace("/tmp/clear-recheck-busy-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-recheck-busy-project",
        projectPath: "/tmp/clear-recheck-busy-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );
      workspaceService.setRefinePassCanceller({
        cancelInFlightRefinePass: () => {
          // A stream starts exactly inside the mutation's await window.
          streaming = true;
          return Promise.resolve();
        },
      });

      const result = await workspaceService.truncateHistory(workspaceId);
      expect(result).toEqual({
        success: false,
        error:
          "Cannot truncate history while a turn is active. Press Esc to stop the stream first.",
      });
      // Failed closed: nothing was truncated under the live stream.
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success ? history.data : []).toHaveLength(1);

      // Once the stream ends, the clear (and its admission guard) work again.
      streaming = false;
      workspaceService.setRefinePassCanceller({
        cancelInFlightRefinePass: () => Promise.resolve(),
      });
      expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
        success: true,
        data: undefined,
      });
    } finally {
      await cleanup();
    }
  });

  test("acquireIdleTurnExclusion refuses busy workspaces and blocks turn admission while held (r40)", async () => {
    // /refine publication rides this exclusion: it must fail closed when a
    // turn is active and, while held, refuse new turn admission so the
    // published row cannot land inside a PREPARING snapshot window.
    let streaming = true;
    const aiService = {
      ...createStreamLifecycleMocks(),
      on: mock(() => undefined),
      isStreaming: mock(() => streaming),
    } as unknown as AIService;
    const { config, workspaceService, cleanup } = await createServices(aiService);
    const workspaceId = "refine-turn-exclusion";
    try {
      await config.addWorkspace("/tmp/refine-turn-exclusion-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "refine-turn-exclusion-project",
        projectPath: "/tmp/refine-turn-exclusion-project",
        runtimeConfig: { type: "local" },
      });

      expect(workspaceService.acquireIdleTurnExclusion(workspaceId)).toEqual({
        success: false,
        error: "a turn is preparing or streaming",
      });

      streaming = false;
      const exclusion = workspaceService.acquireIdleTurnExclusion(workspaceId);
      expect(exclusion.success).toBe(true);
      if (!exclusion.success) return;
      try {
        const sendResult = await workspaceService.sendMessage(workspaceId, "hello", {
          model: "anthropic:claude-sonnet-4-6",
          thinkingLevel: "off",
          toolPolicy: [],
          agentId: "exec",
        });
        expect(sendResult).toEqual({
          success: false,
          error: {
            type: "unknown",
            raw: "Workspace history is being cleared or reset. Please wait and try again.",
          },
        });
      } finally {
        exclusion.data[Symbol.dispose]();
      }
    } finally {
      await cleanup();
    }
  });

  test("acquireIdleTurnExclusion refuses while a send is in its pre-admission window (r41)", async () => {
    // Release-before-resume: a send past the entry check may have already
    // persisted its user row while the session still looks idle. If refine
    // published and released here, the proposal row would land after that
    // user row and enter the send's request as a trailing foreign assistant
    // row — the exclusion must refuse instead.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "refine-preflight-send";
    try {
      await config.addWorkspace("/tmp/refine-preflight-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "refine-preflight-project",
        projectPath: "/tmp/refine-preflight-project",
        runtimeConfig: { type: "local" },
      });

      const appendReached = createDeferred<void>();
      const releaseAppend = createDeferred<void>();
      const originalAppend = historyService.acceptCompactionReplacement.bind(historyService);
      const appendSpy = spyOn(historyService, "acceptCompactionReplacement").mockImplementationOnce(
        async (...args: Parameters<HistoryService["acceptCompactionReplacement"]>) => {
          appendReached.resolve();
          await releaseAppend.promise;
          return originalAppend(...args);
        }
      );
      try {
        const sendPromise = workspaceService.sendMessage(workspaceId, "hello", {
          model: "anthropic:claude-sonnet-4-6",
          thinkingLevel: "off",
          toolPolicy: [],
          agentId: "exec",
        });
        await appendReached.promise;

        expect(workspaceService.acquireIdleTurnExclusion(workspaceId)).toEqual({
          success: false,
          error: "a send is being admitted",
        });

        releaseAppend.resolve();
        // The send fails at stream startup (no provider in this fixture) —
        // only its settled outcome matters here.
        await sendPromise;

        // Preflight released: the exclusion is available again.
        const exclusion = workspaceService.acquireIdleTurnExclusion(workspaceId);
        expect(exclusion.success).toBe(true);
        if (exclusion.success) {
          exclusion.data[Symbol.dispose]();
        }
      } finally {
        appendSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context mutations are refused while a send is in its pre-admission window (r42)", async () => {
    // SECURITY: a send past the entry check may have passed its pre-persist
    // gate but not yet appended its rows (family payload + user row). A
    // mutation committing in that window would leave those rows — composed
    // against, and possibly influenced by, the discarded context — durably in
    // the fresh transcript: the epoch gate blocks the send's stream but
    // cannot un-append. The mutation must refuse while the send is in
    // preflight, and succeed again once it settles.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "mutation-refuses-preflight";
    try {
      await config.addWorkspace("/tmp/mutation-refuses-preflight-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "mutation-refuses-preflight-project",
        projectPath: "/tmp/mutation-refuses-preflight-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );

      // Park the send at its user-row append: past every entry check and the
      // pre-persist gate, strictly before its rows land.
      const appendReached = createDeferred<void>();
      const releaseAppend = createDeferred<void>();
      const originalAppend = historyService.acceptCompactionReplacement.bind(historyService);
      const appendSpy = spyOn(historyService, "acceptCompactionReplacement").mockImplementationOnce(
        async (...args: Parameters<HistoryService["acceptCompactionReplacement"]>) => {
          appendReached.resolve();
          await releaseAppend.promise;
          return originalAppend(...args);
        }
      );
      try {
        const sendPromise = workspaceService.sendMessage(workspaceId, "hello", {
          model: "anthropic:claude-sonnet-4-6",
          thinkingLevel: "off",
          toolPolicy: [],
          agentId: "exec",
        });
        await appendReached.promise;

        expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
          success: false,
          error: "Cannot truncate history while a message is being sent. Try again in a moment.",
        });
        expect(await workspaceService.resetContext(workspaceId)).toEqual({
          success: false,
          error: "Cannot reset context while a message is being sent. Try again in a moment.",
        });

        releaseAppend.resolve();
        // The send fails at stream startup (no provider in this fixture) —
        // only its settled outcome matters here.
        await sendPromise;

        // Preflight settled: the clear is admitted and discards everything,
        // including the send's rows — nothing straddles the mutation.
        expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
          success: true,
          data: undefined,
        });
        const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(history.success ? history.data : ["unexpected"]).toHaveLength(0);
      } finally {
        appendSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context mutations and refine exclusion refuse while mid-stream compaction is pending (r43)", async () => {
    // interruptForCompaction stops the original stream, waits for idle, then
    // calls AgentSession.sendMessage directly — bypassing WorkspaceService
    // entry accounting. During that window the session looks idle, so
    // mutations and refine publication must treat pending mid-stream
    // compaction as turn work and refuse.
    const { config, workspaceService, cleanup } = await createServices();
    const workspaceId = "midstream-compaction-guard";
    try {
      await config.addWorkspace("/tmp/midstream-compaction-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "midstream-compaction-project",
        projectPath: "/tmp/midstream-compaction-project",
        runtimeConfig: { type: "local" },
      });
      const session = workspaceService.getOrCreateSession(workspaceId);
      const pendingSpy = spyOn(session, "hasActiveOrPendingTurnWork").mockReturnValue(true);
      try {
        expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
          success: false,
          error:
            "Cannot truncate history while a turn is active. Press Esc to stop the stream first.",
        });
        expect(await workspaceService.resetContext(workspaceId)).toEqual({
          success: false,
          error: "Cannot reset context while a turn is active. Press Esc to stop the stream first.",
        });
        expect(workspaceService.acquireIdleTurnExclusion(workspaceId)).toEqual({
          success: false,
          error: "a turn is preparing or streaming",
        });
      } finally {
        pendingSpy.mockRestore();
      }
      // Window closed: mutations are admitted again.
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "noop",
      });
    } finally {
      await cleanup();
    }
  });

  /**
   * Seed a fork-shaped history and drive a background abandoned-branch
   * summary until its row is durably appended, leaving the registration
   * settled but unconsumed (the r43/r44 scenario: settled before the fork's
   * first send). History ends up with 3 rows: m1, m2, summary.
   */
  async function seedSettledBranchSummaryRegistration(
    historyService: HistoryService,
    workspaceId: string
  ): Promise<void> {
    // Fork shape: kept rows end at the guard tail; the abandoned branch is
    // meaty enough to clear the summarization threshold.
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("m1", "user", "original question", { timestamp: 1 })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("m2", "assistant", "branch point answer", { timestamp: 2 })
    );
    const filler = "investigated the flaky test and traced the race ".repeat(200);
    const abandonedMessages = [
      createMuxMessage("abandoned-user", "user", `Please fix this: ${filler}`, { timestamp: 3 }),
      createMuxMessage("abandoned-assistant", "assistant", `Findings: ${filler}`, {
        timestamp: 4,
      }),
    ];
    const summaryAiService: BranchSummaryAiService = {
      createModelWithPinnedMetadata: (modelString: string) =>
        Promise.resolve(
          Ok({
            model: new MockLanguageModelV3({
              doStream: () =>
                Promise.resolve({
                  stream: simulateReadableStream({
                    chunks: [
                      { type: "text-start", id: "t1" },
                      { type: "text-delta", id: "t1", delta: "Abandoned: explored a race." },
                      { type: "text-end", id: "t1" },
                      {
                        type: "finish",
                        finishReason: { unified: "stop", raw: "stop" },
                        usage: {
                          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                          outputTokens: { total: 5, text: 5, reasoning: 0 },
                        },
                      } satisfies LanguageModelV3StreamPart,
                    ] satisfies LanguageModelV3StreamPart[],
                  }),
                }),
            }),
            metadataModel: modelString,
          })
        ) as ReturnType<BranchSummaryAiService["createModelWithPinnedMetadata"]>,
      getWorkspaceMetadata: () =>
        Promise.resolve(Ok({ aiSettings: { model: "anthropic:claude-haiku-4-5" } })) as ReturnType<
          BranchSummaryAiService["getWorkspaceMetadata"]
        >,
    };
    await startAbandonedBranchSummaryInBackground({
      historyService,
      aiService: summaryAiService,
      workspaceId,
      abandonedMessages,
      experiments: { rlm: true, programmaticToolCalling: true },
      guardTailMessageId: "m2",
    });
    // Wait for the background generation to append + settle WITHOUT
    // consuming the registration.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (history.success && history.data.length === 3) return;
      if (Date.now() > deadline) {
        throw new Error("branch summary row never appended");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  test("a full clear drops a settled-but-unconsumed branch-summary registration (r43)", async () => {
    // A fork's summary can append and settle before the fork's first send;
    // the registration stays consumable so that send can emit the row. A
    // full clear deletes the row — the registration must be dropped with it,
    // or the next send re-emits the discarded summary into the live
    // transcript (absent from history after reload).
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-drops-summary-registration";
    try {
      await config.addWorkspace("/tmp/clear-drops-summary-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-drops-summary-project",
        projectPath: "/tmp/clear-drops-summary-project",
        runtimeConfig: { type: "local" },
      });
      await seedSettledBranchSummaryRegistration(historyService, workspaceId);

      expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
        success: true,
        data: undefined,
      });

      // The registration went with the row: nothing left to re-emit.
      expect(await awaitPendingBranchSummary(workspaceId)).toBeNull();
      const cleared = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(cleared.success ? cleared.data : ["unexpected"]).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("a failed full clear retains the settled branch-summary registration (r44)", async () => {
    // The registration is dropped only AFTER the truncation commits: dropping
    // it first and then failing the write would leave the durable summary row
    // in history with nothing left to emit it — the provider would see
    // assistant context the user cannot see until a reload.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "failed-clear-retains-registration";
    try {
      await config.addWorkspace("/tmp/failed-clear-retains-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "failed-clear-retains-project",
        projectPath: "/tmp/failed-clear-retains-project",
        runtimeConfig: { type: "local" },
      });
      await seedSettledBranchSummaryRegistration(historyService, workspaceId);

      const truncateSpy = spyOn(
        historyService,
        "clearCompactionHistoryUnderHistoryLock"
      ).mockRejectedValueOnce(new Error("disk full"));
      try {
        expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
          success: false,
          error: "disk full",
        });
      } finally {
        truncateSpy.mockRestore();
      }

      // The registration survived the failed clear: the next send still
      // consumes and emits the row, which remains in history.
      const summary = await awaitPendingBranchSummary(workspaceId);
      expect(summary).not.toBeNull();
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data.some((row) => row.id === summary?.id)).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  test("context-discarding mutations drop pending partials so retries cannot replay them (r41)", async () => {
    // A retry scheduled during backoff would fire after the guard releases,
    // commit the pre-mutation partial, and stream a request derived from the
    // discarded context — mutations must durably drop that state first, and
    // fail closed when they cannot.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-discards-partial";
    try {
      await config.addWorkspace("/tmp/clear-discards-partial-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-discards-partial-project",
        projectPath: "/tmp/clear-discards-partial-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );
      const seedPartial = () =>
        historyService.writePartial(
          workspaceId,
          createMuxMessage("partial-1", "assistant", "pre-mutation partial", {})
        );

      // getOrCreateSession must exist for the discard hook to run.
      await seedPartial();
      expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
        success: true,
        data: undefined,
      });
      expect(await historyService.readPartial(workspaceId)).toBeNull();

      // Reset drops the partial too — even on its no-op branch the discard
      // runs before the history read, so stale retry state cannot survive.
      await seedPartial();
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "noop",
      });
      expect(await historyService.readPartial(workspaceId)).toBeNull();

      // Fail closed: an undeletable partial blocks the clear.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("post-clear-user", "user", "again", {})
      );
      await seedPartial();
      const deleteSpy = spyOn(historyService, "deletePartial").mockImplementationOnce(() =>
        Promise.resolve(Err("disk full"))
      );
      try {
        const blocked = await workspaceService.truncateHistory(workspaceId);
        expect(blocked).toEqual({
          success: false,
          error: "Cannot clear history: pending retry state could not be discarded (disk full)",
        });
        // Nothing was truncated.
        const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(history.success ? history.data : []).toHaveLength(1);
      } finally {
        deleteSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context reset surfaces active-context history read failures", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-history-read-fails";
    try {
      await config.addWorkspace("/tmp/context-reset-history-read-fails-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-history-read-fails-project",
        projectPath: "/tmp/context-reset-history-read-fails-project",
        runtimeConfig: { type: "local" },
      });
      const historySpy = spyOn(historyService, "fenceEmptyContext").mockResolvedValueOnce(
        Err("read failed")
      );

      try {
        const result = await workspaceService.resetContext(workspaceId);

        expect(result).toEqual({
          success: false,
          error: "read failed",
        });
      } finally {
        historySpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context reset rejects active streams", async () => {
    const aiService = {
      ...createStreamLifecycleMocks(),
      on: mock(() => undefined),
      isStreaming: mock(() => true),
    } as unknown as AIService;
    const { config, workspaceService, cleanup } = await createServices(aiService);
    const workspaceId = "context-reset-active-stream";
    try {
      await config.addWorkspace("/tmp/context-reset-active-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-active-project",
        projectPath: "/tmp/context-reset-active-project",
        runtimeConfig: { type: "local" },
      });

      const result = await workspaceService.resetContext(workspaceId);

      expect(result.success).toBe(false);
      expect(result.success ? undefined : result.error).toBe(
        "Cannot reset context while a turn is active. Press Esc to stop the stream first."
      );
    } finally {
      await cleanup();
    }
  });

  test("context reset rejects queued or preparing turns", async () => {
    const { config, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-queued-turn";
    try {
      await config.addWorkspace("/tmp/context-reset-queued-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-queued-project",
        projectPath: "/tmp/context-reset-queued-project",
        runtimeConfig: { type: "local" },
      });
      const pendingSpy = spyOn(
        workspaceService,
        "hasPendingQueuedOrPreparingTurn"
      ).mockReturnValueOnce(true);

      try {
        const result = await workspaceService.resetContext(workspaceId);

        expect(result.success).toBe(false);
        expect(result.success ? undefined : result.error).toBe(
          "Cannot reset context while queued user input is pending. Send or clear the queued message first."
        );
      } finally {
        pendingSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context reset preserves plan files", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-preserves-plan-file";
    const projectName = "context-reset-preserves-plan-project";
    try {
      await config.addWorkspace(`/tmp/${projectName}`, {
        id: workspaceId,
        name: workspaceId,
        projectName,
        projectPath: `/tmp/${projectName}`,
        runtimeConfig: { type: "local" },
      });
      const planFile = await writePlanFile(config.rootDir, projectName, workspaceId);
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            createMuxMessage("pre-reset-user", "user", "before reset", {})
          )
        ).success
      ).toBe(true);

      const result = await workspaceService.resetContext(workspaceId);

      expect(result).toEqual({ success: true, data: "reset" });
      await fsPromises.access(planFile);
    } finally {
      await cleanup();
    }
  });

  test("context reset does not clear plan files when boundary append fails", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-append-fails";
    try {
      await config.addWorkspace("/tmp/context-reset-append-fails-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-append-fails-project",
        projectPath: "/tmp/context-reset-append-fails-project",
        runtimeConfig: { type: "local" },
      });
      const planFile = await writePlanFile(
        config.rootDir,
        "context-reset-append-fails-project",
        workspaceId
      );
      const seedResult = await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      expect(seedResult.success).toBe(true);
      const appendSpy = spyOn(historyService, "appendToHistory").mockResolvedValueOnce(
        Err("disk full")
      );

      try {
        const result = await workspaceService.resetContext(workspaceId);

        expect(result.success).toBe(false);
        expect(result.success ? undefined : result.error).toBe(
          "Failed to append context reset boundary: disk full"
        );
        await fsPromises.access(planFile);
      } finally {
        appendSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context reset remains successful when post-boundary goal acknowledgment fails", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-goal-ack-fails";
    try {
      await config.addWorkspace("/tmp/context-reset-goal-ack-fails-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-goal-ack-fails-project",
        projectPath: "/tmp/context-reset-goal-ack-fails-project",
        runtimeConfig: { type: "local" },
      });
      workspaceService.setWorkspaceGoalService({
        requireUserAcknowledgment: mock(() => Promise.reject(new Error("goal write failed"))),
      } as unknown as WorkspaceGoalService);
      const seedResult = await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      expect(seedResult.success).toBe(true);

      const result = await workspaceService.resetContext(workspaceId);

      expect(result).toEqual({ success: true, data: "reset" });
    } finally {
      await cleanup();
    }
  });

  test("context reset rejects duplicate resets and sends while a reset is in progress", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-reentrancy";
    try {
      await config.addWorkspace("/tmp/context-reset-reentrancy-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-reentrancy-project",
        projectPath: "/tmp/context-reset-reentrancy-project",
        runtimeConfig: { type: "local" },
      });
      const historyDeferred =
        createDeferred<Awaited<ReturnType<HistoryService["getHistoryFromLatestBoundary"]>>>();
      const historySpy = spyOn(
        historyService,
        "getHistoryFromLatestBoundary"
      ).mockImplementationOnce(() => historyDeferred.promise);

      try {
        const firstReset = workspaceService.resetContext(workspaceId);
        await Promise.resolve();

        const duplicateReset = await workspaceService.resetContext(workspaceId);
        expect(duplicateReset).toEqual({
          success: false,
          error: "A context reset or clear is already in progress for this workspace.",
        });

        const sendResult = await workspaceService.sendMessage(workspaceId, "hello", {
          model: "anthropic:claude-sonnet-4-6",
          thinkingLevel: "off",
          toolPolicy: [],
          agentId: "exec",
        });
        expect(sendResult).toEqual({
          success: false,
          error: {
            type: "unknown",
            raw: "Workspace history is being cleared or reset. Please wait and try again.",
          },
        });

        historyDeferred.resolve(Ok([]));
        expect(await firstReset).toEqual({ success: true, data: "noop" });
      } finally {
        historySpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context reset preserves the goal and requires user acknowledgment", async () => {
    const { config, historyService, workspaceService, goalService, cleanup } =
      await createServices();
    const workspaceId = "context-reset-goal-workspace";
    try {
      await config.addWorkspace("/tmp/context-reset-goal-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-goal-project",
        projectPath: "/tmp/context-reset-goal-project",
        runtimeConfig: { type: "local" },
      });
      const created = await setWorkspaceGoalOk(goalService, {
        workspaceId,
        objective: "Keep pursuing the objective",
      });
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            createMuxMessage("pre-reset-user", "user", "before reset", {})
          )
        ).success
      ).toBe(true);

      const nowSpy = spyOn(Date, "now").mockReturnValue(1_234_568);
      try {
        const result = await workspaceService.resetContext(workspaceId);
        expect(result.success).toBe(true);
      } finally {
        nowSpy.mockRestore();
      }

      expect(await goalService.getGoal(workspaceId)).toMatchObject({
        goalId: created.goalId,
        objective: created.objective,
        requireUserAcknowledgmentSinceMs: 1_234_568,
      });
    } finally {
      await cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Codex P1 (PRRT_kwDOPxxmWM5_ucm2): the WorkspaceService stream-abort
  // listener must NOT replay queued goal mutations on user-aborted streams.
  // `applyPendingAfterStreamEnd` consumes `pendingGoalMutations` synchronously
  // before its first await, while `recordUserStoppedStream` (which clears the
  // map) runs later in the AgentSession listener — so without an explicit
  // skip, a user who interrupted a stream mid-objective-edit would still see
  // the queued edit committed, defeating the stop-to-cancel safety contract
  // (DEREM-18).
  // ---------------------------------------------------------------------------
  test("user-aborted streams do NOT replay queued goal mutations", async () => {
    const aiEmitter = new EventEmitter();
    const aiService = Object.assign(aiEmitter, {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
    }) as unknown as AIService;
    const { config, workspaceService, goalService, cleanup } = await createServices(aiService);
    const workspaceId = "user-abort-discards-mutation";
    try {
      await config.addWorkspace("/tmp/user-abort-test-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath: "/tmp/user-abort-test-project",
        runtimeConfig: { type: "local" },
      });
      // Voids the unused-var warning; workspaceService just needs to exist.
      void workspaceService;

      const created = await setWorkspaceGoalOk(goalService, {
        workspaceId,
        objective: "Original objective",
      });

      // Queue a mid-stream mutation (the real flow goes through
      // setGoal-while-streaming; we override the private streaming check
      // directly to avoid plumbing an entire AgentSession into this test).
      const goalServiceAccess = goalService as unknown as {
        isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
      };
      const isStreamingOriginal = goalServiceAccess.isWorkspaceStreaming;
      goalServiceAccess.isWorkspaceStreaming = () => Promise.resolve(true);
      try {
        const queued = await goalService.setGoal({
          workspaceId,
          objective: "Should be dropped on user abort",
          expectedGoalId: created.goalId,
        });
        expect(queued.success).toBe(true);
      } finally {
        goalServiceAccess.isWorkspaceStreaming = isStreamingOriginal;
      }

      // Mirror the real AgentSession listener: when abortReason === "user",
      // `recordUserStoppedStream` clears `pendingGoalMutations`. The
      // WorkspaceService stream-abort listener fires synchronously on the
      // emit below, before this clear — so the new gate inside that listener
      // is what prevents the replay.
      aiService.emit("stream-abort", {
        type: "stream-abort",
        workspaceId,
        messageId: "msg",
        abortReason: "user",
        metadata: { duration: 1 },
        abandonPartial: true,
      });
      await goalService.recordUserStoppedStream(workspaceId);

      // Drain pending microtasks to give any racing
      // applyPendingAfterStreamEnd a chance to fire.
      await drainPendingDispatches();

      const persisted = await goalService.getGoal(workspaceId);
      expect(persisted?.objective).toBe("Original objective");
    } finally {
      await cleanup();
    }
  });

  // A goal set mid-stream is held as optimistic state until stream-end
  // persistence, so goal.json keeps the pre-stream goal. Non-goal activity
  // emits (status_set/todo_write/recency) read that persisted goal and, before
  // this overlay, replaced the activity snapshot with the stale goal — the Goal
  // tab flickered back to the old goal until the next goal read. The overlay
  // keeps the optimistic goal visible, and clears once the goal service drops
  // the pending mutation (abort / stream-end).
  test("mid-stream activity emits surface the optimistic goal, then revert on user abort", async () => {
    const aiEmitter = new EventEmitter();
    const aiService = Object.assign(aiEmitter, {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
    }) as unknown as AIService;
    const { config, workspaceService, goalService, cleanup } = await createServices(aiService);
    const workspaceId = "midstream-goal-overlay";
    try {
      await config.addWorkspace("/tmp/midstream-goal-overlay-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath: "/tmp/midstream-goal-overlay-project",
        runtimeConfig: { type: "local" },
      });

      const created = await setWorkspaceGoalOk(goalService, {
        workspaceId,
        objective: "Pre-stream goal",
      });

      // Queue a goal set mid-stream (publishes an optimistic, pendingPersistence
      // snapshot without persisting goal.json).
      const goalServiceAccess = goalService as unknown as {
        isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
      };
      const isStreamingOriginal = goalServiceAccess.isWorkspaceStreaming;
      goalServiceAccess.isWorkspaceStreaming = () => Promise.resolve(true);
      try {
        const queued = await goalService.setGoal({
          workspaceId,
          objective: "Optimistic mid-stream goal",
          expectedGoalId: created.goalId,
        });
        expect(queued.success).toBe(true);
      } finally {
        goalServiceAccess.isWorkspaceStreaming = isStreamingOriginal;
      }

      // The durable goal.json still holds the pre-stream goal.
      expect((await goalService.getGoal(workspaceId))?.objective).toBe("Pre-stream goal");

      const activityEvents: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      const listener = (event: {
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }) => activityEvents.push(event);
      workspaceService.on("activity", listener);
      try {
        // A non-goal activity emit reads persisted metadata (still the pre-stream
        // goal) but must surface the optimistic goal so the Goal tab is stable.
        await workspaceService.updateAgentStatus(workspaceId, { emoji: "🛠️", message: "Working" });
        expect(activityEvents.at(-1)?.activity?.goal).toMatchObject({
          objective: "Optimistic mid-stream goal",
          pendingPersistence: true,
        });

        // The bootstrap path (renderer reconnect/reload) builds straight from
        // persisted metadata, so it must apply the same overlay.
        const listed = await workspaceService.getActivityList();
        expect(listed?.[workspaceId]?.goal).toMatchObject({
          objective: "Optimistic mid-stream goal",
          pendingPersistence: true,
        });

        // User aborts: the goal service drops the queued mutation and reverts the
        // panel to the persisted goal. Subsequent activity emits must show that
        // reverted goal, not the discarded optimistic one.
        await goalService.recordUserStoppedStream(workspaceId);
        await workspaceService.updateAgentStatus(workspaceId, { emoji: "💤", message: "Idle" });
        expect(activityEvents.at(-1)?.activity?.goal).toMatchObject({
          goalId: created.goalId,
          objective: "Pre-stream goal",
        });
        expect(activityEvents.at(-1)?.activity?.goal?.pendingPersistence).toBeUndefined();
      } finally {
        workspaceService.off("activity", listener);
      }
    } finally {
      await cleanup();
    }
  });

  test("WorkspaceService stream-abort listener leaves queued goal mutations for AgentSession", async () => {
    // Non-user abort goal mutation drains happen in AgentSession after abort
    // accounting. WorkspaceService must not drain here, or the aborted
    // in-flight stream can be charged to the replacement goal.
    const aiEmitter = new EventEmitter();
    const aiService = Object.assign(aiEmitter, {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
    }) as unknown as AIService;
    const { config, workspaceService, goalService, cleanup } = await createServices(aiService);
    const workspaceId = "system-abort-replays-mutation";
    try {
      await config.addWorkspace("/tmp/system-abort-test-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath: "/tmp/system-abort-test-project",
        runtimeConfig: { type: "local" },
      });
      void workspaceService;

      const created = await setWorkspaceGoalOk(goalService, {
        workspaceId,
        objective: "Original objective",
      });

      const goalServiceAccess = goalService as unknown as {
        isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
      };
      const isStreamingOriginal = goalServiceAccess.isWorkspaceStreaming;
      goalServiceAccess.isWorkspaceStreaming = () => Promise.resolve(true);
      try {
        const queued = await goalService.setGoal({
          workspaceId,
          objective: "Should commit on system abort",
          expectedGoalId: created.goalId,
        });
        expect(queued.success).toBe(true);
      } finally {
        goalServiceAccess.isWorkspaceStreaming = isStreamingOriginal;
      }

      aiService.emit("stream-abort", {
        type: "stream-abort",
        workspaceId,
        messageId: "msg",
        abortReason: "system",
        metadata: { duration: 1 },
        abandonPartial: false,
      });

      // Drain pending microtasks to prove WorkspaceService did not consume the
      // queued mutation before AgentSession has a chance to account the abort.
      await drainPendingDispatches();

      const persisted = await goalService.getGoal(workspaceId);
      expect(persisted?.objective).toBe("Original objective");
    } finally {
      await cleanup();
    }
  });
});
