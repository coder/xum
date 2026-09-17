import type { TurnCompletion } from "./streamManager";
import { runSessionTerminalPolicy } from "./agentSession.testHarness";
import type { CompactionHandler } from "./compactionHandler";
import assert from "@/common/utils/assert";
import type { ContinuousPrefixSwap } from "./continuousCompactionJournal";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { summarizeContinuousCompaction } from "./continuousCompactionSummary";
import type { SessionUsageService } from "./sessionUsageService";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ProvidersConfigMap, SendMessageOptions } from "@/common/orpc/types";
import {
  createMuxMessage,
  type CompactionFollowUpRequest,
  type MuxMessage,
} from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { GOAL_CONTINUATION_KIND } from "@/constants/goals";
import type { AgentSession } from "./agentSession";
import {
  createAgentSessionHarness,
  createStartedTurnHandle,
  seedAutoCompactionThreshold,
  type AgentSessionHarness,
} from "./agentSession.testHarness";
import type { ContinuousCompactor } from "./continuousCompactor";
import type { CompactionToken, TurnCoordinator } from "./turnCoordinator";
import * as fileLock from "@/node/utils/concurrency/fileLock";
import { historyWriteLockPath } from "./workspaceRemoval";
import { HistoryService } from "./historyService";
import { CompactionCancellation } from "./compactionCancellation";

const workspaceId = "continuous-session";
const model = "openai:gpt-4o";
const sendOptions: SendMessageOptions = {
  model,
  agentId: "exec",
  experiments: { continuousCompaction: true },
};

interface ContinuousStrategyInternals {
  continuousCompactor: ContinuousCompactor;
  runContinuousCompactionObservation<T>(
    observe: (token: CompactionToken) => Promise<T>
  ): Promise<T | undefined>;
  finishContinuousCompaction: (
    applied: boolean,
    context: NonNullable<SessionInternals["activeStreamContext"]>,
    token: CompactionToken
  ) => Promise<void>;
  interruptForContinuousCompaction: (
    apply: (followUp?: CompactionFollowUpRequest) => Promise<boolean>
  ) => Promise<boolean>;
  observeContinuousCompactionAtStreamEnd(model: string, options: SendMessageOptions): Promise<void>;
}

interface SessionInternals {
  coordinator: TurnCoordinator;
  contextController: {
    continuous: ContinuousStrategyInternals;
    summarize: { interruptForCompaction(): Promise<void> };
    compactionHandler: CompactionHandler;
  };
  activeStreamContext?: {
    modelString: string;
    options?: SendMessageOptions;
    providersConfig: ProvidersConfigMap | null;
  };
}

function internals(session: AgentSession): SessionInternals {
  return session as unknown as SessionInternals;
}

function continuous(session: AgentSession): ContinuousStrategyInternals {
  return internals(session).contextController.continuous;
}

