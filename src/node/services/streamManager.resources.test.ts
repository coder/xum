import { describe, test, expect, afterEach, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { createMuxMessage } from "@/common/types/message";
import { StreamManager, type TurnEngineEvent } from "./streamManager";
import * as aiSdk from "ai";
import { type LanguageModel } from "ai";
import { HistoryService } from "./historyService";
import { CompactionCancellation } from "./compactionCancellation";
import { makeTestEffectRunner } from "./di/testEffectRunner";
import { DisposableTempDir } from "@/node/services/tempDir";
import type { ExecOptions, ExecStream, Runtime } from "@/node/runtime/Runtime";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { attachLanguageModelCleanup } from "./languageModelCleanup";
import { shellQuote } from "@/common/utils/shell";
import {
  createStreamManagerForTests,
  engineInternals,
  fakeStreamText,
} from "./streamManager.testHarness";
import type { EffectRunner } from "./di/effectRunner";
import {
  installStreamManagerTestHistory,
  historyService,
  historyConfig,
  createTestLanguageModel,
  LOCAL_TEST_RUNTIME,
  testStartOptions,
  appendPartialAssistantForTests,
  createStreamResultForTests,
  createStreamInfoForTests,
} from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

function createExecStreamForTests(): ExecStream {
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    stdin: new WritableStream<Uint8Array>({
      write(_chunk) {
        return Promise.resolve();
      },
      close() {
        return Promise.resolve();
      },
    }),
    exitCode: Promise.resolve(0),
    duration: Promise.resolve(0),
  };
}

interface RecordedExecCall {
  command: string;
  options: ExecOptions;
}

/** The local test runtime with exec recorded instead of run (temp-dir cleanup uses exec). */
function createExecRecordingRuntimeForTests(): { runtime: Runtime; execCalls: RecordedExecCall[] } {
  const execCalls: RecordedExecCall[] = [];
  const runtime = Object.create(LOCAL_TEST_RUNTIME) as Runtime;
  runtime.exec = (command: string, options: ExecOptions) => {
    execCalls.push({ command, options });
    return Promise.resolve(createExecStreamForTests());
  };
  return { runtime, execCalls };
}

describe("StreamManager - createTempDirForStream", () => {
  test("creates ~/.xum-tmp/<token> under the runtime's home", async () => {
    using home = new DisposableTempDir("stream-home");

    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;

    process.env.HOME = home.path;
    process.env.USERPROFILE = home.path;

    try {
      const streamManager = new StreamManager(historyService);
      const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });

      const token = streamManager.generateStreamToken();
      const resolved = await streamManager.createTempDirForStream(token, runtime);

      // StreamManager normalizes Windows paths to forward slashes.
      const normalizedHomePath = home.path.replace(/\\/g, "/");
      expect(resolved.startsWith(normalizedHomePath)).toBe(true);
      expect(resolved).toContain(`/.xum-tmp/${token}`);

      const stat = await fs.stat(resolved);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }

      if (prevUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = prevUserProfile;
      }
    }
  });
});

describe("StreamManager - cleanupStreamTempDir", () => {
  test("quotes temp-dir basename in rm -rf command", async () => {
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: fakeStreamText(() =>
        createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            yield { type: "finish", finishReason: "stop" };
          })()
        )
      ),
    });
    const { runtime, execCalls } = createExecRecordingRuntimeForTests();
    const workspaceId = "temp-dir-quoting-workspace";
    await appendPartialAssistantForTests(workspaceId, "temp-dir-quoting-message", 1);

    // The stream owns this temp dir and removes it when the stream ends.
    const runtimeTempDir = "/tmp/stream-$(echo injected)";
    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId,
        messageId: "temp-dir-quoting-message",
        model: createTestLanguageModel(),
        runtime,
        providedRuntimeTempDir: runtimeTempDir,
      })
    );
    if (!result.success) throw new Error("Expected stream to start");
    await result.data.completion;
    // Let the fire-and-forget scope close settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.command).toBe(`rm -rf ${shellQuote("stream-$(echo injected)")}`);
    expect(execCalls[0]?.options).toMatchObject({ cwd: "/tmp", timeout: 10 });
  });
});

