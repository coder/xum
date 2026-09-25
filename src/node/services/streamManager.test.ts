import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { Ok } from "@/common/types/result";
import {
  StreamManager,
  type TurnEngineEvent,
  type TurnCompletion,
  type TurnExecutionOptions,
} from "./streamManager";
import { closeScopeBounded } from "./di/appRuntime";
import { Effect, Scope } from "effect";
import { createAnthropic } from "@ai-sdk/anthropic";
import * as tokenizer from "@/node/utils/main/tokenizer";
import { shouldRunIntegrationTests, validateApiKeys } from "../../../tests/testUtils";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import {
  createStreamManagerForTests,
  engineInternals,
  fakeStreamText,
  onTurnEngineEvent,
} from "./streamManager.testHarness";
import { AIService } from "./aiService";
import { InitStateManager } from "./initStateManager";
import { ProviderService } from "./providerService";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import {
  installStreamManagerTestHistory,
  historyService,
  historyConfig,
  createTestLanguageModel,
  testStartOptions,
  appendPartialAssistantForTests,
  createStreamResultForTests,
  createStreamInfoForTests,
} from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

// Skip integration tests if TEST_INTEGRATION is not set

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

describe("StreamManager - engine supervision (AppFiberScope occupant)", () => {
  type StreamAbortEvent = Extract<TurnEngineEvent, { type: "stream-abort" }>;

  /**
   * A manager whose streams are supervised by `engineScope` (the app runtime's
   * AppFiberScope in production). `fullStream` receives the stream's own
   * AbortSignal so scenarios can model a provider that stops on abort — or one
   * that ignores it.
   */
  function createSupervisedStreamManagerForTests(
    fullStream: (signal: AbortSignal) => AsyncGenerator<unknown, void, unknown>,
    options: { supervised: boolean } = { supervised: true }
  ) {
    const engineScope = Scope.makeUnsafe("parallel");
    const events: TurnEngineEvent[] = [];
    const streamManager = createStreamManagerForTests(historyService, {
      eventSink: (event) => {
        events.push(event);
      },
      engineScope: options.supervised ? engineScope : undefined,
      streamText: fakeStreamText((request) =>
        createStreamResultForTests(fullStream(request.abortSignal!))
      ),
    });
    return { streamManager, events, engineScope };
  }

  async function startSupervisedStreamForTests(
    streamManager: StreamManager,
    workspaceId: string,
    historySequence = 1
  ) {
    const messageId = `${workspaceId}-msg-${historySequence}`;
    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId,
        messageId,
        model: createTestLanguageModel(),
        tools: {},
        historySequence,
        providedRuntimeTempDir: "",
      })
    );
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected stream to start");
    }
    return result.data;
  }

  /** Yields one delta, then blocks until the stream's AbortSignal fires (a well-behaved provider). */
  function flowingThenBlockedStream(signal: AbortSignal): AsyncGenerator<unknown, void, unknown> {
    return (async function* () {
      yield { type: "text-delta", text: "hello" };
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    })();
  }

  async function waitForPartialText(workspaceId: string, text: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const partial = await historyService.readPartial(workspaceId);
      if (
        partial?.parts.some((part) => part.type === "text" && part.text.includes(text)) === true
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`partial for ${workspaceId} never contained ${JSON.stringify(text)}`);
  }

  function terminalEvents(events: TurnEngineEvent[]): TurnEngineEvent[] {
    return events.filter((event) => ["stream-end", "stream-abort", "error"].includes(event.type));
  }

  test("closing the engine scope aborts a flowing stream as 'system', commits its partial and settles it", async () => {
    const workspaceId = "supervised-flowing-workspace";
    const { streamManager, events, engineScope } =
      createSupervisedStreamManagerForTests(flowingThenBlockedStream);
    const writePartialSpy = spyOn(historyService, "writePartial");
    const handle = await startSupervisedStreamForTests(streamManager, workspaceId);
    await waitForPartialText(workspaceId, "hello");
    expect(streamManager.isStreaming(workspaceId)).toBe(true);

    // What ServiceContainer.dispose() does at step 2: interrupt + await.
    await closeScopeBounded(engineScope);

    // The finalizer routed through the user-stop path: the streamed text was
    // flushed (with usage stamping) before the abort was delivered ...
    const lastWrite = writePartialSpy.mock.calls.at(-1)?.[1];
    expect(lastWrite?.parts.some((part) => part.type === "text" && part.text === "hello")).toBe(
      true
    );
    // ... exactly one terminal event, an involuntary backend abort, no stream-end ...
    const terminal = terminalEvents(events);
    expect(terminal.map((event) => event.type)).toEqual(["stream-abort"]);
    expect((terminal[0] as StreamAbortEvent).abortReason).toBe("system");
    // ... and the turn handle plus the registry were settled before the close resolved.
    expect(await handle.completion).toMatchObject({ status: "aborted", abortReason: "system" });
    expect(streamManager.getActiveStreams()).toEqual([]);
    expect(streamManager.isStreaming(workspaceId)).toBe(false);
  });

  test.each([
    "tokenization",
    "sink-sync",
    "sink-async",
    "preflush",
    "processing",
    "usage",
    "soft-tokenization",
    "soft-preflush",
    "soft-usage",
  ] as const)("abort completion survives %s failure", async (failure) => {
    const workspaceId = `abort-failure-${failure}`;
    const soft = failure.startsWith("soft-");
    const failureKind = failure.replace("soft-", "");
    const releaseBoundary = Promise.withResolvers<void>();
    const providerEntered = Promise.withResolvers<void>();
    const { streamManager, events } = createSupervisedStreamManagerForTests(
      (signal) =>
        (async function* () {
          yield { type: "reasoning-delta", text: "unfinished reasoning" };
          providerEntered.resolve();
          if (soft) {
            await releaseBoundary.promise;
            yield { type: "text-end" };
          }
          if (!signal.aborted) {
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true })
            );
          }
        })(),
      { supervised: false }
    );
    const handle = await startSupervisedStreamForTests(streamManager, workspaceId);
    await providerEntered.promise;
    const streamInfo = engineInternals(streamManager).workspaceStreams.get(workspaceId) as Record<
      string,
      unknown
    >;
    const usage = { inputTokens: 120, outputTokens: 30, totalTokens: 150 };
    streamInfo.cumulativeUsage = usage;
    const processingPromise = streamInfo.processingPromise as Promise<void>;
    const abortController = streamInfo.abortController as AbortController;
    const countTokensSpy = spyOn(tokenizer, "countTokens");
    const flush = engineInternals(streamManager).flushPartialWrite;
    let outcome: TurnCompletion | undefined;
    const observed = handle.completion.then((value) => {
      outcome = value;
    });
    try {
      if (failureKind === "tokenization") {
        countTokensSpy.mockRejectedValueOnce(new Error("tokenizer unavailable"));
      } else if (failureKind === "sink-sync" || failureKind === "sink-async") {
        streamManager.setEventSink((event) => {
          events.push(event);
          if (event.type !== "stream-abort") return;
          if (failureKind === "sink-sync") throw new Error("synchronous sink failure");
          return Promise.reject(new Error("asynchronous sink failure"));
        });
      } else if (failureKind === "preflush") {
        engineInternals(streamManager).flushPartialWrite = () => {
          engineInternals(streamManager).flushPartialWrite = flush;
          return Promise.reject(new Error("pre-cancel flush failure"));
        };
      } else if (failureKind === "usage") {
        engineInternals(streamManager).recordSessionUsage = () =>
          Promise.reject(new Error("usage attribution unavailable"));
      } else {
        // A teardown failure after the provider exits rejects the processing join.
        streamInfo.processingPromise = processingPromise.then(() => {
          throw new Error("processing teardown failure");
        });
      }
      expect(
        (await streamManager.stopStream(workspaceId, { abortReason: "user", soft })).success
      ).toBe(true);
      if (soft) {
        releaseBoundary.resolve();
        await processingPromise;
        await streamInfo.cancelPromise;
      }
      // stop intentionally does not await sink delivery; drain its settlement microtasks.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outcome).toMatchObject({
        status: "aborted",
        abortReason: "user",
        streamAbort: {
          messageId: handle.messageId,
          metadata: { usage },
        },
      });
      await observed;
      expect(abortController.signal.aborted).toBe(true);
      expect(terminalEvents(events).map((event) => event.type)).toEqual(["stream-abort"]);
      expect(streamManager.getActiveStreams()).toEqual([]);
    } finally {
      countTokensSpy.mockRestore();
      engineInternals(streamManager).flushPartialWrite = flush;
      abortController.abort();
      releaseBoundary.resolve();
      await processingPromise;
    }
  });

  test.each(["interrupt", "edit", "raw-listener", "partial-commit"] as const)(
    "%s finishes and publishes its abort despite cancellation bookkeeping failure",
    async (scenario) => {
      const workspaceId = `session-abort-failure-${scenario}`;
      const providerEntered = Promise.withResolvers<void>();
      const replacementEntered = Promise.withResolvers<void>();
      let providerCalls = 0;
      const { streamManager } = createSupervisedStreamManagerForTests(
        (signal) =>
          (async function* () {
            yield { type: "text-delta", text: "retained partial" };
            yield { type: "reasoning-delta", text: "unfinished reasoning" };
            if (++providerCalls === 1) providerEntered.resolve();
            else replacementEntered.resolve();
            if (!signal.aborted)
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true })
              );
          })(),
        { supervised: false }
      );
      const service = new AIService(
        historyConfig,
        historyService,
        new InitStateManager(historyConfig),
        new ProviderService(historyConfig),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        streamManager
      );
      let turns = 0;
      spyOn(service, "streamMessage").mockImplementation(async () =>
        Ok(await startSupervisedStreamForTests(streamManager, workspaceId, ++turns * 2 - 1))
      );
      const h = await createAgentSessionHarness({
        workspaceId,
        config: historyConfig,
        historyService,
        aiService: service,
        streamManager,
        captureEvents: true,
      });
      const countTokensSpy = spyOn(tokenizer, "countTokens");
      const commitSpy = spyOn(historyService, "commitPartial");
      const throwFromRawListener = () => {
        throw new Error("raw abort subscriber failure");
      };
      const options = { model: "openai:gpt-4.1-mini", agentId: "exec" };
      try {
        await h.session.sendMessage("original", options);
        await providerEntered.promise;
        const streamInfo = engineInternals(streamManager).workspaceStreams.get(
          workspaceId
        ) as Record<string, unknown>;
        streamInfo.cumulativeUsage = { inputTokens: 120, outputTokens: 30, totalTokens: 150 };
        if (scenario === "raw-listener") service.on("stream-abort", throwFromRawListener);
        else if (scenario === "partial-commit")
          commitSpy.mockRejectedValueOnce(new Error("disk unavailable"));
        else countTokensSpy.mockRejectedValueOnce(new Error("tokenizer unavailable"));
        const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
        if (!history.success) throw new Error(history.error);
        const userId = history.data.find((message) => message.role === "user")!.id;
        const result =
          scenario === "edit"
            ? await h.session.sendMessage("edited", { ...options, editMessageId: userId })
            : await h.session.interruptStream();
        expect(result.success).toBe(true);
        expect(h.events.filter((event) => event.type === "stream-abort")).toMatchObject([
          { abortReason: "user", messageId: `${workspaceId}-msg-1` },
        ]);
        if (scenario !== "edit") {
          expect(h.session.isBusy()).toBe(false);
          const partial = await historyService.readPartial(workspaceId);
          if (scenario === "partial-commit") expect(partial).not.toBeNull();
          else expect(partial).toBeNull();
          if (scenario !== "partial-commit") {
            const committed = await historyService.getHistoryFromLatestBoundary(workspaceId);
            if (!committed.success) throw new Error(committed.error);
            expect(
              committed.data.find((message) => message.role === "assistant")?.metadata?.usage
            ).toMatchObject({ inputTokens: 120, outputTokens: 30 });
          }
          expect((await h.session.sendMessage("next", options)).success).toBe(true);
        }
        await replacementEntered.promise;
        expect(providerCalls).toBe(2);
        expect(h.session.isBusy()).toBe(true);
      } finally {
        service.off("stream-abort", throwFromRawListener);
        countTokensSpy.mockRestore();
        commitSpy.mockRestore();
        await h.session.dispose();
        await streamManager.stopStream(workspaceId, { abortReason: "system" });
      }
    }
  );

  test("a wedged provider (never yields, ignores abort) cannot pin the bounded close", async () => {
    const workspaceId = "supervised-wedged-workspace";
    const { streamManager, engineScope } = createSupervisedStreamManagerForTests(() =>
      (async function* () {
        await new Promise<never>(() => undefined);
        yield { type: "text-delta", text: "never" };
      })()
    );
    await startSupervisedStreamForTests(streamManager, workspaceId);
    expect(streamManager.isStreaming(workspaceId)).toBe(true);

    // cleanupAbortedStream waits for the loop, which waits on the provider that
    // never returns; the close must still resolve at the bound, and never reject.
    const startedAt = Date.now();
    await closeScopeBounded(engineScope, 100);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("a stream started after the engine scope closed is aborted immediately (fail-closed during shutdown)", async () => {
    const workspaceId = "supervised-late-start-workspace";
    const { streamManager, events, engineScope } =
      createSupervisedStreamManagerForTests(flowingThenBlockedStream);
    await closeScopeBounded(engineScope);

    const handle = await startSupervisedStreamForTests(streamManager, workspaceId);

    expect(await handle.completion).toMatchObject({ status: "aborted", abortReason: "system" });
    expect(terminalEvents(events).map((event) => event.type)).toEqual(["stream-abort"]);
    expect(streamManager.getActiveStreams()).toEqual([]);
  });

  test("a cancel landing after the loop finished but before COMPLETED neither resurrects partial.json nor emits a second terminal event", async () => {
    // The completion path deletes partial.json, then awaits updateHistory, and
    // only then flips state to COMPLETED. A cancel (user stop or the shutdown
    // supervisor) landing inside that window previously re-created partial.json
    // (pre-abort flush + abort bookkeeping) and emitted stream-abort after
    // stream-end. No engine scope here: this is the stopStream path itself.
    const workspaceId = "cancel-after-loop-exit-workspace";
    const { streamManager, events } = createSupervisedStreamManagerForTests(
      () =>
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "final answer" };
          yield { type: "finish", finishReason: "stop" };
        })(),
      { supervised: false }
    );
    const finalWriteEntered = Promise.withResolvers<void>();
    const releaseFinalWrite = Promise.withResolvers<void>();
    const realUpdateHistory = historyService.updateHistory.bind(historyService);
    const updateHistorySpy = spyOn(historyService, "updateHistory").mockImplementation(
      async (targetWorkspaceId, message) => {
        finalWriteEntered.resolve();
        await releaseFinalWrite.promise;
        return realUpdateHistory(targetWorkspaceId, message);
      }
    );
    let completionObserved: Promise<void> | undefined;
    let stopPromise: Promise<unknown> | undefined;
    try {
      const handle = await startSupervisedStreamForTests(streamManager, workspaceId);
      let settled = false;
      completionObserved = handle.completion.then(async () => {
        settled = true;
        // Dependent turns read immediately on completion, so final history must already exist.
        const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(history.success).toBe(true);
        if (!history.success) throw new Error(history.error);
        expect(history.data.filter((message) => message.role === "assistant")).toMatchObject([
          { parts: [{ type: "text", text: "final answer" }] },
        ]);
        expect(history.data[0].metadata?.partial).not.toBe(true);
      });

      await finalWriteEntered.promise;
      stopPromise = streamManager.stopStream(workspaceId);
      const beforeCommit = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(beforeCommit.success).toBe(true);
      if (!beforeCommit.success) throw new Error(beforeCommit.error);
      expect(beforeCommit.data[0].parts).toEqual([]);
      expect(settled).toBe(false);
      expect(terminalEvents(events)).toEqual([]);

      releaseFinalWrite.resolve();
      expect(await handle.completion).toMatchObject({ status: "completed" });
      expect(await stopPromise).toEqual(Ok(undefined));
      await completionObserved;

      expect(terminalEvents(events).map((event) => event.type)).toEqual(["stream-end"]);
      expect(await historyService.readPartial(workspaceId)).toBeNull();
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      const assistantRows = history.data.filter((message) => message.role === "assistant");
      expect(assistantRows).toHaveLength(1);
      expect(assistantRows[0].metadata?.partial).not.toBe(true);
      expect(
        assistantRows[0].parts.some((part) => part.type === "text" && part.text === "final answer")
      ).toBe(true);
      expect(streamManager.getActiveStreams()).toEqual([]);
    } finally {
      releaseFinalWrite.resolve();
      try {
        await stopPromise;
        await completionObserved;
      } finally {
        updateHistorySpy.mockRestore();
      }
    }
  });

  test("stopStream racing the engine-scope close produces exactly one stream-abort and one settle", async () => {
    const workspaceId = "supervised-stop-vs-close-workspace";
    const { streamManager, events, engineScope } =
      createSupervisedStreamManagerForTests(flowingThenBlockedStream);
    const handle = await startSupervisedStreamForTests(streamManager, workspaceId);
    await waitForPartialText(workspaceId, "hello");
    let settleCount = 0;
    void handle.completion.then(() => {
      settleCount += 1;
    });

    // Both cancellers enter cancelStreamSafely in the same tick; the latch is
    // taken synchronously, so the second joins the first's cleanup.
    const stopPromise = streamManager.stopStream(workspaceId, { abortReason: "user" });
    const closePromise = closeScopeBounded(engineScope);
    await Promise.all([stopPromise, closePromise]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const aborts = events.filter(
      (event): event is StreamAbortEvent => event.type === "stream-abort"
    );
    expect(aborts).toHaveLength(1);
    // First canceller's reason wins (the user pressed stop before shutdown reached the stream).
    expect(aborts[0].abortReason).toBe("user");
    expect(terminalEvents(events)).toHaveLength(1);
    expect(settleCount).toBe(1);
    expect(await handle.completion).toMatchObject({ status: "aborted", abortReason: "user" });
    expect(streamManager.getActiveStreams()).toEqual([]);
  });

  test.each(["envelope", "construction fence"] as const)(
    "closing the engine scope while %s is pending cancels the STARTING stream inside the close",
    async (held) => {
      // startStream registers the stream, then awaits onStreamConstructed (the
      // durable turn-envelope write) before launching processing. Supervision
      // starts at registration, so a shutdown landing inside that await cancels
      // the STARTING stream through the same hard-interrupt path a user stop
      // takes there — before closeScopeBounded resolves, not after teardown has
      // moved on and the envelope write finally returns.
      const workspaceId = "supervised-starting-window-workspace";
      const { streamManager, events, engineScope } =
        createSupervisedStreamManagerForTests(flowingThenBlockedStream);
      const messageId = `${workspaceId}-msg`;
      await appendPartialAssistantForTests(workspaceId, messageId, 1);
      let releaseEnvelope!: () => void;
      const envelopeWritten = new Promise<void>((resolve) => {
        releaseEnvelope = resolve;
      });
      const captured = await historyService.captureCompactionReplacement(workspaceId);
      if (!captured.success) throw new Error(captured.error);
      const startPromise = streamManager.startStream(
        testStartOptions({
          workspaceId,
          messageId,
          model: createTestLanguageModel(),
          tools: {},
          providedRuntimeTempDir: "",
          onStreamConstructed: held === "envelope" ? () => envelopeWritten : undefined,
          withAdmissionCurrent:
            held === "construction fence"
              ? async (construct) => {
                  const result = await historyService.runWithCompactionAdmission(
                    workspaceId,
                    captured.data,
                    construct
                  );
                  if (!result.success) throw new Error(result.error);
                  await envelopeWritten;
                }
              : undefined,
        })
      );
      const deadline = Date.now() + 5_000;
      while (!streamManager.getActiveStreams().includes(workspaceId)) {
        if (Date.now() > deadline) throw new Error("stream never registered");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      await closeScopeBounded(engineScope);

      // Cancelled inside the close: abort delivered, registry cleared, no
      // stream-start ever emitted for it.
      expect(terminalEvents(events).map((event) => event.type)).toEqual(["stream-abort"]);
      expect((terminalEvents(events)[0] as StreamAbortEvent).abortReason).toBe("system");
      expect(streamManager.getActiveStreams()).toEqual([]);

      releaseEnvelope();
      const result = await startPromise;
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("expected Ok");
      expect(await result.data.completion).toMatchObject({
        status: "aborted",
        abortReason: "system",
      });
      expect(events.filter((event) => event.type === "stream-start")).toHaveLength(0);
      expect(terminalEvents(events)).toHaveLength(1);
      expect(streamManager.isStreaming(workspaceId)).toBe(false);
    }
  );

  test("a provider whose iterator rejects on abort is still recorded as an abort, not a failure", async () => {
    // Some transports surface a cancellation as an iterator rejection rather
    // than a clean close. The canceller owns the terminal bookkeeping, so the
    // loop must not record that rejection as a provider failure — otherwise the
    // lost-race guard would suppress the stream-abort and the partial commit.
    const workspaceId = "abort-as-rejection-workspace";
    const { streamManager, events } = createSupervisedStreamManagerForTests(
      (signal) =>
        (async function* () {
          yield { type: "text-delta", text: "hello" };
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new Error("connection reset after abort");
        })(),
      { supervised: false }
    );
    const handle = await startSupervisedStreamForTests(streamManager, workspaceId);
    await waitForPartialText(workspaceId, "hello");

    expect(await streamManager.stopStream(workspaceId, { abortReason: "user" })).toEqual(
      Ok(undefined)
    );

    expect(await handle.completion).toMatchObject({ status: "aborted", abortReason: "user" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(terminalEvents(events).map((event) => event.type)).toEqual(["stream-abort"]);
    expect(streamManager.getActiveStreams()).toEqual([]);
  });

  test("a resource finalizer defect cannot orphan a completed engine handle", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const workspaceId = "completion-finalizer-defect";
    const { streamManager, events, engineScope } = createSupervisedStreamManagerForTests(() =>
      (async function* () {
        yield { type: "text-delta", text: "completed answer" };
        entered.resolve();
        await release.promise;
        yield { type: "finish", finishReason: "stop" };
      })()
    );
    const handle = await startSupervisedStreamForTests(streamManager, workspaceId);
    await entered.promise;
    const info = engineInternals(streamManager).workspaceStreams.get(workspaceId) as {
      resourceScope: Scope.Closeable;
    };
    Effect.runSync(Scope.addFinalizer(info.resourceScope, Effect.die(new Error("cleanup defect"))));
    release.resolve();
    expect(await handle.completion).toMatchObject({ status: "completed" });
    expect(terminalEvents(events).map((event) => event.type)).toEqual(["stream-end"]);
    expect(streamManager.getActiveStreams()).toEqual([]);
    await closeScopeBounded(engineScope);
  });

  test("completed streams leave no supervisor residue: closing the scope after 50 completions aborts nothing", async () => {
    const workspaceId = "supervised-residue-workspace";
    const { streamManager, events, engineScope } = createSupervisedStreamManagerForTests(() =>
      (async function* () {
        await Promise.resolve();
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", finishReason: "stop" };
      })()
    );
    for (let i = 1; i <= 50; i++) {
      const handle = await startSupervisedStreamForTests(streamManager, workspaceId, i);
      expect(await handle.completion).toMatchObject({ status: "completed" });
    }
    expect(streamManager.getActiveStreams()).toEqual([]);
    expect(events.filter((event) => event.type === "stream-end")).toHaveLength(50);

    await closeScopeBounded(engineScope);

    expect(events.filter((event) => event.type === "stream-abort")).toHaveLength(0);
    expect(streamManager.getActiveStreams()).toEqual([]);
  });
});

describe("StreamManager - stop scoped to a captured execution", () => {
  test("expectedMessageId skips a replacement start and still stops the captured one", async () => {
    const manager = new StreamManager(historyService);
    const workspaceId = "expected-message-stop";
    // A start is pending (admitted turn between registration and its provider request).
    const pending = manager.beginStreamStart({ workspaceId });
    try {
      // A late stop captured for an OLDER execution must not cancel this replacement.
      expect(
        await manager.stopStream(workspaceId, { expectedMessageId: "older-execution" })
      ).toEqual(Ok(undefined));
      expect(pending.abortSignal.aborted).toBe(false);
      // The stop captured for THIS execution proceeds.
      expect(
        await manager.stopStream(workspaceId, { expectedMessageId: pending.syntheticMessageId })
      ).toEqual(Ok(undefined));
      expect(pending.abortSignal.aborted).toBe(true);
    } finally {
      pending.finish();
    }
  });

  test("a registered stream with a different messageId is left untouched by a scoped stop", async () => {
    const manager = new StreamManager(historyService);
    const workspaceId = "expected-message-registered";
    const abortController = new AbortController();
    const streamInfo = createStreamInfoForTests({ messageId: "replacement-B", abortController });
    engineInternals(manager).workspaceStreams.set(workspaceId, streamInfo);
    expect(await manager.stopStream(workspaceId, { expectedMessageId: "captured-A" })).toEqual(
      Ok(undefined)
    );
    expect(abortController.signal.aborted).toBe(false);
    expect(engineInternals(manager).workspaceStreams.get(workspaceId)).toBe(streamInfo);
    engineInternals(manager).workspaceStreams.delete(workspaceId);
  });
});

describe("StreamManager - turn completion", () => {
  /** Stream body that stays open until its turn abort controller fires. */
  const hangUntilAbort = ({ abortSignal }: { abortSignal?: AbortSignal }) =>
    createStreamResultForTests(
      (async function* () {
        await new Promise<void>((resolve) => {
          abortSignal!.addEventListener("abort", () => resolve(), { once: true });
        });
        yield* [];
      })()
    );

  async function startWithStreamResult(input: {
    workspaceId: string;
    messageId: string;
    fullStream?: AsyncGenerator<unknown, void, unknown>;
    streamText?: Parameters<typeof fakeStreamText>[0];
    sink?: (event: TurnEngineEvent) => void | Promise<void>;
    events?: TurnEngineEvent[];
    systemMessageTokens?: number;
  }) {
    const streamManager = createStreamManagerForTests(historyService, {
      eventSink:
        input.sink ??
        ((event) => {
          input.events?.push(event);
        }),
      streamText: fakeStreamText(
        input.streamText ?? (() => createStreamResultForTests(input.fullStream!))
      ),
    });
    await appendPartialAssistantForTests(input.workspaceId, input.messageId, 1);

    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId: input.workspaceId,
        messageId: input.messageId,
        model: createTestLanguageModel(),
        providedRuntimeTempDir: "",
        initialMetadata: { systemMessageTokens: input.systemMessageTokens },
      })
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected stream to start");
    return { streamManager, handle: result.data };
  }

  test("replacement and concurrent stops join the captured attempt's held commit", async () => {
    const workspaceId = "held-commit-replacement";
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const providerEntered = Promise.withResolvers<void>();
    const terminals: TurnEngineEvent[] = [];
    const originalCommit = historyService.commitPartial.bind(historyService);
    spyOn(historyService, "commitPartial").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return originalCommit(...args);
    });
    const { streamManager, handle } = await startWithStreamResult({
      workspaceId,
      messageId: "attempt-a",
      events: terminals,
      streamText: ({ abortSignal }) =>
        createStreamResultForTests(
          (async function* () {
            yield { type: "text-delta", text: "durable interrupted answer" };
            providerEntered.resolve();
            if (!abortSignal!.aborted)
              await new Promise<void>((resolve) =>
                abortSignal!.addEventListener("abort", () => resolve(), { once: true })
              );
          })()
        ),
    });
    await providerEntered.promise;
    let stopped = false;
    let replaced = false;
    const userStop = streamManager.stopStream(workspaceId, { abortReason: "user" }).then(() => {
      stopped = true;
    });
    await entered.promise;
    const systemStop = streamManager.stopStream(workspaceId, {
      abortReason: "system",
      abandonPartial: true,
    });
    const replacement = streamManager
      .startStream(
        testStartOptions({
          workspaceId,
          messageId: "attempt-b",
          historySequence: 2,
          model: createTestLanguageModel(),
          providedRuntimeTempDir: "",
          onStreamConstructed: () => appendPartialAssistantForTests(workspaceId, "attempt-b", 2),
        })
      )
      .then((result) => {
        replaced = true;
        return result;
      });
    try {
      expect(stopped).toBe(false);
      expect(replaced).toBe(false);
      expect(streamManager.getStreamInfo(workspaceId, true)?.messageId).toBe("attempt-a");
      expect(terminals.filter((event) => event.type === "stream-abort")).toHaveLength(0);
      release.resolve();
      await Promise.all([userStop, systemStop]);
      expect(await handle.completion).toMatchObject({ status: "aborted", abortReason: "user" });
      const next = await replacement;
      expect(next.success).toBe(true);
      expect(streamManager.getStreamInfo(workspaceId)?.messageId).toBe("attempt-b");
      const history = await historyService.getLastMessages(workspaceId, 10);
      if (!history.success) throw new Error(history.error);
      expect(history.data.find((message) => message.id === "attempt-a")?.parts).toMatchObject([
        { type: "text", text: "durable interrupted answer" },
      ]);
      expect(
        terminals.filter(
          (event) => event.type === "stream-abort" && event.messageId === "attempt-a"
        )
      ).toHaveLength(1);
    } finally {
      release.resolve();
      await replacement;
      await streamManager.stopStream(workspaceId, { abandonPartial: true });
    }
  });

  test("pre-start failures return Err while successful startup owns an aborted completion", async () => {
    const streamManager = new StreamManager(historyService);
    const model = createTestLanguageModel();
    const failed = await streamManager.startStream(
      testStartOptions({
        workspaceId: "completion-prestart-failure",
        messageId: "prestart-failure-message",
        model,
        messages: [],
      })
    );
    expect(failed.success).toBe(false);

    const abortController = new AbortController();
    abortController.abort();
    const aborted = await streamManager.startStream(
      testStartOptions({
        workspaceId: "completion-prestart-abort",
        messageId: "prestart-abort-message",
        model,
        abortSignal: abortController.signal,
      })
    );
    expect(aborted.success).toBe(true);
    if (!aborted.success) throw new Error("Expected aborted startup handle");
    expect(await aborted.data.completion).toMatchObject({
      status: "aborted",
      abortReason: "startup",
    });
  });

  test("completed, failed, and debug-injected turns settle once after their terminal event", async () => {
    const completedEvents: TurnEngineEvent[] = [];
    const completed = await startWithStreamResult({
      workspaceId: "completion-success-workspace",
      messageId: "completion-success-message",
      events: completedEvents,
      fullStream: (async function* () {
        await Promise.resolve();
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", finishReason: "stop" };
      })(),
    });
    let completedSettlements = 0;
    void completed.handle.completion.then(() => {
      completedSettlements += 1;
    });
    expect(await completed.handle.completion).toMatchObject({ status: "completed" });
    await Promise.resolve();
    expect(completedEvents.at(-1)?.type).toBe("stream-end");
    expect(completedSettlements).toBe(1);

    const failedEvents: TurnEngineEvent[] = [];
    const failed = await startWithStreamResult({
      workspaceId: "completion-failure-workspace",
      messageId: "completion-failure-message",
      events: failedEvents,
      fullStream: (async function* () {
        await Promise.resolve();
        throw new Error("provider failed");
        yield* [];
      })(),
    });
    let failedSettlements = 0;
    void failed.handle.completion.then(() => {
      failedSettlements += 1;
    });
    const failedCompletion = await failed.handle.completion;
    expect(failedCompletion.status).toBe("failed");
    expect(failedEvents.at(-1)?.type).toBe("error");
    await failed.streamManager.stopStream("completion-failure-workspace");
    await Promise.resolve();
    expect(failedSettlements).toBe(1);

    // Debug-injected failures reach the same terminal settlement path.
    const debug = await startWithStreamResult({
      workspaceId: "completion-debug-error-workspace",
      messageId: "completion-debug-error-message",
      streamText: hangUntilAbort,
    });
    expect(
      await debug.streamManager.debugTriggerStreamError(
        "completion-debug-error-workspace",
        "debug injected failure"
      )
    ).toBe(true);
    expect(await debug.handle.completion).toMatchObject({
      status: "failed",
      streamError: { error: "debug injected failure" },
    });
  });

  test("hard stop and completion wait for raw delivery after attempt persistence", async () => {
    const workspaceId = "completion-abort-workspace";
    const providerBlocked = Promise.withResolvers<void>();
    const abortDeliveryEntered = Promise.withResolvers<void>();
    const releaseAbortDelivery = Promise.withResolvers<void>();
    const { streamManager, handle } = await startWithStreamResult({
      workspaceId,
      messageId: "completion-abort-message",
      systemMessageTokens: 733,
      streamText: ({ abortSignal }) =>
        createStreamResultForTests(
          (async function* () {
            yield { type: "text-delta", text: "interrupted answer" };
            providerBlocked.resolve();
            await new Promise<void>((resolve) => {
              if (abortSignal!.aborted) return resolve();
              abortSignal!.addEventListener("abort", () => resolve(), { once: true });
            });
          })()
        ),
      sink: async (event) => {
        if (event.type !== "stream-abort") return;
        abortDeliveryEntered.resolve();
        await releaseAbortDelivery.promise;
        expect(await historyService.readPartial(workspaceId)).toBeNull();
      },
    });

    let settled = false;
    const completionObserved = handle.completion.then(async () => {
      settled = true;
      return {
        history: await historyService.getHistoryFromLatestBoundary(workspaceId),
        partial: await historyService.readPartial(workspaceId),
      };
    });
    let stopPromise: Promise<unknown> | undefined;
    try {
      await providerBlocked.promise;
      stopPromise = streamManager.stopStream(workspaceId, { abortReason: "user" });
      await abortDeliveryEntered.promise;
      expect(streamManager.isStreaming(workspaceId)).toBe(false);
      expect(await historyService.readPartial(workspaceId)).toBeNull();
      expect(streamManager.getStreamInfo(workspaceId, true)?.messageId).toBe(handle.messageId);
      expect(settled).toBe(false);

      releaseAbortDelivery.resolve();
      expect(await handle.completion).toMatchObject({
        status: "aborted",
        abortReason: "user",
        systemMessageTokens: 733,
        streamAbort: { type: "stream-abort", workspaceId, messageId: handle.messageId },
      });
      expect(streamManager.getStreamInfo(workspaceId)).toBeUndefined();
      const observed = await completionObserved;
      expect(observed.partial).toBeNull();
      expect(observed.history.success).toBe(true);
      if (!observed.history.success) throw new Error(observed.history.error);
      expect(observed.history.data).toMatchObject([
        { id: handle.messageId, parts: [{ type: "text", text: "interrupted answer" }] },
      ]);
    } finally {
      releaseAbortDelivery.resolve();
      await (stopPromise ?? streamManager.stopStream(workspaceId));
      await completionObserved;
    }
  });
});