async function applyThenFinish(
  session: AgentSession,
  apply: (followUp?: CompactionFollowUpRequest) => Promise<boolean>
): Promise<boolean> {
  const state = internals(session);
  const context = state.activeStreamContext;
  if (!context) throw new Error("Expected active stream context");
  const strategy = continuous(session);
  const result = await strategy.runContinuousCompactionObservation(async (token) => {
    const applied = await strategy.interruptForContinuousCompaction(apply);
    await strategy.finishContinuousCompaction(applied, context, token);
    return applied;
  });
  assert(result != null, "Expected the observation to complete");
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AgentSession continuous compaction wiring", () => {
  let harness: AgentSessionHarness | undefined;
  afterEach(async () => {
    await harness?.session.dispose();
    await harness?.cleanup();
    harness = undefined;
    mock.restore();
  });

  async function setup(usagePercent = 0) {
    harness = await createAgentSessionHarness({ workspaceId, captureEvents: true });
    if (usagePercent > 0) {
      await harness.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("old-user", "user", "Earlier work")
      );
      await harness.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("old-assistant", "assistant", "Earlier answer", {
          model,
          contextUsage: {
            inputTokens: usagePercent * 1_280,
            outputTokens: 1,
            totalTokens: usagePercent * 1_280 + 1,
          },
        })
      );
    }
    return harness;
  }

  async function rows(h: AgentSessionHarness): Promise<MuxMessage[]> {
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    return history.data;
  }

  async function appendBoundary(
    h: AgentSessionHarness,
    pendingFollowUp?: CompactionFollowUpRequest
  ) {
    const result = await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("continuous-boundary", "assistant", "Summary of earlier work", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
        muxMetadata: { type: "compaction-summary", strategy: "continuous", pendingFollowUp },
      })
    );
    expect(result.success).toBe(true);
  }

  describe("eager compaction physical lifetime", () => {
    async function setupEager() {
      const h = await setup();
      for (const row of [
        createMuxMessage("old-user", "user", "Investigate the regression"),
        createMuxMessage("old-answer", "assistant", "earlier investigation ".repeat(4_000)),
        createMuxMessage("recent-user", "user", "Implement the fix"),
        createMuxMessage("recent-answer", "assistant", "The fix is ready for review."),
      ]) {
        expect((await h.historyService.appendToHistory(workspaceId, row)).success).toBe(true);
      }
      const compactor = continuous(h.session).continuousCompactor;
      const deps = Reflect.get(compactor, "deps") as ConstructorParameters<
        typeof ContinuousCompactor
      >[0];
      const { coordinator } = h.session as unknown as { coordinator: TurnCoordinator };
      const enterExecution = coordinator.enterExecution.bind(coordinator);
      const releases: Array<ReturnType<typeof mock<() => void>>> = [];
      // Track disposal while retaining the real coordinator leases and shutdown drain.
      spyOn(coordinator, "enterExecution").mockImplementation(() => {
        const execution = enterExecution();
        const release = mock(() => execution[Symbol.dispose]());
        releases.push(release);
        return { [Symbol.dispose]: release };
      });
      deps.prepare = () => Promise.resolve();
      deps.estimateAttachmentTokens = () => Promise.resolve(0);
      deps.summarize = () => Promise.resolve({ text: "Earlier work summarized", model });
      async function start() {
        await compactor.observe(60, {
          enabled: true,
          model,
          contextWindowTokens: 100_000,
          thresholdPercent: 70,
          phase: "stream-end",
        });
        const job = Reflect.get(compactor, "job") as { done: Promise<void> };
        return { done: job.done };
      }
      return { h, compactor, deps, coordinator, releases, start };
    }

    for (const phase of ["prepare", "summarize"] as const) {
      test.each(["complete", "reject", "reset", "shutdown", "dispose"] as const)(
        `retains eager ${phase} execution until the original Promise settles: %s`,
        async (outcome) => {
          const { h, compactor, deps, coordinator, releases, start } = await setupEager();
          const entered = deferred<void>();
          const release = deferred<void>();
          async function work() {
            entered.resolve();
            await release.promise;
            if (outcome === "reject") throw new Error("eager work failed");
          }
          if (phase === "prepare") deps.prepare = work;
          else
            deps.summarize = async () => {
              await work();
              return { text: "Earlier work summarized", model };
            };
          const job = await start();
          let shutdown: Promise<void> | undefined;
          try {
            await entered.promise;
            expect(releases).toHaveLength(1);
            const eagerRelease = releases[0];
            expect(eagerRelease).not.toHaveBeenCalled();
            // Physical ownership must leave normal turn admission and semantic idle intact.
            expect(coordinator.phase).toBe("idle");
            expect(coordinator.admissionBlocked).toBe(false);
            // These jobs bypass the session's context builder, so trigger the reset the
            // persisted-threshold listener would issue.
            if (outcome === "reset") compactor.reset("threshold-changed");
            if (outcome === "shutdown") {
              h.session.beginShutdown();
              shutdown = h.session.finishShutdown();
              expect(coordinator.closing).toBe(true);
            }
            if (outcome === "dispose") {
              shutdown = h.session.dispose();
              expect(coordinator.disposed).toBe(true);
            }
            await compactor.waitForIdle();
            expect(eagerRelease).not.toHaveBeenCalled();
            release.resolve();
            await job.done;
            expect(eagerRelease).toHaveBeenCalledTimes(1);
            if (outcome === "dispose") {
              expect(Reflect.get(compactor, "staged")).toBeNull();
              expect((await rows(h)).some((row) => row.metadata?.compactionBoundary)).toBe(false);
              expect(
                await h.historyService.getContinuousCompactionJournal(workspaceId).read()
              ).toBeNull();
            }
            // A settled eager job must never strand the real shutdown drain.
            await (shutdown ?? h.session.finishShutdown());
            expect(eagerRelease).toHaveBeenCalledTimes(1);
          } finally {
            release.resolve();
            await job.done;
            await shutdown;
          }
        }
      );
    }

    test("reset permits replacement work without releasing either job's physical ownership", async () => {
      const { h, compactor, deps, releases, start } = await setupEager();
      const first = deferred<void>();
      const second = deferred<void>();
      let preparations = 0;
      deps.prepare = () => (preparations++ === 0 ? first.promise : second.promise);
      const original = await start();
      compactor.reset("threshold-changed");
      const replacement = await start();
      try {
        expect(releases).toHaveLength(2);
        expect(releases[0]).not.toHaveBeenCalled();
        expect(releases[1]).not.toHaveBeenCalled();
        first.resolve();
        await original.done;
        expect(releases[0]).toHaveBeenCalledTimes(1);
        expect(releases[1]).not.toHaveBeenCalled();
        second.resolve();
        await replacement.done;
        expect(releases[1]).toHaveBeenCalledTimes(1);
        await h.session.finishShutdown();
      } finally {
        first.resolve();
        second.resolve();
        await Promise.all([original.done, replacement.done]);
      }
    });
  });

  test.each([
    "startup",
    "disabled-terminal",
    "threshold-terminal",
    "disabled-usage-terminal",
    "terminal-error",
    "failed-consumed-apply",
    "dispose-during-finalization",
  ] as const)("%s commits a consumed journal before retry or new work", async (mode) => {
    const h = await setup();
    const source = createMuxMessage("live-answer", "assistant", "", {
      partial: true,
      stepStartPartIndices: [0, 1, 2],
    });
    source.parts = [
      { type: "text", text: "completed investigation ".repeat(4_000) },
      {
        type: "dynamic-tool",
        toolCallId: "kept-tool",
        toolName: "bash",
        state: "output-available",
        input: { script: "pwd" },
        output: { success: true },
      },
      { type: "text", text: "still generating" },
    ];
    for (const row of [
      createMuxMessage("old-user", "user", "Earlier request"),
      createMuxMessage("old-answer", "assistant", "old context ".repeat(6_000)),
      createMuxMessage("new-user", "user", "Continue the task"),
      source,
    ]) {
      expect((await h.historyService.appendToHistory(workspaceId, row)).success).toBe(true);
    }
    const compactor = continuous(h.session).continuousCompactor;
    const deps = Reflect.get(compactor, "deps") as ConstructorParameters<
      typeof ContinuousCompactor
    >[0];
    let streaming = true;
    let swap: ContinuousPrefixSwap | undefined;
    deps.streamManager = {
      isStreaming: () => streaming,
      getStreamInfo: () =>
        streaming
          ? {
              messageId: source.id,
              parts: source.parts,
              stepStartIndices: [0, 1, 2],
              currentStepStartIndex: 2,
            }
          : undefined,
      setPrefixSwap: (_id, value) => {
        swap = value;
        return true;
      },
      getPrefixSwapState: () => (streaming ? (swap?.consumed ? "consumed" : "pending") : "none"),
    };
    deps.prepare = () => Promise.resolve();
    deps.estimateAttachmentTokens = () => Promise.resolve(0);
    deps.summarize = () => Promise.resolve({ text: "Earlier work summarized", model });
    deps.prepareSwap = () =>
      Promise.resolve({
        preparation: {
          modelString: model,
          providerForMessages: "openai",
          effectiveAgentId: "exec",
          effectiveThinkingLevel: "off",
          toolNamesForSentinel: ["bash"],
        },
        attachments: [],
        systemPrefix: [],
        cacheEnabled: false,
      });
    const context = {
      enabled: true,
      model,
      thresholdPercent: 70,
      contextWindowTokens: 100_000,
      phase: "mid-stream" as const,
    };
    await compactor.observe(60, context);
    const job = Reflect.get(compactor, "job") as { done: Promise<void> };
    await job.done;
    expect(await compactor.observe(70, context)).toBe("none");
    assert(swap, "Expected pending swap");
    const store = h.historyService.getContinuousCompactionJournal(workspaceId);
    const journal = await store.write(swap.journal, swap.prefix, () => true);
    assert(journal, "Expected durable swap journal");
    swap.consumed = true;
    if (mode === "threshold-terminal") compactor.reset("threshold-changed");
    if (mode === "disabled-terminal") compactor.reset("disabled");
    if (mode === "disabled-usage-terminal") {
      internals(h.session).activeStreamContext = {
        modelString: model,
        providersConfig: null,
        options: { ...sendOptions, experiments: { continuousCompaction: false } },
      };
      const observed = deferred<void>();
      const observe = compactor.observe.bind(compactor);
      spyOn(compactor, "observe").mockImplementation(async (...args) => {
        const result = await observe(...args);
        observed.resolve();
        return result;
      });
      h.aiEmitter.emit("usage-delta", {
        type: "usage-delta",
        workspaceId,
        messageId: source.id,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
      await observed.promise;
      expect(await store.read()).not.toBeNull();
      internals(h.session).activeStreamContext = undefined;
    }
    source.parts.push({ type: "text", text: "post-swap crash growth" });
    await h.historyService.writePartial(workspaceId, source);
    streaming = false;
    if (mode === "dispose-during-finalization") {
      const entered = deferred<void>();
      const release = deferred<void>();
      const persist = deps.compactionHandler.persistContinuousCompaction.bind(
        deps.compactionHandler
      );
      spyOn(deps.compactionHandler, "persistContinuousCompaction").mockImplementation(
        async (...args) => {
          entered.resolve();
          await release.promise;
          return persist(...args);
        }
      );
      const finalizing = continuous(h.session).runContinuousCompactionObservation(() =>
        compactor.observe(0, { ...context, enabled: false, phase: "stream-end" })
      );
      let disposing: Promise<void> | undefined;
      try {
        await entered.promise;
        disposing = h.session.dispose();
        release.resolve();
        const verdict = await finalizing;
        await disposing;
        // Disposal cancels the observer, not its durable recovery obligation. Preserve the
        // journal until a new session can fold it; do not publish from the disposed session.
        const disposedOutcome = {
          verdict,
          published: (await rows(h))[0].id === journal.boundary.id,
          journalRetained: (await store.read()) !== null,
        };
        const restarted = await createAgentSessionHarness({
          workspaceId,
          config: h.config,
          historyService: h.historyService,
        });
        try {
          // Recovery must precede retry; this fixture has no provider engine to resume.
          Reflect.set(restarted.session, "scheduleStartupAutoRetryIfNeeded", () =>
            Promise.resolve("completed")
          );
          await restarted.session.runStartupRecovery();
          expect((await rows(restarted))[0].id).toBe(journal.boundary.id);
          expect(await store.read()).toBeNull();
        } finally {
          await restarted.session.dispose();
        }
        expect(disposedOutcome).toEqual({
          verdict: "none",
          published: false,
          journalRetained: true,
        });
      } finally {
        release.resolve();
        await finalizing;
        await disposing;
      }
      return;
    }
    if (mode === "failed-consumed-apply") {
      const { coordinator } = internals(h.session);
      const token = coordinator.beginCompactionObservation("continuous");
      assert(token != null, "Expected compaction observation");
      coordinator.setCompactionStage(token, "stopped");
      const reset = spyOn(compactor, "reset");
      await continuous(h.session).finishContinuousCompaction(
        false,
        { modelString: model, options: sendOptions, providersConfig: null },
        token
      );
      expect(reset).not.toHaveBeenCalled();
      expect(await store.read()).not.toBeNull();
      coordinator.finishCompactionObservation(token);
    }
    if (mode !== "startup") {
      const strategy = continuous(h.session);
      const options = { ...sendOptions, experiments: { continuousCompaction: false } };
      if (mode === "terminal-error") {
        spyOn(h.historyService, "getHistoryFromLatestBoundary").mockImplementationOnce(() =>
          Promise.reject(new Error("temporary terminal history failure"))
        );
        await strategy.observeContinuousCompactionAtStreamEnd(model, options);
        expect(await store.read()).not.toBeNull();
        expect(compactor.hasConsumedSwap()).toBe(true);
      }
      await strategy.observeContinuousCompactionAtStreamEnd(model, options);
      await strategy.observeContinuousCompactionAtStreamEnd(model, options);
      const history = await rows(h);
      expect(history[0].id).toBe(journal.boundary.id);
      expect(history.at(-1)?.parts).toEqual(source.parts.slice(journal.liveTailCopySpec.partIndex));
      expect(history.filter((row) => row.metadata?.compactionBoundary)).toHaveLength(1);
      expect(await store.read()).toBeNull();
      return;
    }
    const order: string[] = [];
    const commit = h.historyService.commitPartial.bind(h.historyService);
    spyOn(h.historyService, "commitPartial").mockImplementation((id) => {
      order.push("commit");
      return commit(id);
    });
    const read = store.read.bind(store);
    spyOn(store, "read").mockImplementation(() => {
      order.push("journal");
      return read();
    });
    let retryChecks = 0;
    Reflect.set(h.session, "scheduleStartupAutoRetryIfNeeded", async () => {
      const history = await rows(h);
      expect(history[0].id).toBe(journal.boundary.id);
      expect(history.at(-1)?.parts).toEqual(source.parts.slice(journal.liveTailCopySpec.partIndex));
      retryChecks++;
      return "completed";
    });
    await h.session.runStartupRecovery();
    expect(order.slice(0, 2)).toEqual(["commit", "journal"]);
    expect(retryChecks).toBe(1);
    expect(await store.read()).toBeNull();
  });

  test.each(["token-budget", "compaction-request", "model-changed"] as const)(
    "consumed swaps do not bypass the mid-stream %s guard",
    async (guard) => {
      const h = await setup();
      const state = internals(h.session);
      state.activeStreamContext = {
        modelString: model,
        providersConfig: null,
        options: {
          ...sendOptions,
          experiments: { continuousCompaction: false, tokenBudget: guard === "token-budget" },
        },
      };
      if (guard === "compaction-request") {
        Reflect.set(h.session, "activeCompactionRequest", { id: "manual-compact" });
      }
      const strategy = continuous(h.session);
      spyOn(strategy.continuousCompactor, "hasConsumedSwap").mockReturnValue(true);
      const observation = spyOn(strategy, "runContinuousCompactionObservation");
      const reset = spyOn(strategy.continuousCompactor, "reset");
      const accounting = deferred<void>();
      const preview = h.session as unknown as { previewGoalAccountingFromUsage(): Promise<void> };
      spyOn(preview, "previewGoalAccountingFromUsage").mockReturnValue(accounting.promise);
      h.aiEmitter.emit("usage-delta", {
        type: "usage-delta",
        workspaceId,
        messageId: "live-answer",
        usage: { inputTokens: 90_000, outputTokens: 1, totalTokens: 90_001 },
      });
      // The handler captured the old model before accounting suspended. A replacement stream
      // must not inherit that old usage observation, even when a consumed swap remains.
      if (guard === "model-changed") state.activeStreamContext.modelString = "openai:gpt-4.1";
      accounting.resolve();
      await accounting.promise;
      // These entry points latch synchronously after accounting: no sleep or I/O race.
      expect(observation).not.toHaveBeenCalled();
      expect(reset).not.toHaveBeenCalled();
    }
  );

  test("does not activate a prefix without the captured options required by fast-stop fallback", async () => {
    const h = await setup();
    internals(h.session).activeStreamContext = { modelString: model, providersConfig: null };
    const deps = Reflect.get(
      continuous(h.session).continuousCompactor,
      "deps"
    ) as ConstructorParameters<typeof ContinuousCompactor>[0];
    assert(deps.prepareSwap !== undefined, "Expected session prefix preparation");
    expect(await deps.prepareSwap([])).toBeNull();
  });

  test("resumeless continuous fold cannot divert a later legacy compaction's saved follow-up", async () => {
    const h = await setup();
    const retained = createMuxMessage("retained-user", "user", "Earlier task");
    await h.historyService.appendToHistory(workspaceId, retained);
    const handler = internals(h.session).contextController.compactionHandler;
    const preparation = handler.beginPreparation(() => true);
    const source = await rows(h);
    expect(
      await handler.persistContinuousCompaction({
        preparation,
        publication: {
          generation: await h.historyService
            .getContinuousCompactionJournal(workspaceId)
            .captureGeneration(),
        },
        attachmentMessages: source,
        messages: source,
        text: "Continuous summary",
        model,
        tail: [retained],
        systemMessageTokens: 0,
        attachmentTokens: 0,
        shouldPersist: () => true,
      })
    ).toBe(true);
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("legacy-request", "user", "Please compact", {
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: { followUpContent: { text: "Current saved follow-up", model, agentId: "exec" } },
        },
      })
    );
    Reflect.set(h.session, "activeCompactionRequest", { id: "legacy-request", modelString: model });
    const completion = h.session.waitForPendingCompactionCompletionDecision("legacy-summary");
    void runSessionTerminalPolicy(h.session, h.aiEmitter, {
      type: "stream-end",
      workspaceId,
      messageId: "legacy-summary",
      metadata: { model, agentId: "compact", finishReason: "stop" },
      parts: [{ type: "text", text: "Legacy summary" }],
    });
    expect(await completion).toBe(true);
    const current = await rows(h);
    expect(current.at(-1)?.role).toBe("user");
    expect(current.at(-1)?.parts).toMatchObject([
      { type: "text", text: "Current saved follow-up" },
    ]);
  });

  test("sends ordinary work when recovery finds no journal under a held history lock", async () => {
    const h = await setup();
    const stream = spyOn(h.aiService, "streamMessage");
    const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
    expect(await journal.exists()).toBe(false);
    const compactor = continuous(h.session).continuousCompactor;
    const recover = compactor.recover.bind(compactor);
    const recovering = spyOn(compactor, "recover").mockImplementation(async () => {
      // Contend at the recovery probe, then release before the send's actual history writes.
      await using held = await fileLock.acquireProcessFileLock({
        lockPath: historyWriteLockPath(h.config.rootDir, workspaceId),
        timeoutMs: 1000,
        label: "foreign history writer",
      });
      const acquire = fileLock.acquireProcessFileLock;
      // Exercise the real timeout path without a ten-second wait on the broken implementation.
      const timeout = spyOn(fileLock, "acquireProcessFileLock").mockImplementation((options) =>
        acquire({ ...options, timeoutMs: 1 })
      );
      try {
        const recovered = await recover();
        expect(recovered).toBe(false);
        await held.assertStillOwned();
        return recovered;
      } finally {
        timeout.mockRestore();
      }
    });
    expect((await h.session.sendMessage("Ordinary work", sendOptions)).success).toBe(true);
    expect(recovering).toHaveBeenCalled();
    expect(stream).toHaveBeenCalled();
    expect((await rows(h)).at(-1)?.parts).toMatchObject([{ type: "text", text: "Ordinary work" }]);
    expect(await journal.exists()).toBe(false);
  });

  test.each([false, true])(
    "on-send apply preserves the new user turn (token budget enabled: %s)",
    async (tokenBudget) => {
      const h = await setup(72);
      spyOn(continuous(h.session).continuousCompactor, "observe").mockImplementation(
        async (_percent, context) => {
          expect(context.phase).toBe("on-send");
          await appendBoundary(h);
          return "applied";
        }
      );
      const stream = spyOn(h.aiService, "streamMessage");
      const result = await h.session.sendMessage("Keep going with the next task", {
        ...sendOptions,
        experiments: { continuousCompaction: true, tokenBudget },
      });
      expect(result.success).toBe(true);
      expect(stream).toHaveBeenCalledTimes(1);
      // Continuous must actually apply, not merely suppress the competing budget callback.
      expect(stream.mock.calls[0][0].onStepSettled).toBeUndefined();
      const history = await rows(h);
      expect(history[0].id).toBe("continuous-boundary");
      expect(history.at(-1)?.parts.find((part) => part.type === "text")).toMatchObject({
        text: "Keep going with the next task",
      });
      expect(history.some((row) => row.metadata?.muxMetadata?.type === "compaction-request")).toBe(
        false
      );
    }
  );

  test.each([72, 76])(
    "without a staged summary on-send falls back only at force (%s%%)",
    async (percent) => {
      const h = await setup(percent);
      // Isolate trigger policy from model latency; the engine reports fallback only
      // when pressure reaches force, regardless of an in-flight background job.
      spyOn(continuous(h.session).continuousCompactor, "observe").mockResolvedValue(
        percent >= 75 ? "fallback" : "none"
      );
      expect((await h.session.sendMessage("New work", sendOptions)).success).toBe(true);
      const history = await rows(h);
      const compactRequest = history.find(
        (row) => row.metadata?.muxMetadata?.type === "compaction-request"
      );
      expect(compactRequest !== undefined).toBe(percent >= 75);
      if (percent >= 75 && compactRequest?.metadata?.muxMetadata?.type === "compaction-request") {
        expect(compactRequest.metadata.muxMetadata.parsed.followUpContent?.text).toBe("New work");
      }
    }
  );

  test("explicit experiment disable wins over backend enable and keeps legacy on-send policy", async () => {
    const h = await setup(72);
    spyOn(h.aiService, "isExperimentEnabled").mockImplementation(
      (id) => id === EXPERIMENT_IDS.CONTINUOUS_COMPACTION
    );
    const observe = spyOn(continuous(h.session).continuousCompactor, "observe");
    expect(
      (
        await h.session.sendMessage("New work", {
          ...sendOptions,
          experiments: { continuousCompaction: false },
        })
      ).success
    ).toBe(true);
    expect(observe).not.toHaveBeenCalled();
    expect(
      (await rows(h)).some((row) => row.metadata?.muxMetadata?.type === "compaction-request")
    ).toBe(true);
  });

  test("threshold 100 disables both automatic strategies even above the context limit", async () => {
    const h = await setup(110);
    await seedAutoCompactionThreshold(h.config, model, 100);
    const observe = spyOn(continuous(h.session).continuousCompactor, "observe");
    expect((await h.session.sendMessage("New work", sendOptions)).success).toBe(true);
    expect(observe).not.toHaveBeenCalled();
    expect(
      (await rows(h)).some((row) => row.metadata?.muxMetadata?.type === "compaction-request")
    ).toBe(false);
  });

  test("a persisted threshold change resets the compactor only for its model", async () => {
    const h = await setup();
    // The send builds the continuous-compaction context, which pins the model the listener
    // compares against.
    expect((await h.session.sendMessage("New work", sendOptions)).success).toBe(true);
    const reset = spyOn(continuous(h.session).continuousCompactor, "reset");
    // Unchanged value re-saved: the fold stays staged.
    await seedAutoCompactionThreshold(h.config, model, 70);
    expect(reset).not.toHaveBeenCalled();
    // Another model's slider: unrelated to this compactor.
    await seedAutoCompactionThreshold(h.config, "anthropic:claude-sonnet-4-5", 40);
    expect(reset).not.toHaveBeenCalled();
    await seedAutoCompactionThreshold(h.config, model, 80);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenLastCalledWith("threshold-changed");
    // The listener is detached on dispose: later config writes no longer reach the compactor.
    await h.session.dispose();
    reset.mockClear();
    await seedAutoCompactionThreshold(h.config, model, 90);
    expect(reset).not.toHaveBeenCalledWith("threshold-changed");
  });

  function startStream(h: AgentSessionHarness) {
    h.aiEmitter.emit("stream-start", {
      type: "stream-start",
      workspaceId,
      messageId: "live-assistant",
      model,
      historySequence: 1,
      startTime: Date.now(),
    });
  }

  function endStream(h: AgentSessionHarness) {
    void runSessionTerminalPolicy(h.session, h.aiEmitter, {
      type: "stream-end",
      workspaceId,
      messageId: "live-assistant",
      parts: [],
      metadata: {
        model,
        contextUsage: { inputTokens: 92_160, outputTokens: 1, totalTokens: 92_161 },
      },
    });
  }

  test("terminal apply runs after stream reset and before queued sends", async () => {
    const h = await setup();
    const entered = deferred<void>();
    const release = deferred<void>();
    const queuedStarted = deferred<void>();
    let starts = 0;
    spyOn(h.aiService, "streamMessage").mockImplementation(() => {
      starts++;
      startStream(h);
      if (starts === 2) queuedStarted.resolve();
      return Promise.resolve(Ok(createStartedTurnHandle(h.session.closingSignal)));
    });
    spyOn(continuous(h.session).continuousCompactor, "observe").mockImplementation(
      async (_percent, context) => {
        if (context.phase !== "stream-end") return "none";
        expect(internals(h.session).activeStreamContext).toBeUndefined();
        entered.resolve();
        await release.promise;
        await appendBoundary(h);
        return "applied";
      }
    );
    expect((await h.session.sendMessage("First", sendOptions)).success).toBe(true);
    h.session.queueMessage("Queued", sendOptions);
    endStream(h);
    await entered.promise;
    expect(starts).toBe(1);
    release.resolve();
    await queuedStarted.promise;
    const history = await rows(h);
    expect(history[0].id).toBe("continuous-boundary");
    expect(history.at(-1)?.parts.find((part) => part.type === "text")).toMatchObject({
      text: "Queued",
    });
  });

  test("invalidation contains an initial wait rejection and safely stops the blocked stream", async () => {
    const h = await setup();
    const compactor = continuous(h.session).continuousCompactor;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    let streaming = true;
    internals(h.session).activeStreamContext = {
      modelString: model,
      options: sendOptions,
      providersConfig: null,
    };
    spyOn(h.aiService, "isStreaming").mockImplementation(() => streaming);
    spyOn(h.aiService, "getStreamInfo").mockReturnValue({
      messageId: "live-assistant",
      parts: [],
      toolCompletionTimestamps: new Map(),
    });
    Reflect.set(Reflect.get(h.session, "streamManager"), "getPrefixSwapState", () => "invalidated");
    spyOn(compactor, "waitForIdle").mockImplementationOnce(() =>
      Promise.reject(new Error("apply wait failed"))
    );
    const reset = spyOn(compactor, "reset");
    const drain = spyOn(h.session, "drainQueuedMessagesIfIdle");
    const stop = spyOn(h.aiService, "stopStream").mockImplementation((_id, options) => {
      expect(options?.abortReason).toBe("system");
      streaming = false;
      void runSessionTerminalPolicy(h.session, h.aiEmitter, {
        type: "stream-abort",
        workspaceId,
        messageId: "live-assistant",
        abortReason: "system",
      });
      return Promise.resolve(Ok(undefined));
    });
    try {
      startStream(h);
      h.aiEmitter.emit("prefix-swap-invalidated", {
        type: "prefix-swap-invalidated",
        workspaceId,
        messageId: "live-assistant",
      });
      await h.session.waitForIdle();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(reset).not.toHaveBeenCalled();
      expect(drain).not.toHaveBeenCalled();
      expect(h.session.isBusy()).toBe(false);
    } finally {
      stop.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("duplicate invalidations wait for the owner and never clear another observation's flags", async () => {
    const h = await setup();
    let streaming = true;
    internals(h.session).activeStreamContext = {
      modelString: model,
      options: sendOptions,
      providersConfig: null,
    };
    spyOn(h.aiService, "isStreaming").mockImplementation(() => streaming);
    spyOn(h.aiService, "getStreamInfo").mockReturnValue({
      messageId: "live-assistant",
      parts: [],
      toolCompletionTimestamps: new Map(),
    });
    const release = deferred<void>();
    const invoked = deferred<void>();
    const drain = spyOn(h.session, "drainQueuedMessagesIfIdle").mockImplementation(() => undefined);
    const first = continuous(h.session).runContinuousCompactionObservation(async (token) => {
      internals(h.session).coordinator.setCompactionStage(token, "stopping");
      await release.promise;
    });
    const observe = spyOn(continuous(h.session).continuousCompactor, "observe").mockImplementation(
      () => {
        streaming = false;
        internals(h.session).activeStreamContext = undefined;
        invoked.resolve();
        return Promise.resolve("none");
      }
    );
    const event = { type: "prefix-swap-invalidated", workspaceId, messageId: "live-assistant" };
    h.aiEmitter.emit("prefix-swap-invalidated", event);
    h.aiEmitter.emit("prefix-swap-invalidated", event);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(internals(h.session).coordinator.compactionIntent.observation?.kind).toBe("continuous");
    expect(internals(h.session).coordinator.midStreamCompactionPending).toBe(true);
    expect(drain).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    release.resolve();
    await first;
    await invoked.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observe).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(2);
    expect(internals(h.session).coordinator.compactionIntent.observation?.kind).not.toBe(
      "continuous"
    );
    expect(internals(h.session).coordinator.midStreamCompactionPending).toBe(false);
  });

  test.each(["usage-delta", "prefix-swap-invalidated"] as const)(
    "%s contains a follow-up history read rejection and preserves durable retry",
    async (eventType) => {
      const h = await setup();
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => {
        unhandled.push(error);
      };
      process.on("unhandledRejection", onUnhandled);
      const drained = deferred<void>();
      const failedRead = deferred<void>();
      let watching = false;
      spyOn(h.session, "drainQueuedMessagesIfIdle").mockImplementation(() => {
        if (watching) drained.resolve();
      });
      let streaming = false;
      spyOn(h.aiService, "streamMessage").mockImplementation(() => {
        streaming = true;
        startStream(h);
        return Promise.resolve(Ok(createStartedTurnHandle(h.session.closingSignal)));
      });
      const stop = spyOn(h.aiService, "stopStream").mockImplementation(async () => {
        streaming = false;
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("live-assistant", "assistant", "Committed partial")
        );
        void runSessionTerminalPolicy(h.session, h.aiEmitter, {
          type: "stream-abort",
          workspaceId,
          messageId: "live-assistant",
          abortReason: "system",
        });
        return Ok(undefined);
      });
      let failRead = false;
      const read = h.historyService.getHistoryFromLatestBoundary.bind(h.historyService);
      spyOn(h.historyService, "getHistoryFromLatestBoundary").mockImplementation((id) => {
        if (failRead) {
          failRead = false;
          failedRead.resolve();
          return Promise.reject(new Error("transient follow-up history read"));
        }
        return read(id);
      });
      const handler = internals(h.session).contextController.compactionHandler;
      spyOn(continuous(h.session).continuousCompactor, "observe").mockImplementation(
        async (_usage, context) => {
          if (context.phase !== "mid-stream") return "none";
          const applied = await continuous(h.session).interruptForContinuousCompaction(
            async (followUp) => {
              const preparation = handler.beginPreparation(() => true);
              const history = await rows(h);
              const applied = await handler.persistContinuousCompaction({
                preparation,
                publication: {
                  generation: await h.historyService
                    .getContinuousCompactionJournal(workspaceId)
                    .captureGeneration(),
                },
                attachmentMessages: history,
                messages: history,
                text: "Recovered summary",
                model,
                tail: history.slice(-1),
                pendingFollowUp: followUp,
                systemMessageTokens: 0,
                attachmentTokens: 0,
                shouldPersist: () => true,
              });
              failRead = true;
              return applied;
            }
          );
          return applied ? "applied" : "none";
        }
      );
      try {
        expect((await h.session.sendMessage("Working", sendOptions)).success).toBe(true);
        spyOn(h.aiService, "isStreaming").mockImplementation(() => streaming);
        spyOn(h.aiService, "getStreamInfo").mockReturnValue({
          messageId: "live-assistant",
          parts: [],
          toolCompletionTimestamps: new Map(),
        });
        watching = true;
        h.aiEmitter.emit(eventType, {
          type: eventType,
          workspaceId,
          messageId: "live-assistant",
          usage: { inputTokens: 92_160, outputTokens: 1, totalTokens: 92_161 },
        });
        await failedRead.promise;
        await drained.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
        expect(h.session.isBusy()).toBe(false);
        expect(internals(h.session).coordinator.compactionIntent.observation?.kind).not.toBe(
          "continuous"
        );
        expect(internals(h.session).coordinator.midStreamCompactionPending).toBe(false);
        const boundary = (await rows(h))[0];
        expect(Reflect.get(h.session, "pendingCompactionFollowUpSummaryId")).toBe(boundary.id);
        expect(boundary.metadata?.muxMetadata?.type).toBe("compaction-summary");
        expect(
          boundary.metadata?.muxMetadata?.type === "compaction-summary" &&
            boundary.metadata.muxMetadata.pendingFollowUp?.text
        ).toBe("Continue");
        expect(await h.session.dispatchPendingCompactionFollowUpIfNeeded(boundary.id)).toBe(true);
        expect((await rows(h)).at(-1)?.parts).toMatchObject([{ type: "text", text: "Continue" }]);
      } finally {
        stop.mockRestore();
        process.off("unhandledRejection", onUnhandled);
      }
    }
  );

  test.each(["usage-delta", "prefix-swap-invalidated"] as const)(
    "%s fast apply commits after system stop then resumes without a compact turn or latch recursion",
    async (eventType) => {
      const h = await setup();
      const resumed = deferred<void>();
      const settled = deferred<void>();
      const order: string[] = [];
      let starts = 0;
      spyOn(h.aiService, "streamMessage").mockImplementation(() => {
        starts++;
        startStream(h);
        if (starts === 2) {
          order.push("resume");
          resumed.resolve();
        }
        return Promise.resolve(Ok(createStartedTurnHandle(h.session.closingSignal)));
      });
      spyOn(h.aiService, "stopStream").mockImplementation(async (_id, options) => {
        if (eventType === "prefix-swap-invalidated")
          spyOn(h.aiService, "isStreaming").mockReturnValue(false);
        expect(options?.abortReason).toBe("system");
        order.push("stop");
        const result = await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("live-assistant", "assistant", "Committed partial")
        );
        expect(result.success).toBe(true);
        void runSessionTerminalPolicy(h.session, h.aiEmitter, {
          type: "stream-abort",
          workspaceId,
          messageId: "live-assistant",
          abortReason: "system",
        });
        return Ok(undefined);
      });
      let observedMidstream = false;
      let applying = false;
      spyOn(continuous(h.session).continuousCompactor, "isApplying").mockImplementation(
        () => applying
      );
      spyOn(continuous(h.session).continuousCompactor, "observe").mockImplementation(
        async (_percent, context) => {
          // Resumed on-send observation is allowed, but only after the mid-stream
          // apply latch has been released.
          expect(applying).toBe(false);
          if (context.phase !== "mid-stream") return "none";
          expect(observedMidstream).toBe(false);
          observedMidstream = true;
          applying = true;
          const applied = await continuous(h.session).interruptForContinuousCompaction(
            async (followUp) => {
              expect(h.session.isBusy()).toBe(false);
              expect(internals(h.session).activeStreamContext).toBeUndefined();
              expect((await rows(h)).at(-1)?.id).toBe("live-assistant");
              expect(followUp).toMatchObject({
                text: "Continue",
                model,
                goalKind: GOAL_CONTINUATION_KIND,
                goalId: "11111111-1111-4111-8111-111111111111",
                dispatchOptions: { source: "internal-resume" },
              });
              order.push("apply");
              // Idle waiters (monitor wakes) must stay parked until the continuation is sent.
              void h.session.waitForMidStreamCompactionSettled().then(() => {
                order.push("settled");
                settled.resolve();
              });
              await appendBoundary(h, followUp);
              return true;
            }
          );
          expect(starts).toBe(1);
          applying = false;
          order.push("latch-released");
          return applied ? "applied" : "none";
        }
      );
      expect(
        (
          await h.session.sendMessage("Working", sendOptions, {
            synthetic: true,
            agentInitiated: true,
            goalKind: GOAL_CONTINUATION_KIND,
            goalId: "11111111-1111-4111-8111-111111111111",
          })
        ).success
      ).toBe(true);
      const observationFinished = deferred<void>();
      let observationToken: CompactionToken | undefined;
      if (eventType === "prefix-swap-invalidated") {
        spyOn(h.aiService, "isStreaming").mockReturnValue(true);
        spyOn(h.aiService, "getStreamInfo").mockReturnValue({
          messageId: "live-assistant",
          parts: [],
          toolCompletionTimestamps: new Map(),
        });
        spyOn(continuous(h.session).continuousCompactor, "waitForIdle").mockReturnValueOnce(
          observationFinished.promise
        );
        observationToken = internals(h.session).coordinator.beginCompactionObservation(
          "continuous"
        );
        assert(observationToken != null, "Expected compaction observation");
      }
      h.aiEmitter.emit(eventType, {
        type: eventType,
        workspaceId,
        messageId: "live-assistant",
        usage: { inputTokens: 92_160, outputTokens: 1, totalTokens: 92_161 },
      });
      if (eventType === "prefix-swap-invalidated") {
        expect(order).toEqual([]);
        assert(observationToken != null, "Expected compaction observation");
        internals(h.session).coordinator.finishCompactionObservation(observationToken);
        observationFinished.resolve();
      }
      await resumed.promise;
      await settled.promise;
      expect(order).toEqual(["stop", "apply", "latch-released", "resume", "settled"]);
      const history = await rows(h);
      expect(history.some((row) => row.metadata?.muxMetadata?.type === "compaction-request")).toBe(
        false
      );
      expect(history.at(-1)?.parts.find((part) => part.type === "text")).toMatchObject({
        text: "Continue",
      });
      // Disposal's stop is intentionally not the fast-apply stop under test.
      mock.restore();
    }
  );

  test.each([72, 76])(
    "a failed post-stop apply recovers the interrupted turn at %s%%",
    async (percent) => {
      const h = await setup(percent);
      spyOn(continuous(h.session).continuousCompactor, "observe").mockResolvedValue("none");
      let starts = 0;
      spyOn(h.aiService, "streamMessage").mockImplementation(() => {
        starts++;
        startStream(h);
        return Promise.resolve(Ok(createStartedTurnHandle(h.session.closingSignal)));
      });
      spyOn(h.aiService, "stopStream").mockImplementation(() => {
        void runSessionTerminalPolicy(h.session, h.aiEmitter, {
          type: "stream-abort",
          workspaceId,
          messageId: "live-assistant",
          abortReason: "system",
        });
        return Promise.resolve(Ok(undefined));
      });
      expect((await h.session.sendMessage("Working", sendOptions)).success).toBe(true);
      expect(await applyThenFinish(h.session, () => Promise.resolve(false))).toBe(false);
      expect(starts).toBe(2);
      const history = await rows(h);
      expect(history.at(-1)?.metadata?.muxMetadata?.type === "compaction-request").toBe(
        percent >= 75
      );
      if (percent < 75)
        expect(history.at(-1)?.parts.find((part) => part.type === "text")).toMatchObject({
          text: "Continue",
        });
      mock.restore();
    }
  );

  test.each(["legacy", "continuous resume", "continuous compact"] as const)(
    "%s cannot adopt a foreign settled Stop while stopping its source stream",
    async (route) => {
      const h = await setup(route === "continuous resume" ? 72 : 76);
      const state = internals(h.session);
      spyOn(continuous(h.session).continuousCompactor, "observe").mockResolvedValue("none");
      const starts = mockAbortableStream(h);
      expect((await h.session.sendMessage("Working", sendOptions)).success).toBe(true);
      const before = await rows(h);
      const foreignHistory = new HistoryService(h.config);
      const storage = foreignHistory.getCompactionCancellationStorage(workspaceId);
      const foreign = new CompactionCancellation(storage);
      assert(h.aiService.stopStream != null, "Expected the installed abortable stream");
      const stopStream = h.aiService.stopStream.bind(h.aiService);
      let stopped: Awaited<ReturnType<typeof storage.read>> | undefined;
      spyOn(h.aiService, "stopStream").mockImplementationOnce(async (...args) => {
        const result = await stopStream(...args);
        await foreign.cancel({ settled: Promise.resolve(true) });
        stopped = await storage.read();
        return result;
      });
      if (route === "legacy") await state.contextController.summarize.interruptForCompaction();
      else expect(await applyThenFinish(h.session, () => Promise.resolve(false))).toBe(false);
      assert(stopped, "Expected the foreign Stop to settle before continuation");
      expect(stopped.version).toBe(2);
      expect(await storage.read()).toEqual(stopped);
      expect(starts).toHaveBeenCalledTimes(1);
      expect(await rows(h)).toEqual(before);
      mock.restore();
    }
  );

  // These callbacks interrupt an already-started turn, so model the engine's
  // completion handle rather than invoking terminal policy without settling it.
  function mockAbortableStream(h: AgentSessionHarness) {
    let completion: ReturnType<typeof Promise.withResolvers<TurnCompletion>> | undefined;
    const streamMessage = spyOn(h.aiService, "streamMessage").mockImplementation(() => {
      completion = Promise.withResolvers<TurnCompletion>();
      startStream(h);
      return Promise.resolve(Ok({ messageId: "live-assistant", completion: completion.promise }));
    });
    spyOn(h.aiService, "stopStream").mockImplementation((_id, options) => {
      const streamAbort = {
        type: "stream-abort" as const,
        workspaceId,
        messageId: completion ? "live-assistant" : "",
        abortReason: options?.abortReason,
      };
      h.aiEmitter.emit("stream-abort", streamAbort);
      completion?.resolve({
        status: "aborted",
        abortReason: options?.abortReason ?? "system",
        streamAbort,
      });
      completion = undefined;
      return Promise.resolve(Ok(undefined));
    });
    return streamMessage;
  }

  test.each(["dispatch", "cleanup"] as const)(
    "pending compaction waits and queued input outlast held follow-up %s",
    async (phase) => {
      const h = await setup();
      spyOn(continuous(h.session).continuousCompactor, "observe").mockResolvedValue("none");
      const streamMessage = mockAbortableStream(h);
      expect((await h.session.sendMessage("Working", sendOptions)).success).toBe(true);
      const entered = deferred<void>();
      const release = deferred<void>();
      const dispatchQueue = spyOn(h.session, "sendQueuedMessages").mockImplementation(
        () => undefined
      );
      const work = applyThenFinish(h.session, async (followUp) => {
        await appendBoundary(h, followUp);
        if (phase === "dispatch") {
          const read = h.historyService.getLastMessages.bind(h.historyService);
          spyOn(h.historyService, "getLastMessages").mockImplementationOnce(async (...args) => {
            entered.resolve();
            await release.promise;
            return read(...args);
          });
        } else {
          // Hard Stop now owns the durable follow-up clear before completion dispatch.
          const update = h.historyService.neutralizeCompactionRecoveryUnderHistoryLock.bind(
            h.historyService
          );
          spyOn(
            h.historyService,
            "neutralizeCompactionRecoveryUnderHistoryLock"
          ).mockImplementationOnce(async (...args) => {
            entered.resolve();
            await release.promise;
            return update(...args);
          });
          await h.session.interruptStream({ abandonPartial: true });
        }
        return true;
      });
      try {
        await entered.promise;
        h.session.queueMessage("Queued during follow-up", sendOptions);
        h.session.drainQueuedMessagesIfIdle();
        let settled = false;
        const pending = h.session.waitForMidStreamCompactionSettled().then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(dispatchQueue).not.toHaveBeenCalled();
        expect(h.session.hasActiveOrPendingTurnWork()).toBe(true);
        expect(streamMessage).toHaveBeenCalledTimes(1);
        release.resolve();
        expect(await work).toBe(true);
        await pending;
        expect(settled).toBe(true);
        const history = await rows(h);
        if (phase === "cleanup") {
          expect(history[0].metadata?.muxMetadata).not.toHaveProperty("pendingFollowUp");
          expect(streamMessage).toHaveBeenCalledTimes(1);
          expect(dispatchQueue).toHaveBeenCalledTimes(1);
        } else {
          expect(streamMessage).toHaveBeenCalledTimes(2);
          expect(history.at(-1)?.parts).toMatchObject([{ type: "text", text: "Continue" }]);
        }
      } finally {
        release.resolve();
        await work;
      }
    }
  );

  test("abandon during fast apply cannot resume the abandoned turn", async () => {
    const h = await setup();
    spyOn(continuous(h.session).continuousCompactor, "observe").mockResolvedValue("none");
    const streamMessage = mockAbortableStream(h);
    expect((await h.session.sendMessage("Working", sendOptions)).success).toBe(true);
    const applied = await applyThenFinish(h.session, async () => {
      await h.session.interruptStream({ abandonPartial: true });
      return false;
    });
    expect(applied).toBe(false);
    expect(streamMessage).toHaveBeenCalledTimes(1);
    mock.restore();
  });

  test("abandon after the boundary commit preserves the fold but clears durable resume intent", async () => {
    const h = await setup();
    spyOn(continuous(h.session).continuousCompactor, "observe").mockResolvedValue("none");
    const streamMessage = mockAbortableStream(h);
    expect((await h.session.sendMessage("Working", sendOptions)).success).toBe(true);
    const applied = await applyThenFinish(h.session, async (followUp) => {
      await appendBoundary(h, followUp);
      await h.session.interruptStream({ abandonPartial: true });
      return true;
    });
    expect(applied).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);
    const history = await rows(h);
    expect(history[0].id).toBe("continuous-boundary");
    expect(history[0].metadata?.muxMetadata).not.toHaveProperty("pendingFollowUp");
    mock.restore();
  });

  test.each(["manual", "idle", "fallback"] as const)(
    "%s compaction requests invalidate staged automatic work",
    async (source) => {
      const h = await setup();
      const reset = spyOn(continuous(h.session).continuousCompactor, "reset");
      expect(
        (
          await h.session.sendMessage("Summarize", {
            ...sendOptions,
            agentId: "compact",
            muxMetadata: {
              type: "compaction-request",
              rawCommand: "/compact",
              parsed: {},
              ...(source !== "manual"
                ? { source: source === "idle" ? "idle-compaction" : "auto-compaction" }
                : {}),
            },
          })
        ).success
      ).toBe(true);
      expect(reset).toHaveBeenCalled();
      reset.mockClear();
    }
  );

  async function summarySetup() {
    const h = await setup();
    spyOn(h.aiService, "getWorkspaceMetadata").mockResolvedValue(
      Ok({
        id: workspaceId,
        name: workspaceId,
        projectName: "continuous-test",
        projectPath: h.config.rootDir,
        runtimeConfig: { type: "local" },
      })
    );
    return {
      h,
      args: {
        workspaceId,
        config: h.config,
        aiService: h.aiService,
        head: [
          createMuxMessage("head", "user", "Preserve the root cause and the failed approaches"),
        ],
        signal: new AbortController().signal,
        context: { enabled: true, model, contextWindowTokens: 128_000, thresholdPercent: 70 },
        baseOptions: sendOptions,
        compactOptions: { ...sendOptions, model: "openai:gpt-4.1-mini", agentId: "compact" },
      },
    };
  }

  function pinnedSummaryModel(sdkModel: MockLanguageModelV3, metadataModel: string) {
    return {
      model: sdkModel,
      metadataModel,
      effectiveModelString: metadataModel,
      wireProviderName: "openai",
      optionsModelString: metadataModel,
      optionsProvidersConfig: {},
      optionsMuxProviderOptions: {},
      optionsRouteProvider: "openai" as const,
    };
  }

  function modelChunks(): LanguageModelV3StreamPart[] {
    return [
      { type: "text-start", id: "summary" },
      {
        type: "text-delta",
        id: "summary",
        delta: "The root cause was found; avoid retrying the failed approach.",
      },
      { type: "text-end", id: "summary" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
      },
    ];
  }

  test("headless summaries use the compact model and account usage with its pinned identity", async () => {
    const { h, args } = await summarySetup();
    args.head.push(
      createMuxMessage("display-only", "user", "UI-only summarizer bait", {
        muxMetadata: {
          type: "workflow-trigger-display",
          rawCommand: "/flow",
          commandPrefix: "/flow",
          runId: "wfr_test",
        },
      }),
      createMuxMessage("interrupted-head", "assistant", "unfinished investigation", {
        partial: true,
      }),
      createMuxMessage("later-head", "assistant", "later investigation")
    );
    const requests: LanguageModelV3CallOptions[] = [];
    const sdkModel = new MockLanguageModelV3({
      doStream: (request) => {
        requests.push(request);
        return Promise.resolve({ stream: simulateReadableStream({ chunks: modelChunks() }) });
      },
    });
    const create = spyOn(h.aiService, "createModelWithPinnedOptions").mockResolvedValue(
      Ok(pinnedSummaryModel(sdkModel, "openai:gpt-4.1"))
    );
    const record = mock<SessionUsageService["recordHeadlessUsage"]>(() =>
      Promise.resolve(undefined)
    );
    const result = await summarizeContinuousCompaction({
      ...args,
      sessionUsageService: { recordHeadlessUsage: record },
    });
    expect(create.mock.calls[0]?.[0]).toBe(args.compactOptions.model);
    expect(result?.model).toBe(args.compactOptions.model);
    expect(requests[0].tools ?? []).toHaveLength(0);
    expect(JSON.stringify(requests[0].prompt)).not.toContain("UI-only summarizer bait");
    const interruptedIndex = requests[0].prompt.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.content.some(
          (part) => part.type === "text" && part.text === "unfinished investigation"
        )
    );
    expect(interruptedIndex).toBeGreaterThan(-1);
    expect(requests[0].prompt[interruptedIndex + 1].role).toBe("user");
    expect(requests[0].prompt[interruptedIndex + 2].role).toBe("assistant");
    expect(
      requests[0].prompt.some(
        (message) =>
          message.role === "user" &&
          message.content.some(
            (part) => part.type === "text" && part.text.includes("Preserve the root cause")
          )
      )
    ).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[1]).toBe(args.compactOptions.model);
    expect(record.mock.calls[0]?.[2]?.inputTokens).toBe(50);
    expect(record.mock.calls[0]?.[4]?.metadataModel).toBe("openai:gpt-4.1");
    expect(await rows(h)).toHaveLength(0);
  });

  test.each([
    { route: "coder", alias: true, wire: "responses", pro: true },
    { route: "mux-gateway", alias: false, wire: "responses", pro: false },
    { route: "openai", alias: false, wire: "responses", pro: true },
    { route: "openai", alias: false, wire: "chatCompletions", pro: false },
  ] as const)(
    "summary consumes the pinned route/wire rather than raw Coder intent: %j",
    async (testCase) => {
      const { h, args } = await summarySetup();
      const rawModel = `coder:prod-openai/${testCase.alias ? "team-astra" : "gpt-6-astra"}`;
      const requests: LanguageModelV3CallOptions[] = [];
      const sdkModel = new MockLanguageModelV3({
        doStream: (request) => {
          requests.push(request);
          return Promise.resolve({ stream: simulateReadableStream({ chunks: modelChunks() }) });
        },
      });
      spyOn(h.aiService, "getProvidersConfig").mockReturnValue({
        coder: {
          apiKeySet: false,
          isEnabled: true,
          isConfigured: true,
          discoveredProviders: [{ name: "prod-openai", type: "anthropic" }],
        },
      });
      spyOn(h.aiService, "createModelWithPinnedOptions").mockResolvedValue(
        Ok({
          ...pinnedSummaryModel(sdkModel, "openai:gpt-6-astra"),
          effectiveModelString:
            testCase.route === "coder" ? rawModel : `${testCase.route}:gpt-6-astra`,
          optionsModelString: testCase.route === "coder" ? rawModel : "openai:gpt-6-astra",
          optionsRouteProvider: testCase.route,
          optionsMuxProviderOptions: { openai: { wireFormat: testCase.wire } },
          optionsProvidersConfig: {
            coder: {
              apiKeySet: false,
              isEnabled: true,
              isConfigured: true,
              discoveredProviders: [{ name: "prod-openai", type: "openai" }],
              models: [{ id: "prod-openai/team-astra", mappedToModel: "openai:gpt-6-astra" }],
            },
          },
        })
      );
      await summarizeContinuousCompaction({
        ...args,
        compactOptions: { ...args.compactOptions, model: rawModel, reasoningMode: "pro" },
        baseOptions: { ...args.baseOptions, model: rawModel, reasoningMode: "pro" },
      });
      expect(requests[0].providerOptions?.openai?.reasoningMode).toBe(
        testCase.pro ? "pro" : undefined
      );
      expect(requests[0].providerOptions?.anthropic).toBeUndefined();
    }
  );

  test("a compact model too small for the head falls back to the configured parent route without truncating", async () => {
    const { h, args } = await summarySetup();
    spyOn(h.aiService, "getProvidersConfig").mockReturnValue({
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "gpt-4.1-mini", contextWindowTokens: 1_000 }],
      },
    });
    const sdkModel = new MockLanguageModelV3({
      doStream: () =>
        Promise.resolve({ stream: simulateReadableStream({ chunks: modelChunks() }) }),
    });
    const create = spyOn(h.aiService, "createModelWithPinnedOptions").mockResolvedValue(
      Ok(pinnedSummaryModel(sdkModel, model))
    );
    const result = await summarizeContinuousCompaction({
      ...args,
      head: [createMuxMessage("large-head", "user", "Important context to retain. ".repeat(1_000))],
    });
    expect(create.mock.calls[0]?.[0]).toBe(model);
    expect(result?.model).toBe(model);
  });

  test("returns null without calling a model when neither configured context can fit the head", async () => {
    const { h, args } = await summarySetup();
    spyOn(h.aiService, "getProvidersConfig").mockReturnValue({
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "gpt-4.1-mini", contextWindowTokens: 100 }],
      },
    });
    const create = spyOn(h.aiService, "createModelWithPinnedOptions");
    const result = await summarizeContinuousCompaction({
      ...args,
      context: { ...args.context, contextWindowTokens: 100 },
      head: [createMuxMessage("oversize", "user", "Important evidence. ".repeat(1_000))],
    });
    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  test("reset cancellation actively cancels a stalled headless provider", async () => {
    const { h, args } = await summarySetup();
    const entered = deferred<void>();
    const cancelled = deferred<void>();
    const controller = new AbortController();
    const sdkModel = new MockLanguageModelV3({
      doStream: () => {
        entered.resolve();
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            cancel: () => {
              cancelled.resolve();
            },
          }),
        });
      },
    });
    spyOn(h.aiService, "createModelWithPinnedOptions").mockResolvedValue(
      Ok(pinnedSummaryModel(sdkModel, model))
    );
    const result = summarizeContinuousCompaction({ ...args, signal: controller.signal }).catch(
      (error: unknown) => error
    );
    await entered.promise;
    controller.abort();
    await cancelled.promise;
    expect(await result).toBeInstanceOf(Error);
  });

  test("context mutations and teardown synchronously invalidate staged work", async () => {
    const h = await setup();
    const reset = spyOn(continuous(h.session).continuousCompactor, "reset");
    using _admission = h.session.holdTurnAdmission();
    expect(reset).toHaveBeenCalled();
    reset.mockClear();
    await h.session.discardAutoRetryForContextMutation();
    await h.session.interruptStream({ abandonPartial: true });
    expect(reset).toHaveBeenCalled();
    reset.mockClear();
    h.session.beginShutdown();
    expect(reset).toHaveBeenCalled();
    reset.mockClear();
    h.session.beginDispose();
    expect(reset).toHaveBeenCalled();
    reset.mockClear();
  });
});