describe("StreamManager - stream resource scope", () => {
  function createLifecycleStreamManagerForTests(fullStreamParts: unknown[]): {
    streamManager: StreamManager;
    execCalls: RecordedExecCall[];
    runtime: Runtime;
  } {
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: fakeStreamText(() =>
        createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            yield* fullStreamParts;
          })()
        )
      ),
    });
    // Temp-dir cleanup is the only runtime exec these fake streams trigger.
    const { runtime, execCalls } = createExecRecordingRuntimeForTests();
    return { streamManager, execCalls, runtime };
  }

  async function runLifecycleStreamForTests(
    streamManager: StreamManager,
    workspaceId: string,
    runtimeOptions: { runtime: Runtime; runtimeTempDir: string } = {
      runtime: LOCAL_TEST_RUNTIME,
      runtimeTempDir: "",
    }
  ): Promise<void> {
    const messageId = `${workspaceId}-msg`;
    await appendPartialAssistantForTests(workspaceId, messageId, 1);

    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId,
        messageId,
        model: createTestLanguageModel(),
        tools: {},
        runtime: runtimeOptions.runtime,
        providedRuntimeTempDir: runtimeOptions.runtimeTempDir,
      })
    );
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected stream to start");
    }
    await result.data.completion;
    // Let the fire-and-forget scope close settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("releases the temp dir exactly once when the stream completes", async () => {
    // The temp-dir release finalizer is owned by the stream's resource scope:
    // ownership transfers from startStream to processStreamWithCleanup at
    // registration, and Scope.close must run the release on natural
    // completion without double-releasing across the two cleanup paths.
    const { streamManager, execCalls, runtime } = createLifecycleStreamManagerForTests([
      { type: "text-delta", text: "hello" },
      { type: "finish", finishReason: "stop" },
    ]);

    await runLifecycleStreamForTests(streamManager, "scope-release-once-workspace", {
      runtime,
      runtimeTempDir: "/tmp/phase10-scope-tempdir",
    });

    expect(execCalls.map((call) => call.command)).toEqual([
      `rm -rf ${shellQuote("phase10-scope-tempdir")}`,
    ]);
  });

  /** Virtual time far past the partial-write throttle window. */
  const PAST_THROTTLE_WINDOW_MS = 60_000;

  /**
   * Streams "first" (written immediately: nothing was written yet), waits until
   * that write stamped the throttle clock, then streams "second" inside the
   * throttle window so it is debounced instead of written. `tail` decides whether
   * the stream then finishes or stays open until it is stopped.
   */
  async function startDebouncedPartialStream(input: {
    workspaceId: string;
    tail: "finish" | "open";
    runner?: EffectRunner;
    aroundSecondDelta?: { before: () => void; after: () => void };
  }) {
    const secondDeltaProcessed = Promise.withResolvers<number>();
    const writePartial = historyService.writePartial.bind(historyService);
    // One resolver per write, settled once that write completed on disk.
    const writesCompleted: Array<{ promise: Promise<void>; resolve: () => void }> = [];
    const writeResolver = (count: number) => {
      while (writesCompleted.length < count) writesCompleted.push(Promise.withResolvers<void>());
      return writesCompleted[count - 1];
    };
    const writeCompleted = (count: number): Promise<void> => writeResolver(count).promise;
    let completedWrites = 0;
    const writePartialSpy = spyOn(historyService, "writePartial").mockImplementation(
      async (...args) => {
        const result = await writePartial(...args);
        completedWrites += 1;
        writeResolver(completedWrites).resolve();
        return result;
      }
    );
    const streamManager = createStreamManagerForTests(historyService, {
      runner: input.runner,
      streamText: fakeStreamText(({ abortSignal }) =>
        createStreamResultForTests(
          (async function* () {
            yield { type: "text-delta", text: "first" };
            await writeCompleted(1);
            // flushPartialWrite stamps the throttle clock in a microtask
            // continuation of that write; one macrotask hop drains it.
            await new Promise((resolve) => setImmediate(resolve));
            input.aroundSecondDelta?.before();
            yield { type: "text-delta", text: "second" };
            // The consumer fully processed "second" before pulling the next part.
            input.aroundSecondDelta?.after();
            secondDeltaProcessed.resolve(writePartialSpy.mock.calls.length);
            if (input.tail === "finish") {
              yield { type: "finish", finishReason: "stop" };
              return;
            }
            await new Promise<void>((resolve) =>
              abortSignal!.addEventListener("abort", () => resolve(), { once: true })
            );
          })()
        )
      ),
    });
    const messageId = `${input.workspaceId}-msg`;
    await appendPartialAssistantForTests(input.workspaceId, messageId, 1);
    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId: input.workspaceId,
        messageId,
        model: createTestLanguageModel(),
        tools: {},
        providedRuntimeTempDir: "",
      })
    );
    if (!result.success) throw new Error("Expected stream to start");
    return {
      streamManager,
      handle: result.data,
      writePartialSpy,
      // Resolves once the count-th partial write completed.
      writeCompleted,
      // Resolves with the partial-write count right after "second" was processed.
      writesAfterSecondDelta: secondDeltaProcessed.promise,
    };
  }

  async function partialText(workspaceId: string): Promise<string | undefined> {
    const partial = await historyService.readPartial(workspaceId);
    return partial?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  test("interrupts a pending debounced partial write when the stream ends", async () => {
    // A debounced partial flush scheduled during streaming is tied to the
    // stream's resource scope. Once the stream ends, the pending flush must be
    // interrupted with the scope — a late write would resurrect partial state
    // for a dead stream. The debounce sleeps on the injected runner's
    // TestClock, so "later" is a virtual-time adjust, not a real wait. The
    // injected-clock test below proves this same setup arms a debounce.
    const testRunner = makeTestEffectRunner();
    try {
      const workspaceId = "scope-debounce-interrupt-workspace";
      const { handle, writePartialSpy, writesAfterSecondDelta } = await startDebouncedPartialStream(
        {
          workspaceId,
          tail: "finish",
          runner: testRunner.runner,
        }
      );

      // "second" was debounced, not written, before the stream finished.
      expect(await writesAfterSecondDelta).toBe(1);
      expect(await handle.completion).toMatchObject({ status: "completed" });
      // Let the fire-and-forget scope close settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const writesAtStreamEnd = writePartialSpy.mock.calls.length;
      await testRunner.adjust(PAST_THROTTLE_WINDOW_MS);
      // A flush that survived the scope close would settle on the next macrotask.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(writePartialSpy.mock.calls.length).toBe(writesAtStreamEnd);
    } finally {
      await testRunner.dispose();
    }
  });

  test("a debounced partial write arms a real setTimeout through the default runner", async () => {
    // Default-runner smoke: with nothing injected the debounce sleeps on
    // Effect's default clock, i.e. a real setTimeout. Intercepting the timers
    // registered while "second" is processed (as the RetryManager smoke does)
    // keeps this deterministic: no wall-clock window that a loaded host could
    // overrun.
    const realSetTimeout = globalThis.setTimeout;
    const timers: Array<{ delayMs: number; fire: () => void }> = [];
    let capturing = false;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (!capturing) return realSetTimeout(handler, timeout, ...args);
      if (typeof handler !== "function") {
        throw new Error("debounce smoke only supports function timer handlers");
      }
      timers.push({ delayMs: timeout ?? 0, fire: handler as () => void });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const workspaceId = "default-runner-debounce-workspace";
    const { streamManager, writePartialSpy, writeCompleted, writesAfterSecondDelta } =
      await startDebouncedPartialStream({
        workspaceId,
        tail: "open",
        aroundSecondDelta: {
          before: () => {
            capturing = true;
          },
          after: () => {
            capturing = false;
          },
        },
      });
    try {
      expect(await writesAfterSecondDelta).toBe(1);
      // Exactly one timer, for the remaining throttle window.
      expect(timers).toHaveLength(1);
      expect(timers[0].delayMs).toBeGreaterThan(0);

      timers[0].fire();
      // The flush's Effect.promise settles asynchronously.
      await writeCompleted(2);
      expect(writePartialSpy).toHaveBeenCalledTimes(2);
      expect(await partialText(workspaceId)).toBe("firstsecond");
    } finally {
      setTimeoutSpy.mockRestore();
      await streamManager.stopStream(workspaceId);
    }
  });

  test("runs the partial-write debounce on the injected runner's clock", async () => {
    // The debounce fiber must sleep on the injected EffectRunner (the app
    // runtime's clock in production), not the global runtime: a TestClock
    // runner fires the flush only when the test clock advances.
    const testRunner = makeTestEffectRunner();
    const workspaceId = "runner-debounce-workspace";
    const { streamManager, writePartialSpy, writeCompleted, writesAfterSecondDelta } =
      await startDebouncedPartialStream({
        workspaceId,
        tail: "open",
        runner: testRunner.runner,
      });
    try {
      expect(streamManager.effectRunner).toBe(testRunner.runner);
      expect(await writesAfterSecondDelta).toBe(1);
      // Real time passes; the virtual clock has not, so nothing flushes. A fixed
      // negative window, not a wait: the adjust below is the positive signal.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(writePartialSpy).toHaveBeenCalledTimes(1);

      await testRunner.adjust(PAST_THROTTLE_WINDOW_MS);
      // The flush's Effect.promise starts the write on the next macrotask, well
      // before a real-clock sleep could have elapsed.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(writePartialSpy).toHaveBeenCalledTimes(2);
      await writeCompleted(2);
      expect(await partialText(workspaceId)).toBe("firstsecond");
    } finally {
      await streamManager.stopStream(workspaceId);
      await testRunner.dispose();
    }
  });
});