describe("StreamManager - Concurrent Stream Prevention", () => {
  let streamManager: StreamManager;
  const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });

  beforeEach(() => {
    streamManager = new StreamManager(historyService);
    // Suppress error events from bubbling up as uncaught exceptions during tests
  });

  // Unit test - doesn't require API key
  test("should serialize multiple rapid startStream calls", async () => {
    // This is a simpler test that doesn't require API key
    // It tests the mutex behavior without actually streaming

    const workspaceId = "test-workspace-serial";

    // Track the order of operations
    const operations: string[] = [];

    // Create a dummy model (won't actually be used since we're mocking the core behavior)
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    interface WorkspaceStreamInfoStub {
      state: string;
      streamResult: {
        fullStream: AsyncGenerator<unknown, void, unknown>;
        usage: Promise<unknown>;
        providerMetadata: Promise<unknown>;
      };
      abortController: AbortController;
      messageId: string;
      token: string;
      startTime: number;
      model: string;
      initialMetadata?: Record<string, unknown>;
      historySequence: number;
      parts: unknown[];
      lastPartialWriteTime: number;
      partialWriteTimer?: ReturnType<typeof setTimeout>;
      partialWritePromise?: Promise<void>;
      processingPromise: Promise<void>;
    }

    engineInternals(streamManager).ensureStreamSafety = async (_wsId: string): Promise<string> => {
      operations.push("ensure-start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      operations.push("ensure-end");
      return "test-token";
    };

    streamManager.createTempDirForStream = (
      _streamToken: string,
      _runtime: unknown
    ): Promise<string> => {
      return Promise.resolve("/tmp/mock-stream-temp");
    };

    const workspaceStreamsValue = engineInternals(streamManager).workspaceStreams;
    if (!(workspaceStreamsValue instanceof Map)) {
      throw new Error("StreamManager.workspaceStreams is not a Map");
    }
    const workspaceStreams = workspaceStreamsValue as Map<string, WorkspaceStreamInfoStub>;

    engineInternals(streamManager).createStreamAtomically = (
      options: TurnExecutionOptions,
      ctx: { streamToken: string; abortController: AbortController }
    ): WorkspaceStreamInfoStub => {
      operations.push("create");

      const streamInfo: WorkspaceStreamInfoStub = {
        state: "starting",
        streamResult: {
          fullStream: (async function* asyncGenerator() {
            // No-op generator; we only care about synchronization
          })(),
          usage: Promise.resolve(undefined),
          providerMetadata: Promise.resolve(undefined),
        },
        abortController: ctx.abortController,
        messageId: `test-${Math.random().toString(36).slice(2)}`,
        token: ctx.streamToken,
        startTime: Date.now(),
        model: options.modelString,
        initialMetadata: options.initialMetadata,
        historySequence: options.historySequence,
        parts: [],
        lastPartialWriteTime: 0,
        partialWriteTimer: undefined,
        partialWritePromise: undefined,
        processingPromise: Promise.resolve(),
      };

      workspaceStreams.set(options.workspaceId, streamInfo);
      return streamInfo;
    };

    engineInternals(streamManager).processStreamWithCleanup = async (
      wsId: string
    ): Promise<void> => {
      operations.push("process-start");
      await sleep(20);
      const info = workspaceStreams.get(wsId);
      if (info) info.state = "streaming";
      operations.push("process-end");
    };

    const anthropic = createAnthropic({ apiKey: "dummy-key" });
    const model = anthropic("claude-sonnet-4-5");

    // Start three streams rapidly
    // Without mutex, these would interleave (ensure-start, ensure-start, ensure-start, ensure-end, ensure-end, ensure-end)
    // With mutex, they should be serialized (ensure-start, ensure-end, ensure-start, ensure-end, ensure-start, ensure-end)
    const promises = [1, 2, 3].map((sequence) =>
      streamManager.startStream({
        workspaceId,
        messages: [{ role: "user", content: `test ${sequence}` }],
        model,
        modelString: KNOWN_MODELS.SONNET.id,
        historySequence: sequence,
        system: "system",
        runtime,
        messageId: `test-msg-${sequence}`,
        tools: {},
      })
    );

    // Wait for all to complete (they will fail due to dummy API key, but that's ok)
    await Promise.allSettled(promises);

    // Verify operations are serialized: each ensure-start should be followed by its ensure-end
    // before the next ensure-start
    const ensureOperations = operations.filter((op) => op.startsWith("ensure"));
    for (let i = 0; i < ensureOperations.length - 1; i += 2) {
      expect(ensureOperations[i]).toBe("ensure-start");
      expect(ensureOperations[i + 1]).toBe("ensure-end");
    }
  });

  test("should honor abortSignal before atomic stream creation", async () => {
    const workspaceId = "test-workspace-abort-before-create";

    let createCalled = false;
    let processCalled = false;
    let streamStartEmitted = false;

    onTurnEngineEvent(streamManager, "stream-start", () => {
      streamStartEmitted = true;
    });

    const abortController = new AbortController();

    let tempDirStartedResolve: (() => void) | undefined;
    const tempDirStarted = new Promise<void>((resolve) => {
      tempDirStartedResolve = resolve;
    });

    let cleanupCalled = false;
    streamManager.createTempDirForStream = (): Promise<string> => {
      tempDirStartedResolve?.();
      return new Promise((resolve) => {
        abortController.signal.addEventListener("abort", () => resolve("/tmp/mock-stream-temp"), {
          once: true,
        });
      });
    };
    engineInternals(streamManager).cleanupStreamTempDir = (): void => {
      cleanupCalled = true;
    };
    engineInternals(streamManager).createStreamAtomically = (): never => {
      createCalled = true;
      throw new Error("createStreamAtomically should not be called");
    };
    engineInternals(streamManager).processStreamWithCleanup = (): Promise<void> => {
      processCalled = true;
      return Promise.resolve();
    };

    const startPromise = streamManager.startStream(
      testStartOptions({
        workspaceId,
        messageId: "test-msg-abort",
        model: createTestLanguageModel(),
        runtime,
        abortSignal: abortController.signal,
        tools: {},
      })
    );

    await tempDirStarted;
    abortController.abort();

    const result = await startPromise;
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected aborted startup handle");
    expect(await result.data.completion).toMatchObject({
      status: "aborted",
      abortReason: "startup",
    });
    expect(createCalled).toBe(false);
    expect(cleanupCalled).toBe(true);
    expect(processCalled).toBe(false);
    expect(streamStartEmitted).toBe(false);
    expect(streamManager.isStreaming(workspaceId)).toBe(false);
  });
});

describe("StreamManager - stopStream", () => {
  test("aborts a pending startup with its reserved identity", async () => {
    const events: TurnEngineEvent[] = [];
    const streamManager = new StreamManager(historyService, undefined, undefined, (event) => {
      events.push(event);
    });
    const startup = streamManager.beginStreamStart({
      workspaceId: "pending-workspace",
      acpPromptId: "prompt-1",
    });

    const result = await streamManager.stopStream("pending-workspace", {
      abandonPartial: true,
      abortReason: "user",
    });
    startup.finish();

    expect(result.success).toBe(true);
    expect(startup.abortSignal.aborted).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "stream-abort",
      workspaceId: "pending-workspace",
      messageId: startup.syntheticMessageId,
      abortReason: "user",
      abandonPartial: true,
      acpPromptId: "prompt-1",
    });
  });

  test("routes mock lifecycle operations through the engine", async () => {
    const streamManager = new StreamManager(historyService);
    const stop = mock(() => Promise.resolve());
    const replayStream = mock(() => Promise.resolve());
    streamManager.setMockStreamLifecycle({
      isStreaming: (workspaceId) => workspaceId === "mock-workspace",
      stop,
      replayStream,
    });

    expect(streamManager.isStreaming("mock-workspace")).toBe(true);
    expect((await streamManager.stopStream("mock-workspace")).success).toBe(true);
    await streamManager.replayStream("mock-workspace", { afterTimestamp: 10 });

    expect(stop).toHaveBeenCalledWith("mock-workspace", undefined);
    expect(replayStream).toHaveBeenCalledWith("mock-workspace");
  });

  test("emits stream-abort when stopping non-existent stream", async () => {
    const streamManager = new StreamManager(historyService);

    // Track emitted events
    const abortEvents: Array<{ workspaceId: string; messageId: string }> = [];
    onTurnEngineEvent(
      streamManager,
      "stream-abort",
      (data: { workspaceId: string; messageId: string }) => {
        abortEvents.push(data);
      }
    );

    // Stop a stream that doesn't exist (simulates interrupt before stream-start)
    const result = await streamManager.stopStream("test-workspace");

    expect(result.success).toBe(true);
    expect(abortEvents).toHaveLength(1);
    expect(abortEvents[0].workspaceId).toBe("test-workspace");
    // messageId is empty for synthetic abort (no actual stream existed)
    expect(abortEvents[0].messageId).toBe("");
  });
});