describe("StreamManager - language model cleanup", () => {
  afterEach(() => mock.restore());

  const runtime = LOCAL_TEST_RUNTIME;

  function createCleanupModel(modelId: string): {
    model: LanguageModel;
    getCleanupCalls: () => number;
  } {
    let cleanupCalls = 0;
    const model = createTestLanguageModel(modelId);
    attachLanguageModelCleanup(model, () => {
      cleanupCalls += 1;
    });
    return { model, getCleanupCalls: () => cleanupCalls };
  }

  async function processCleanupStream(params: {
    workspaceId: string;
    messageId: string;
    model: LanguageModel;
    fullStream: (abortSignal: AbortSignal) => AsyncGenerator<unknown, void, unknown>;
    usage?: unknown;
    stopWhileStreaming?: boolean;
  }): Promise<void> {
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: fakeStreamText(({ abortSignal }) =>
        createStreamResultForTests(params.fullStream(abortSignal!), params.usage)
      ),
    });
    await appendPartialAssistantForTests(params.workspaceId, params.messageId, 1);

    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId: params.workspaceId,
        messageId: params.messageId,
        model: params.model,
        runtime,
        providedRuntimeTempDir: "",
      })
    );
    if (!result.success) throw new Error("Expected stream to start");
    if (params.stopWhileStreaming) {
      expect((await streamManager.stopStream(params.workspaceId)).success).toBe(true);
    }
    await result.data.completion;
  }

  const cleanupLifecycleCases: Array<{
    name: string;
    modelId: string;
    workspaceId: string;
    messageId: string;
    fullStream: (
      getCleanupCalls: () => number,
      abortSignal: AbortSignal
    ) => AsyncGenerator<unknown, void, unknown>;
    usage?: unknown;
    stopWhileStreaming?: boolean;
  }> = [
    {
      name: "runs model cleanup when stream processing finishes",
      modelId: "cleanup-model",
      workspaceId: "cleanup-workspace",
      messageId: "cleanup-message",
      fullStream: () =>
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "done" };
          yield { type: "finish", finishReason: "stop" };
        })(),
    },
    {
      name: "keeps model cleanup until a multi-step tool stream finishes",
      modelId: "cleanup-multistep-model",
      workspaceId: "cleanup-multistep-workspace",
      messageId: "cleanup-multistep-message",
      fullStream: (getCleanupCalls) =>
        (async function* () {
          await Promise.resolve();
          yield {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "test_tool",
            input: { value: 1 },
          };
          expect(getCleanupCalls()).toBe(0);
          yield {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "test_tool",
            output: { ok: true },
          };
          expect(getCleanupCalls()).toBe(0);
          yield { type: "text-delta", text: "done" };
          expect(getCleanupCalls()).toBe(0);
          yield { type: "finish", finishReason: "stop" };
        })(),
    },
    {
      name: "runs model cleanup when stream processing fails",
      modelId: "cleanup-error-model",
      workspaceId: "cleanup-error-workspace",
      messageId: "cleanup-error-message",
      fullStream: () =>
        (async function* () {
          await Promise.resolve();
          throw new Error("stream failed before output");
          yield* [] as unknown[];
        })(),
      usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
    },
    {
      name: "runs model cleanup when stream processing is aborted",
      modelId: "cleanup-abort-model",
      workspaceId: "cleanup-abort-workspace",
      messageId: "cleanup-abort-message",
      fullStream: (getCleanupCalls, abortSignal) =>
        (async function* () {
          // Still streaming when the stop lands: cleanup must wait for the abort.
          expect(getCleanupCalls()).toBe(0);
          await new Promise<void>((resolve) =>
            abortSignal.addEventListener("abort", () => resolve(), { once: true })
          );
          yield* [];
        })(),
      usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
      stopWhileStreaming: true,
    },
  ];

  for (const cleanupCase of cleanupLifecycleCases) {
    test(cleanupCase.name, async () => {
      const { model, getCleanupCalls } = createCleanupModel(cleanupCase.modelId);

      await processCleanupStream({
        workspaceId: cleanupCase.workspaceId,
        messageId: cleanupCase.messageId,
        model,
        fullStream: (abortSignal) => cleanupCase.fullStream(getCleanupCalls, abortSignal),
        usage: cleanupCase.usage,
        stopWhileStreaming: cleanupCase.stopWhileStreaming,
      });

      expect(getCleanupCalls()).toBe(1);
    });
  }

  test("runs model cleanup when startStream exits before processing after abort", async () => {
    const streamManager = new StreamManager(historyService);
    const { model, getCleanupCalls } = createCleanupModel("cleanup-preabort-model");
    const abortController = new AbortController();
    abortController.abort(new Error("pre-abort"));

    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId: "cleanup-preabort-workspace",
        messageId: "cleanup-preabort-message",
        model,
        abortSignal: abortController.signal,
      })
    );

    expect(result.success).toBe(true);
    expect(getCleanupCalls()).toBe(1);
  });

  test.each([
    "before provider",
    "after check",
    "during envelope",
    "local abort",
    "local envelope abort",
  ] as const)("recorded admission gates startup and releases resources: %s", async (timing) => {
    using tempDir = new DisposableTempDir("admission-stream");
    const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });
    spyOn(runtime, "resolvePath").mockResolvedValue(tempDir.path);
    const workspaceId = `admission-${timing}`;
    const events: unknown[] = [];
    const streamManager = new StreamManager(historyService, undefined, undefined, (event) => {
      if (event.type === "stream-start") events.push(event);
    });
    const { model, getCleanupCalls } = createCleanupModel(workspaceId);
    if (typeof model === "string" || !("doStream" in model))
      throw new Error("Expected provider model");
    const providerEntered = Promise.withResolvers<void>();
    let providerSignal: AbortSignal | undefined;
    const provider = spyOn(model, "doStream").mockImplementation(
      ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        providerSignal = abortSignal;
        providerEntered.resolve();
        return new Promise<never>((_, reject) => {
          if (!abortSignal) return reject(new Error("Expected provider abort signal"));
          const aborted = () =>
            reject(new Error("Provider aborted", { cause: abortSignal.reason }));
          if (abortSignal.aborted) aborted();
          else abortSignal.addEventListener("abort", aborted, { once: true });
        });
      }
    );
    const constructed = spyOn(aiSdk, "streamText");
    const captured = await historyService.captureCompactionReplacement(workspaceId);
    if (!captured.success) throw new Error(captured.error);
    const foreign = new CompactionCancellation(
      new HistoryService(historyConfig).getCompactionCancellationStorage(workspaceId)
    );
    const abort = new AbortController();
    const acquire = streamManager.createTempDirForStream.bind(streamManager);
    spyOn(streamManager, "createTempDirForStream").mockImplementationOnce(async (...args) => {
      const dir = await acquire(...args);
      if (timing === "before provider") await foreign.cancel();
      return dir;
    });
    let checks = 0;
    try {
      const result = await streamManager.startStream(
        testStartOptions({
          workspaceId,
          messageId: "gated-start",
          runtime,
          model,
          abortSignal: abort.signal,
          assertAdmissionCurrent: async () => {
            checks += 1;
            const current = await historyService.captureCompactionReplacement(workspaceId);
            if (!current.success) throw new Error(current.error);
            if (timing === "local abort") abort.abort();
            if (timing === "after check" && checks === 1) await foreign.cancel();
            if (
              current.data.nonce !== captured.data.nonce ||
              current.data.generation !== captured.data.generation
            )
              throw new Error("Recorded admission was superseded");
          },
          withAdmissionCurrent: async (construct) => {
            const result = await historyService.runWithCompactionAdmission(
              workspaceId,
              captured.data,
              construct
            );
            if (!result.success) throw new Error(result.error);
          },
          onStreamConstructed: async () => {
            await providerEntered.promise;
            if (timing === "local envelope abort") abort.abort();
            await foreign.cancel();
          },
        })
      );
      expect(result.success).toBe(timing === "local abort" || timing === "local envelope abort");
      expect(checks).toBe(timing === "during envelope" ? 2 : 1);
      // The first gate prevents streamText itself and the underlying provider call.
      // A Stop during the envelope can only prevent processing of the constructed stream.
      const reachedProvider = timing === "during envelope" || timing === "local envelope abort";
      expect(constructed).toHaveBeenCalledTimes(reachedProvider ? 1 : 0);
      expect(provider).toHaveBeenCalledTimes(reachedProvider ? 1 : 0);
      if (reachedProvider) expect(providerSignal?.aborted).toBe(true);
      expect(events).toHaveLength(0);
      expect(streamManager.getActiveStreams().includes(workspaceId)).toBe(false);
      expect(getCleanupCalls()).toBe(1);
      if (result.success) expect((await result.data.completion).status).toBe("aborted");
    } finally {
      abort.abort();
    }
  });

  test("interrupt during onStreamConstructed skips processing and preserves a replacement registration", async () => {
    const startEvents: unknown[] = [];
    const streamManager = new StreamManager(historyService, undefined, undefined, (event) => {
      if (event.type === "stream-start") startEvents.push(event);
    });
    const { model, getCleanupCalls } = createCleanupModel("constructed-abort-model");

    const workspaceId = "constructed-abort-workspace";
    const replacementSentinel = { replacement: true };
    const onStreamConstructed = async (): Promise<void> => {
      // Hard interrupt racing the awaited envelope write: stopStream aborts
      // the registered STARTING stream, awaits its placeholder
      // processingPromise, and deletes the registration…
      await streamManager.stopStream(workspaceId);
      // …after which a replacement stream can occupy the workspace slot.
      // Kept whitebox: the start lock is held across onStreamConstructed, so no
      // public start can register that replacement here; seed the registry.
      const streams = engineInternals(streamManager).workspaceStreams;
      streams.set(workspaceId, replacementSentinel);
    };

    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId,
        messageId: "constructed-abort-message",
        model,
        onStreamConstructed,
      })
    );

    expect(result.success).toBe(true);
    // The canceled stream must never start processing: stream-start after the
    // abort would leave the UI stuck streaming with no abort/end to follow.
    expect(startEvents).toHaveLength(0);
    // The replacement registration survives (the canceled stream's cleanup
    // must not delete another stream's slot).
    const streams = engineInternals(streamManager).workspaceStreams;
    expect(streams.get(workspaceId)).toBe(replacementSentinel);
    // The never-processed stream's model still gets cleaned up.
    expect(getCleanupCalls()).toBe(1);
  });

  test("returning the startup envelope cannot bypass a held abort fence or emit a second startup abort", async () => {
    const workspaceId = "envelope-abort-fence";
    const events: TurnEngineEvent[] = [];
    const streamManager = new StreamManager(historyService, undefined, undefined, (event) => {
      events.push(event);
    });
    const envelopeEntered = Promise.withResolvers<void>();
    const envelopeRelease = Promise.withResolvers<void>();
    const commitEntered = Promise.withResolvers<void>();
    const commitRelease = Promise.withResolvers<void>();
    const originalCommit = historyService.commitPartial.bind(historyService);
    spyOn(historyService, "commitPartial").mockImplementationOnce(async (...args) => {
      commitEntered.resolve();
      await commitRelease.promise;
      return originalCommit(...args);
    });
    const pending = streamManager.beginStreamStart({ workspaceId });
    const started = streamManager.startStream(
      testStartOptions({
        workspaceId,
        messageId: "constructed-fence",
        model: createTestLanguageModel(),
        abortSignal: pending.abortSignal,
        onStreamConstructed: async () => {
          envelopeEntered.resolve();
          await envelopeRelease.promise;
        },
      })
    );
    await envelopeEntered.promise;
    const stop = streamManager.stopStream(workspaceId, { abortReason: "user" });
    await commitEntered.promise;
    const secondStop = streamManager.stopStream(workspaceId, { abortReason: "system" });
    let returned = false;
    const observedStart = started.then(() => {
      returned = true;
    });
    try {
      envelopeRelease.resolve();
      await envelopeRelease.promise;
      await Promise.resolve();
      expect(events.filter((event) => event.type === "stream-abort")).toHaveLength(0);
      expect(streamManager.getStreamInfo(workspaceId, true)?.messageId).toBe("constructed-fence");
      expect(returned).toBe(false);
      commitRelease.resolve();
      await Promise.all([stop, secondStop]);
      const result = await started;
      await observedStart;
      if (!result.success) throw new Error("Expected aborted handle");
      expect(await result.data.completion).toMatchObject({
        status: "aborted",
        abortReason: "user",
      });
      expect(events.filter((event) => event.type === "stream-abort")).toHaveLength(1);
    } finally {
      envelopeRelease.resolve();
      commitRelease.resolve();
      pending.finish();
      await Promise.all([started, stop, secondStop]);
    }
  });

  test("throwing startup envelope cleanup preserves a replacement registration", async () => {
    const workspaceId = "throwing-envelope-replacement";
    const streamManager = new StreamManager(historyService);
    // Kept whitebox: the start lock is held across onStreamConstructed, so no
    // public start can register the replacement; seed the registry directly.
    const streams = engineInternals(streamManager).workspaceStreams;
    const replacement = createStreamInfoForTests({ messageId: "replacement" });
    const { model, getCleanupCalls } = createCleanupModel("throwing-envelope");
    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId,
        messageId: "old",
        model,
        onStreamConstructed: async () => {
          await streamManager.stopStream(workspaceId);
          streams.set(workspaceId, replacement);
          throw new Error("envelope failure");
        },
      })
    );
    expect(result.success).toBe(false);
    expect(streams.get(workspaceId)).toBe(replacement);
    expect(getCleanupCalls()).toBe(1);
  });

  test.each(["factory", "fence release"] as const)(
    "runs model cleanup when %s throws before processing",
    async (failure) => {
      const streamManager = createStreamManagerForTests(historyService, {
        streamText:
          failure === "factory"
            ? fakeStreamText(() => {
                throw new Error("create stream failed");
              })
            : undefined,
      });
      const { model, getCleanupCalls } = createCleanupModel("cleanup-create-throw-model");

      const workspaceId = "cleanup-create-throw-workspace";
      const captured = await historyService.captureCompactionReplacement(workspaceId);
      if (!captured.success) throw new Error(captured.error);
      const result = await streamManager.startStream(
        testStartOptions({
          workspaceId,
          withAdmissionCurrent: async (construct) => {
            const result = await historyService.runWithCompactionAdmission(
              workspaceId,
              captured.data,
              construct
            );
            if (!result.success) throw new Error(result.error);
            expect(streamManager.getActiveStreams().includes(workspaceId)).toBe(true);
            throw new Error("fence release failed");
          },
          messageId: "cleanup-create-throw-message",
          model,
        })
      );

      expect(result.success).toBe(false);
      expect(getCleanupCalls()).toBe(1);
      expect(streamManager.getActiveStreams().includes(workspaceId)).toBe(false);
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            createMuxMessage("after-error", "user", "retry")
          )
        ).success
      ).toBe(true);
    }
  );
});
