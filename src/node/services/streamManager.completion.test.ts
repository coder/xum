import { describe, test, expect, mock } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { StreamEndEventSchema } from "@/common/orpc/schemas/stream";
import { Ok, Err } from "@/common/types/result";
import {
  StreamManager,
  type ModelFallbackPrepareOptions,
  type TurnExecutionOptions,
} from "./streamManager";
import type { SessionUsageService } from "./sessionUsageService";
import { countTokens } from "@/node/utils/main/tokenizer";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { attachLanguageModelCleanup } from "./languageModelCleanup";
import {
  createStreamManagerForTests,
  engineInternals,
  fakeStreamText,
  onTurnEngineEvent,
} from "./streamManager.testHarness";
import {
  installStreamManagerTestHistory,
  historyService,
  createTestLanguageModel,
  appendPartialAssistantForTests,
  createStreamResultForTests,
  createStreamInfoForTests,
  testStartOptions,
} from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

type StreamResultFactoryForTests = () => Record<string, unknown>;

/**
 * Injected streamText: the first call returns the turn's own stream; later
 * calls (the internal empty-output retry, refusal-fallback hops) go to `next`.
 */
function turnStreamTextForTests(
  turnStream: StreamResultFactoryForTests,
  next: (options: Parameters<Parameters<typeof fakeStreamText>[0]>[0]) => unknown = () => {
    throw new Error("Unexpected extra streamText call");
  }
) {
  let turnStarted = false;
  return fakeStreamText((options) => {
    if (turnStarted) return next(options);
    turnStarted = true;
    return turnStream();
  });
}

/**
 * Runs one turn through the public startStream boundary on an Anthropic model
 * string and waits for its terminal outcome. The caller appends the partial.
 */
async function runTurnForTests(
  streamManager: StreamManager,
  options: Partial<TurnExecutionOptions> &
    Pick<TurnExecutionOptions, "workspaceId" | "messageId" | "historySequence">
) {
  const result = await streamManager.startStream(
    testStartOptions({
      model: createTestLanguageModel(),
      modelString: KNOWN_MODELS.SONNET.id,
      initialMetadata: { agentId: "plan" },
      providedRuntimeTempDir: "",
      ...options,
    })
  );
  if (!result.success) throw new Error(`Expected stream to start: ${JSON.stringify(result.error)}`);
  return result.data.completion;
}

describe("StreamManager - exact step indices", () => {
  test("persists exact tool-only step boundaries through successful completion", async () => {
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: turnStreamTextForTests(() =>
        createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            for (const toolCallId of ["first", "second"]) {
              yield { type: "start-step" };
              // An empty/repeated SDK start must not create duplicate indices.
              yield { type: "start-step" };
              yield { type: "tool-call", toolCallId, toolName: "bash", input: { script: "pwd" } };
              yield { type: "tool-result", toolCallId, toolName: "bash", output: "/tmp" };
              yield {
                type: "finish-step",
                usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
              };
            }
            yield { type: "start-step" };
            yield { type: "finish", finishReason: "stop" };
          })()
        )
      ),
    });
    const workspaceId = "step-indices-workspace";
    const messageId = "step-indices-message";
    await appendPartialAssistantForTests(workspaceId, messageId, 1);
    await runTurnForTests(streamManager, { workspaceId, messageId, historySequence: 1 });
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (!history.success) throw new Error(history.error);
    const committed = history.data.find((row) => row.id === messageId);
    expect(committed?.parts.map((part) => part.type)).toEqual(["dynamic-tool", "dynamic-tool"]);
    // The trailing empty step start is not persisted.
    expect(committed?.metadata?.stepStartPartIndices).toEqual([0, 1]);
  });

  // The preserve-parts reset is proven publicly by errorRecovery's step-boundary
  // previousResponseId retry, which commits stepStartPartIndices [0, 1].
  test("retry reset discards step indices together with discarded parts", async () => {
    const streamManager = new StreamManager(historyService);
    const streamInfo = createStreamInfoForTests({
      parts: [{ type: "text", text: "discarded", timestamp: 1 }],
      stepStartIndices: [0, 1, 3],
    });
    const reset = engineInternals(streamManager).resetStreamStateForRetry;
    await reset.call(streamManager, "step-reset-workspace", streamInfo, { preserveParts: false });
    expect(streamInfo.stepStartIndices).toEqual([0]);
    expect(streamInfo.currentStepStartIndex).toBe(0);
    const buildPartial = engineInternals(streamManager).buildPartialAssistantMessage;
    const partial = buildPartial.call(streamManager, streamInfo);
    expect(partial.metadata?.stepStartPartIndices).toEqual([]);
    await historyService.writePartial("step-reset-workspace", partial);
    expect(
      (await historyService.readPartial("step-reset-workspace"))?.metadata?.stepStartPartIndices
    ).toEqual([]);
  });
});

describe("StreamManager - empty stream completions", () => {
  const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });

  test("retries one empty stream internally before persisting a retryable empty-output error", async () => {
    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          // Retry path also returns no output so the empty-output error still surfaces.
        })(),
        emptyUsage
      )
    );
    // The turn's own stream settles one step with usage but no visible output: the
    // silent placeholder case we saw in debug logs. Its usage must survive the retry.
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield {
            type: "finish-step",
            usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 },
            providerMetadata: { openai: { cached_tokens: 2 } },
          };
        })(),
        emptyUsage
      );
    const recordHeadlessUsage = mock(
      (
        _workspaceId: string,
        _model: string,
        _usage: unknown,
        _providerMetadata: unknown,
        _options: unknown
      ) => Promise.resolve(undefined)
    );
    const sessionUsageService = {
      recordUsage: mock(() => Promise.resolve(undefined)),
      recordHeadlessUsage,
    } as unknown as SessionUsageService;
    const streamManager = createStreamManagerForTests(historyService, {
      sessionUsageService,
      streamText: turnStreamTextForTests(turnStream, createStreamResult),
    });
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data);
    });

    const workspaceId = "empty-output-workspace";
    const messageId = "empty-output-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const emptyUsage = { inputTokens: 3, outputTokens: 0, totalTokens: 3 };

    await runTurnForTests(streamManager, { workspaceId, messageId, historySequence });

    expect(createStreamResult).toHaveBeenCalledTimes(1);
    expect(streamEndEvents).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      messageId,
      errorType: "empty_output",
    });
    expect(errorEvents[0]?.error).toContain("before producing any assistant-visible output");

    // The retry reset kept the first attempt's usage and provider metadata: the
    // errored turn routes exactly that to the headless sidecar.
    expect(recordHeadlessUsage).toHaveBeenCalledTimes(1);
    expect(recordHeadlessUsage.mock.calls[0]?.[2]).toMatchObject({
      inputTokens: 7,
      outputTokens: 0,
      totalTokens: 7,
    });
    expect(recordHeadlessUsage.mock.calls[0]?.[3]).toEqual({ openai: { cached_tokens: 2 } });
    expect(recordHeadlessUsage.mock.calls[0]?.[4]).toMatchObject({
      analyticsSource: "errored_stream",
    });

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("empty_output");
    expect(partial?.metadata?.error).toContain("before producing any assistant-visible output");
    expect(partial?.metadata?.metadataModel).toBe(KNOWN_MODELS.SONNET.id);
    expect(partial?.parts).toEqual([]);
    // Errored turns are sidecar-canonical: usage is deliberately NOT stamped
    // on the error partial (it routes to headless-usage.jsonl, covered by
    // dedicated sidecar tests) so a later commit cannot double-count.
    expect(partial?.metadata?.usage).toBeUndefined();
    expect(partial?.metadata?.providerMetadata).toEqual({ openai: { cached_tokens: 2 } });
  });

  test("persists retryable partial error when a non-empty stream closes before finish", async () => {
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "partial answer" };
        })(),
        { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
      );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: turnStreamTextForTests(turnStream),
    });
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data);
    });

    const workspaceId = "truncated-stream-workspace";
    const messageId = "truncated-stream-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);

    await runTurnForTests(streamManager, { workspaceId, messageId, historySequence });

    expect(streamEndEvents).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      messageId,
      errorType: "stream_truncated",
    });
    expect(errorEvents[0]?.error).toContain(
      "Anthropic stream closed unexpectedly before the response completed"
    );

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("stream_truncated");
    expect(partial?.metadata?.error).toContain(
      "Anthropic stream closed unexpectedly before the response completed"
    );
    expect(partial?.metadata?.metadataModel).toBe(KNOWN_MODELS.SONNET.id);
    expect(partial?.parts).toMatchObject([{ type: "text", text: "partial answer" }]);
  });

  test("treats streamText's synthesized (other, undefined) finish part as a truncated stream", async () => {
    // streamText's runStep initializes stepFinishReason="other" /
    // stepRawFinishReason=undefined and unconditionally emits those from its
    // flush() at end-of-stream. The OpenAI Responses, Chat Completions, and
    // Anthropic Messages adapters all surface this shape when the upstream
    // SSE stream closed before any terminal event arrived. StreamManager
    // must treat that synthesized default as a missing terminal event so the
    // existing truncation guard fires a retryable `stream_truncated` error
    // rather than committing the partial output as a clean assistant
    // message.
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "partial answer" };
          // The provider adapter never emitted its own finish (e.g. clean
          // SSE EOF before response.completed / message_stop). The ai
          // package's flush() synthesizes this one:
          yield { type: "finish", finishReason: "other", rawFinishReason: undefined };
        })(),
        { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
      );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: turnStreamTextForTests(turnStream),
    });
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data);
    });

    const workspaceId = "synthesized-finish-workspace";
    const messageId = "synthesized-finish-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);

    await runTurnForTests(streamManager, { workspaceId, messageId, historySequence });

    expect(streamEndEvents).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      messageId,
      errorType: "stream_truncated",
    });

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("stream_truncated");
    expect(partial?.parts).toMatchObject([{ type: "text", text: "partial answer" }]);
  });

  test("treats real (other, <raw>) finish parts as a clean completion", async () => {
    // The synthesized-default discriminator must NOT swallow legitimate
    // `"other"` finishes. Both OpenAI and Anthropic map a few real stop
    // reasons to `unified: "other"`, but always with a defined raw value
    // (e.g. Anthropic's `"compaction"`). This test guards against the
    // discriminator widening into a false positive that would mis-fire the
    // truncation guard on a clean stream.
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "complete answer" };
          // Real Anthropic compaction finish (or any other mapped-to-other
          // stop reason) carries a defined raw value.
          yield { type: "finish", finishReason: "other", rawFinishReason: "compaction" };
        })(),
        { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
      );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: turnStreamTextForTests(turnStream),
    });
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data);
    });

    const workspaceId = "real-other-finish-workspace";
    const messageId = "real-other-finish-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);

    await runTurnForTests(streamManager, { workspaceId, messageId, historySequence });

    expect(errorEvents).toHaveLength(0);
    expect(streamEndEvents).toHaveLength(1);
  });

  test("classifies zero-output refusal finish as terminal model_refusal without empty-stream retry", async () => {
    // The AI SDK's Anthropic adapter maps stop_reason "refusal" to the unified
    // finish reason "content-filter" with rawFinishReason "refusal" (pinned
    // against @ai-sdk/anthropic 3.0.82). A refusal with zero output is a
    // deliberate terminal outcome: it must NOT take the empty-output recovery
    // path (in-stream retry + retryable empty_output), which previously looped
    // auto-retries on the same refusal forever.
    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          // Would refuse again; must never be called.
        })()
      )
    );
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 }
      );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: turnStreamTextForTests(turnStream, createStreamResult),
    });
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data);
    });

    const workspaceId = "refusal-workspace";
    const messageId = "refusal-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);

    // Guard that no empty-stream recovery attempt re-creates the stream.

    await runTurnForTests(streamManager, { workspaceId, messageId, historySequence });

    expect(createStreamResult).not.toHaveBeenCalled();
    expect(streamEndEvents).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      messageId,
      errorType: "model_refusal",
    });
    expect(errorEvents[0]?.error).toContain("refused to continue");

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("model_refusal");
    expect(partial?.metadata?.finishReason).toBe("content-filter");
    // Sidecar-canonical: refusal usage routes to headless-usage.jsonl, so the
    // partial (and its eventual commit) must not carry usage.
    expect(partial?.metadata?.usage).toBeUndefined();

    const commitResult = await historyService.commitPartial(workspaceId);
    expect(commitResult.success).toBe(true);
    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(historyResult.error);
    }
    const committed = historyResult.data.find((message) => message.id === messageId);
    expect(committed?.parts).toEqual([]);
    expect(committed?.metadata?.error).toBeUndefined();
    expect(committed?.metadata?.errorType).toBeUndefined();
    expect(committed?.metadata?.finishReason).toBe("content-filter");
    expect(committed?.metadata?.usage).toBeUndefined();
  });

  test("zero-output refusal finishReason survives commit when usage is unavailable", async () => {
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: turnStreamTextForTests(turnStream),
    });

    const workspaceId = "refusal-no-usage-workspace";
    const messageId = "refusal-no-usage-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);

    await runTurnForTests(streamManager, { workspaceId, messageId, historySequence });

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("model_refusal");
    expect(partial?.metadata?.finishReason).toBe("content-filter");
    expect(partial?.metadata?.usage).toBeUndefined();

    const commitResult = await historyService.commitPartial(workspaceId);
    expect(commitResult.success).toBe(true);
    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(historyResult.error);
    }
    const committed = historyResult.data.find((message) => message.id === messageId);
    expect(committed?.parts).toEqual([]);
    expect(committed?.metadata?.finishReason).toBe("content-filter");
    expect(committed?.metadata?.usage).toBeUndefined();
    expect(committed?.metadata?.error).toBeUndefined();
    expect(committed?.metadata?.errorType).toBeUndefined();
  });

  test("zero-usage terminal refusal reaches the sidecar as refused_stream without touching the session ledger", async () => {
    const recordUsage = mock((_workspaceId: string, _model: string, _usage: unknown) =>
      Promise.resolve(undefined)
    );
    const recordHeadlessUsage = mock(
      (
        _workspaceId: string,
        _model: string,
        _usage: unknown,
        _providerMetadata: unknown,
        _options: unknown
      ) => Promise.resolve(undefined)
    );
    const sessionUsageService = {
      recordUsage,
      recordHeadlessUsage,
    } as unknown as SessionUsageService;
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      );
    const streamManager = createStreamManagerForTests(historyService, {
      sessionUsageService,
      streamText: turnStreamTextForTests(turnStream),
    });

    const workspaceId = "refusal-zero-usage-sidecar-workspace";
    const messageId = "refusal-zero-usage-sidecar-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);

    await runTurnForTests(streamManager, { workspaceId, messageId, historySequence });

    // A refusal the provider billed nothing for is still a refusal: exactly
    // one refused_stream analytics record with explicit zero usage…
    expect(recordHeadlessUsage).toHaveBeenCalledTimes(1);
    expect(recordHeadlessUsage.mock.calls[0]?.[0]).toBe(workspaceId);
    expect(recordHeadlessUsage.mock.calls[0]?.[2]).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(recordHeadlessUsage.mock.calls[0]?.[4]).toMatchObject({
      analyticsSource: "refused_stream",
      skipSessionLedger: true,
    });
    // …and no zero-cost noise in the session cost ledger.
    expect(recordUsage).not.toHaveBeenCalled();
  });

  test("refusal finish after partial output fails visibly when no fallback is configured", async () => {
    const recordUsage = mock((_workspaceId: string, _model: string, _usage: unknown) =>
      Promise.resolve(undefined)
    );
    const recordHeadlessUsage = mock(
      (
        _workspaceId: string,
        _model: string,
        _usage: unknown,
        _providerMetadata: unknown,
        _options: unknown
      ) => Promise.resolve(undefined)
    );
    const sessionUsageService = {
      recordUsage,
      recordHeadlessUsage,
    } as unknown as SessionUsageService;
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "partial answer before refusing" };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
      );
    const streamManager = createStreamManagerForTests(historyService, {
      sessionUsageService,
      streamText: turnStreamTextForTests(turnStream),
    });
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data);
    });

    const workspaceId = "refusal-partial-workspace";
    const messageId = "refusal-partial-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);

    await runTurnForTests(streamManager, { workspaceId, messageId, historySequence });

    expect(streamEndEvents).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({ messageId, errorType: "model_refusal" });

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("model_refusal");
    expect(partial?.parts).toHaveLength(1);
    const preservedPart = partial?.parts[0];
    expect(preservedPart?.type).toBe("text");
    if (preservedPart?.type === "text") {
      expect(preservedPart.text).toBe("partial answer before refusing");
      expect(typeof preservedPart.timestamp).toBe("number");
    }
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]?.[0]).toBe(workspaceId);
    expect(recordUsage.mock.calls[0]?.[1]).toBe(KNOWN_MODELS.SONNET.id);
    expect(partial?.metadata?.finishReason).toBe("content-filter");
    // Sidecar-canonical: the billed refusal usage routes to the headless
    // sidecar (asserted via recordHeadlessUsage below), never the partial.
    expect(partial?.metadata?.usage).toBeUndefined();
    expect(recordHeadlessUsage).toHaveBeenCalledTimes(1);
    expect(recordHeadlessUsage.mock.calls[0]?.[0]).toBe(workspaceId);
    expect(recordHeadlessUsage.mock.calls[0]?.[2]).toMatchObject({ inputTokens: 3 });
    // Terminal refusals are labeled refused_stream (not errored_stream) so
    // analytics can distinguish refusals from generic stream errors.
    expect(recordHeadlessUsage.mock.calls[0]?.[4]).toMatchObject({
      analyticsSource: "refused_stream",
      skipSessionLedger: true,
    });

    const commitResult = await historyService.commitPartial(workspaceId);
    expect(commitResult.success).toBe(true);
    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(historyResult.error);
    }
    const committed = historyResult.data.find((message) => message.id === messageId);
    expect(committed?.metadata?.error).toBeUndefined();
    expect(committed?.metadata?.errorType).toBeUndefined();
    expect(committed?.metadata?.finishReason).toBe("content-filter");
    expect(committed?.metadata?.usage).toBeUndefined();
  });

  test("zero-output refusal with a configured fallback chain swaps models without any error event", async () => {
    const createStreamResult = mock(
      (_options: { tools?: Record<string, unknown>; system?: unknown }) =>
        createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            yield { type: "text-delta", text: "fallback answer" };
            yield { type: "finish", finishReason: "stop" };
          })(),
          { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
        )
    );
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          // finish-step carries the refused attempt's usage (mirrors the SDK,
          // which emits per-step usage even for zero-output refusals).
          yield {
            type: "finish-step",
            usage: { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 }
      );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: turnStreamTextForTests(turnStream, createStreamResult),
    });
    const errorEvents: unknown[] = [];
    const streamEndEvents: Array<{
      metadata?: {
        model?: string;
        modelFallback?: { requestedModel: string; refusedModels: string[] };
        autoModelRouting?: { tierId?: string; model: string; thinkingLevel?: string };
        toolModelUsages?: Array<{
          toolName: string;
          model: string;
          usage?: { inputTokens?: number };
        }>;
      };
    }> = [];

    onTurnEngineEvent(streamManager, "error", (data) => errorEvents.push(data));
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data as (typeof streamEndEvents)[number]);
    });

    const workspaceId = "fallback-swap-workspace";
    const messageId = "fallback-swap-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);

    // The swapped-in stream: the fallback model answers normally.

    // Cleanup spies prove neither model's transport resources leak: the refused
    // model is released at swap time, the fallback model at stream exit.
    const refusedModelCleanup = mock(() => undefined);
    const fallbackModelCleanup = mock(() => undefined);
    const fallbackLanguageModel = createTestLanguageModel("fallback-model");
    attachLanguageModelCleanup(fallbackLanguageModel, fallbackModelCleanup);

    // Marker toolset proving the swapped request uses the tools rebuilt for the
    // fallback model (provider-specific web tools / MCP sanitization), not the
    // refused model's toolset.
    const fallbackTools = {
      fallback_only_tool: tool({ description: "rebuilt for fallback", inputSchema: z.object({}) }),
    };
    const prepare = mock((nextModelString: string, _options?: ModelFallbackPrepareOptions) =>
      Promise.resolve(
        Ok({
          model: fallbackLanguageModel,
          modelString: nextModelString,
          messages: [],
          system: "fallback system",
          tools: fallbackTools,
          thinkingLevel: "off",
        })
      )
    );

    const refusedLanguageModel = createTestLanguageModel("refused-model");
    attachLanguageModelCleanup(refusedLanguageModel, refusedModelCleanup);

    await runTurnForTests(streamManager, {
      workspaceId,
      messageId,
      historySequence,
      initialMetadata: {
        agentId: "plan",
        // An Auto-routed turn: the record must follow the swap to the model that answered
        // and to the thinking level the fallback preparation clamped the tier's level to.
        autoModelRouting: {
          status: "routed",
          tierId: "hard",
          model: KNOWN_MODELS.SONNET.id,
          thinkingLevel: "high",
          requestedFallbackModel: "anthropic:claude-3-5-haiku-latest",
        },
      },
      model: refusedLanguageModel,
      modelFallback: { chain: [fallbackModel], prepare },
    });

    // No terminal failure: TaskService and waiters never observe the refusal.
    expect(errorEvents).toHaveLength(0);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toBe(fallbackModel);
    expect(prepare.mock.calls[0]?.[1]).toBeUndefined();
    expect(createStreamResult).toHaveBeenCalledTimes(1);

    expect(streamEndEvents).toHaveLength(1);
    const metadata = streamEndEvents[0]?.metadata;
    expect(metadata?.model).toBe(fallbackModel);
    expect(metadata?.modelFallback).toEqual({
      requestedModel: KNOWN_MODELS.SONNET.id,
      refusedModels: [KNOWN_MODELS.SONNET.id],
    });
    expect(metadata?.autoModelRouting).toMatchObject({
      tierId: "hard",
      model: fallbackModel,
      thinkingLevel: "off",
    });
    // Pin the IPC passthrough: the oRPC schema strips unknown metadata keys, so
    // modelFallback must survive StreamEndEventSchema or the live transcript
    // never learns about the swap.
    const ipcEvent = StreamEndEventSchema.parse(streamEndEvents[0]);
    expect(ipcEvent.metadata.historySequence).toBe(historySequence);
    expect(ipcEvent.metadata.modelFallback).toEqual({
      requestedModel: KNOWN_MODELS.SONNET.id,
      refusedModels: [KNOWN_MODELS.SONNET.id],
    });
    // The refused attempt's usage is attributed to the refusing model, not the
    // fallback model that ultimately answered.
    expect(metadata?.toolModelUsages?.[0]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: KNOWN_MODELS.SONNET.id,
      usage: { inputTokens: 30000 },
    });
    // Both models' transport resources were released exactly once: the refused
    // model at swap time (the stream-exit finally only sees the final request),
    // the fallback model at stream exit.
    expect(refusedModelCleanup).toHaveBeenCalledTimes(1);
    expect(fallbackModelCleanup).toHaveBeenCalledTimes(1);
    // The swapped request was built from the prepared per-model pieces (tools
    // may be re-wrapped for caching, so assert contents rather than identity).
    const swappedRequest = createStreamResult.mock.calls[0]?.[0] ?? {};
    expect(Object.keys(swappedRequest.tools ?? {})).toEqual(Object.keys(fallbackTools));
    expect(swappedRequest.system).toBe("fallback system");
  });

  test("partial refusal with a configured fallback continues from cloned partial output", async () => {
    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "fallback continuation" };
          yield { type: "finish", finishReason: "stop" };
        })(),
        { inputTokens: 7, outputTokens: 4, totalTokens: 11 }
      )
    );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: fakeStreamText(createStreamResult),
    });
    const errorEvents: unknown[] = [];
    const streamEndEvents: Array<{
      metadata?: {
        model?: string;
        modelFallback?: { requestedModel: string; refusedModels: string[] };
        toolModelUsages?: Array<{
          toolName: string;
          model: string;
          usage?: { inputTokens?: number; outputTokens?: number };
        }>;
      };
      parts?: Array<{ type: string; text?: string; toolName?: string }>;
    }> = [];

    onTurnEngineEvent(streamManager, "error", (data) => errorEvents.push(data));
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data as (typeof streamEndEvents)[number]);
    });

    const workspaceId = "fallback-partial-workspace";
    const messageId = "fallback-partial-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = engineInternals(streamManager).processStreamWithCleanup;

    const prepareCalls: Array<{
      nextModelString: string;
      options?: ModelFallbackPrepareOptions;
    }> = [];
    const fallbackLanguageModel = createTestLanguageModel("fallback-partial-model");
    const prepare = mock((nextModelString: string, options?: ModelFallbackPrepareOptions) => {
      prepareCalls.push({ nextModelString, options });
      return Promise.resolve(
        Ok({
          model: fallbackLanguageModel,
          modelString: nextModelString,
          messages: [],
          system: "fallback system",
          tools: {},
          thinkingLevel: "off",
        })
      );
    });

    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "partial answer" };
          yield {
            type: "tool-call",
            toolCallId: "tool-call-1",
            toolName: "bash",
            input: { script: "printf ok" },
          };
          yield {
            type: "tool-result",
            toolCallId: "tool-call-1",
            toolName: "bash",
            output: { success: true, output: "ok" },
          };
          yield {
            type: "finish-step",
            usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 12, outputTokens: 5, totalTokens: 17 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
      stepTracker: {
        latestMessages: [{ role: "user", content: "stale source-step transcript" }],
      },
      modelFallback: {
        options: { chain: [fallbackModel], prepare },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(errorEvents).toHaveLength(0);
    expect((streamInfo.stepTracker as { latestMessages?: unknown }).latestMessages).toBeUndefined();
    expect(prepareCalls).toHaveLength(1);
    expect(prepareCalls[0]?.nextModelString).toBe(fallbackModel);

    const continuationMessage = prepareCalls[0]?.options?.continuation?.assistantMessage;
    expect(continuationMessage?.metadata?.partial).toBe(true);
    expect(continuationMessage?.metadata?.finishReason).toBe("content-filter");
    expect(continuationMessage?.parts.map((part) => part.type)).toEqual(["text", "dynamic-tool"]);
    expect(continuationMessage?.parts).not.toBe(streamInfo.parts);

    expect(streamEndEvents).toHaveLength(1);
    const streamEnd = streamEndEvents[0];
    expect(streamEnd?.metadata?.model).toBe(fallbackModel);
    expect(streamEnd?.metadata?.modelFallback).toEqual({
      requestedModel: KNOWN_MODELS.SONNET.id,
      refusedModels: [KNOWN_MODELS.SONNET.id],
    });
    expect(streamEnd?.metadata?.toolModelUsages?.[0]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: KNOWN_MODELS.SONNET.id,
      usage: { inputTokens: 12, outputTokens: 5 },
    });
    expect(
      streamEnd?.parts?.map((part) => (part.type === "text" ? part.text : part.toolName))
    ).toEqual(["partial answer", "bash", "fallback continuation"]);
  });

  test("partial refusal backfills refused-hop reasoning usage before fallback swap", async () => {
    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "fallback answer" };
          yield { type: "finish", finishReason: "stop" };
        })(),
        { inputTokens: 7, outputTokens: 4, totalTokens: 11 }
      )
    );
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "reasoning-delta", text: refusedReasoning };
          yield { type: "text-delta", text: "partial answer" };
          yield {
            type: "finish-step",
            usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 12, outputTokens: 5, totalTokens: 17 }
      );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: turnStreamTextForTests(turnStream, createStreamResult),
    });
    const errorEvents: unknown[] = [];
    const streamEndEvents: Array<{
      metadata?: {
        usage?: { reasoningTokens?: number };
        toolModelUsages?: Array<{
          model: string;
          usage?: { reasoningTokens?: number };
        }>;
      };
    }> = [];

    onTurnEngineEvent(streamManager, "error", (data) => errorEvents.push(data));
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data as (typeof streamEndEvents)[number]);
    });

    const workspaceId = "fallback-reasoning-refusal-workspace";
    const messageId = "fallback-reasoning-refusal-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;
    const refusedReasoning = "Reasoning before refusal";
    const expectedReasoningTokens = await countTokens(KNOWN_MODELS.SONNET.id, refusedReasoning);

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);

    const prepare = mock((nextModelString: string, _options?: ModelFallbackPrepareOptions) =>
      Promise.resolve(
        Ok({
          model: createTestLanguageModel("fallback-reasoning-refusal-model"),
          modelString: nextModelString,
          messages: [],
          system: "fallback system",
          tools: {},
          thinkingLevel: "off",
        })
      )
    );

    await runTurnForTests(streamManager, {
      workspaceId,
      messageId,
      historySequence,
      modelFallback: { chain: [fallbackModel], prepare },
    });

    expect(errorEvents).toHaveLength(0);
    expect(streamEndEvents).toHaveLength(1);
    const metadata = streamEndEvents[0]?.metadata;
    expect(metadata?.toolModelUsages?.[0]).toMatchObject({
      model: KNOWN_MODELS.SONNET.id,
      usage: { reasoningTokens: expectedReasoningTokens },
    });
    expect(metadata?.usage?.reasoningTokens).toBeUndefined();
  });

  test("partial refusal skips fallback when a tool call is still incomplete", async () => {
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield {
            type: "tool-call",
            toolCallId: "tool-call-1",
            toolName: "bash",
            input: { script: "printf ok" },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 12, outputTokens: 1, totalTokens: 13 }
      );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: turnStreamTextForTests(turnStream),
    });
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => streamEndEvents.push(data));

    const workspaceId = "fallback-incomplete-tool-workspace";
    const messageId = "fallback-incomplete-tool-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;
    const prepare = mock((_nextModelString: string) =>
      Promise.resolve(
        Ok({
          model: createTestLanguageModel("fallback-incomplete-tool"),
          modelString: fallbackModel,
          messages: [],
          system: "fallback system",
          tools: {},
        })
      )
    );

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);

    await runTurnForTests(streamManager, {
      workspaceId,
      messageId,
      historySequence,
      modelFallback: { chain: [fallbackModel], prepare },
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(streamEndEvents).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({ messageId, errorType: "model_refusal" });
    expect(errorEvents[0]?.error).toContain("incomplete tool call");
  });

  test("multi-hop fallback chain walks entries in order and attributes usage per refusing model", async () => {
    const createStreamResult = mock()
      .mockImplementationOnce(() =>
        createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            yield {
              type: "finish-step",
              usage: { inputTokens: 2000, outputTokens: 0, totalTokens: 2000 },
            };
            yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
          })(),
          { inputTokens: 2000, outputTokens: 0, totalTokens: 2000 }
        )
      )
      .mockImplementationOnce(() =>
        createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            yield { type: "text-delta", text: "second fallback answer" };
            yield { type: "finish", finishReason: "stop" };
          })(),
          { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
        )
      );
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield {
            type: "finish-step",
            usage: { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 }
      );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: turnStreamTextForTests(turnStream, createStreamResult),
    });
    const errorEvents: unknown[] = [];
    const streamEndEvents: Array<{
      metadata?: {
        model?: string;
        usage?: { inputTokens?: number; outputTokens?: number };
        modelFallback?: { requestedModel: string; refusedModels: string[] };
        toolModelUsages?: Array<{
          toolName: string;
          model: string;
          usage?: { inputTokens?: number };
        }>;
      };
    }> = [];

    onTurnEngineEvent(streamManager, "error", (data) => errorEvents.push(data));
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data as (typeof streamEndEvents)[number]);
    });

    const workspaceId = "fallback-multihop-workspace";
    const messageId = "fallback-multihop-message";
    const historySequence = 1;
    const firstFallbackModel = KNOWN_MODELS.GPT.id;
    const secondFallbackModel = KNOWN_MODELS.GEMINI_FLASH.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);

    // First swapped-in stream refuses too; the second answers.

    const prepare = mock((nextModelString: string, _options?: ModelFallbackPrepareOptions) =>
      Promise.resolve(
        Ok({
          model: createTestLanguageModel(`fallback-${nextModelString}`),
          modelString: nextModelString,
          messages: [],
          system: "fallback system",
          tools: undefined,
        })
      )
    );

    await runTurnForTests(streamManager, {
      workspaceId,
      messageId,
      historySequence,
      modelFallback: { chain: [firstFallbackModel, secondFallbackModel], prepare },
    });

    expect(errorEvents).toHaveLength(0);
    // Chain entries are attempted in configured order, one attempt each.
    expect(prepare.mock.calls.map((call) => call[0])).toEqual([
      firstFallbackModel,
      secondFallbackModel,
    ]);
    expect(prepare.mock.calls.map((call) => call[1])).toEqual([undefined, undefined]);
    expect(createStreamResult).toHaveBeenCalledTimes(2);

    expect(streamEndEvents).toHaveLength(1);
    const metadata = streamEndEvents[0]?.metadata;
    expect(metadata?.model).toBe(secondFallbackModel);
    // refusedModels accumulates every refusing hop, in order.
    expect(metadata?.modelFallback).toEqual({
      requestedModel: KNOWN_MODELS.SONNET.id,
      refusedModels: [KNOWN_MODELS.SONNET.id, firstFallbackModel],
    });
    // One usage row per refusing hop, attributed to the model that refused.
    expect(metadata?.toolModelUsages).toHaveLength(2);
    expect(metadata?.toolModelUsages?.[0]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: KNOWN_MODELS.SONNET.id,
      usage: { inputTokens: 30000 },
    });
    expect(metadata?.toolModelUsages?.[1]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: firstFallbackModel,
      usage: { inputTokens: 2000 },
    });
    // Final turn usage reflects only the answering attempt (refused attempts
    // live in their toolModelUsages rows, not the headline usage).
    expect(metadata?.usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
  });

  test("multi-hop fallback continues preserved partial output when a later hop refuses", async () => {
    const createStreamResult = mock()
      .mockImplementationOnce(() =>
        createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            yield {
              type: "finish-step",
              usage: { inputTokens: 20, outputTokens: 0, totalTokens: 20 },
            };
            yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
          })(),
          { inputTokens: 20, outputTokens: 0, totalTokens: 20 }
        )
      )
      .mockImplementationOnce(() =>
        createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            yield { type: "text-delta", text: "second fallback answer" };
            yield { type: "finish", finishReason: "stop" };
          })(),
          { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
        )
      );
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "partial answer" };
          yield {
            type: "tool-call",
            toolCallId: "tool-call-1",
            toolName: "bash",
            input: { script: "printf ok" },
          };
          yield {
            type: "tool-result",
            toolCallId: "tool-call-1",
            toolName: "bash",
            output: { success: true, output: "ok" },
          };
          yield {
            type: "finish-step",
            usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 12, outputTokens: 5, totalTokens: 17 }
      );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: turnStreamTextForTests(turnStream, createStreamResult),
    });
    const errorEvents: unknown[] = [];
    const streamEndEvents: Array<{
      metadata?: {
        model?: string;
        usage?: { inputTokens?: number; outputTokens?: number };
        modelFallback?: { requestedModel: string; refusedModels: string[] };
        toolModelUsages?: Array<{
          toolName: string;
          model: string;
          usage?: { inputTokens?: number; outputTokens?: number };
        }>;
      };
      parts?: Array<{ type: string; text?: string; toolName?: string }>;
    }> = [];

    onTurnEngineEvent(streamManager, "error", (data) => errorEvents.push(data));
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data as (typeof streamEndEvents)[number]);
    });

    const workspaceId = "fallback-multihop-partial-workspace";
    const messageId = "fallback-multihop-partial-message";
    const historySequence = 1;
    const firstFallbackModel = KNOWN_MODELS.GPT.id;
    const secondFallbackModel = KNOWN_MODELS.GEMINI_FLASH.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);

    const prepareCalls: Array<{
      nextModelString: string;
      options?: ModelFallbackPrepareOptions;
    }> = [];
    const prepare = mock((nextModelString: string, options?: ModelFallbackPrepareOptions) => {
      prepareCalls.push({ nextModelString, options });
      return Promise.resolve(
        Ok({
          model: createTestLanguageModel(`fallback-${nextModelString}`),
          modelString: nextModelString,
          messages: [],
          system: "fallback system",
          tools: {},
        })
      );
    });

    await runTurnForTests(streamManager, {
      workspaceId,
      messageId,
      historySequence,
      modelFallback: { chain: [firstFallbackModel, secondFallbackModel], prepare },
    });

    expect(errorEvents).toHaveLength(0);
    expect(prepareCalls.map((call) => call.nextModelString)).toEqual([
      firstFallbackModel,
      secondFallbackModel,
    ]);
    const firstContinuation = prepareCalls[0]?.options?.continuation?.assistantMessage;
    const secondContinuation = prepareCalls[1]?.options?.continuation?.assistantMessage;
    expect(firstContinuation?.metadata?.model).toBe(KNOWN_MODELS.SONNET.id);
    expect(secondContinuation?.metadata?.model).toBe(firstFallbackModel);
    expect(firstContinuation?.parts.map((part) => part.type)).toEqual(["text", "dynamic-tool"]);
    expect(secondContinuation?.parts.map((part) => part.type)).toEqual(["text", "dynamic-tool"]);

    expect(streamEndEvents).toHaveLength(1);
    const streamEnd = streamEndEvents[0];
    expect(streamEnd?.metadata?.model).toBe(secondFallbackModel);
    expect(streamEnd?.metadata?.modelFallback).toEqual({
      requestedModel: KNOWN_MODELS.SONNET.id,
      refusedModels: [KNOWN_MODELS.SONNET.id, firstFallbackModel],
    });
    expect(streamEnd?.metadata?.toolModelUsages).toHaveLength(2);
    expect(streamEnd?.metadata?.toolModelUsages?.[0]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: KNOWN_MODELS.SONNET.id,
      usage: { inputTokens: 12, outputTokens: 5 },
    });
    expect(streamEnd?.metadata?.toolModelUsages?.[1]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: firstFallbackModel,
      usage: { inputTokens: 20, outputTokens: 0 },
    });
    expect(streamEnd?.metadata?.usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
    expect(
      streamEnd?.parts?.map((part) => (part.type === "text" ? part.text : part.toolName))
    ).toEqual(["partial answer", "bash", "second fallback answer"]);
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (!history.success) throw new Error(history.error);
    expect(
      history.data.find((row) => row.id === messageId)?.metadata?.stepStartPartIndices
    ).toEqual([0, 2]);
  });

  test("refusal fallback chain exhaustion fails terminally as model_refusal", async () => {
    const recordHeadlessUsage = mock(
      (
        _workspaceId: string,
        _model: string,
        _usage: unknown,
        _providerMetadata: unknown,
        _options: unknown
      ) => Promise.resolve(undefined)
    );
    const sessionUsageService = {
      recordUsage: mock(() => Promise.resolve(undefined)),
      recordHeadlessUsage,
    } as unknown as SessionUsageService;
    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield {
            type: "finish-step",
            usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 10, outputTokens: 0, totalTokens: 10 }
      )
    );
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield {
            type: "finish-step",
            usage: { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 }
      );
    const streamManager = createStreamManagerForTests(historyService, {
      sessionUsageService,
      streamText: turnStreamTextForTests(turnStream, createStreamResult),
    });
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => streamEndEvents.push(data));

    const workspaceId = "fallback-exhausted-workspace";
    const messageId = "fallback-exhausted-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);

    // The fallback model refuses too — the chain is then exhausted.

    const prepare = mock((nextModelString: string) =>
      Promise.resolve(
        Ok({
          model: createTestLanguageModel("fallback-model"),
          modelString: nextModelString,
          messages: [],
          system: "fallback system",
          tools: undefined,
        })
      )
    );

    await runTurnForTests(streamManager, {
      workspaceId,
      messageId,
      historySequence,
      modelFallback: { chain: [fallbackModel], prepare },
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(createStreamResult).toHaveBeenCalledTimes(1);
    expect(streamEndEvents).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({ messageId, errorType: "model_refusal" });
    // The terminal error names the last refusing model and lists the chain.
    expect(errorEvents[0]?.error).toContain(`: ${fallbackModel}.`);
    expect(errorEvents[0]?.error).toContain(
      `Model fallback chain exhausted; refused models: ${KNOWN_MODELS.SONNET.id}, ${fallbackModel}.`
    );

    // Even though the turn failed terminally, every refused hop's usage —
    // including the FINAL refusing model's — is attributed and persisted.
    // Sidecar-canonical: errored turns route usage through the headless
    // sidecar (never the partial), so chains ending in failure don't
    // underreport costs and the eventual commit can't double-count.
    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("model_refusal");
    expect(partial?.metadata?.toolModelUsages).toBeUndefined();
    expect(partial?.metadata?.usage).toBeUndefined();
    const sidecarCalls = recordHeadlessUsage.mock.calls;
    expect(sidecarCalls).toHaveLength(2);
    expect(sidecarCalls[0]?.[1]).toBe(KNOWN_MODELS.SONNET.id);
    expect(sidecarCalls[0]?.[2]).toMatchObject({ inputTokens: 30000 });
    expect(sidecarCalls[1]?.[1]).toBe(fallbackModel);
    expect(sidecarCalls[1]?.[2]).toMatchObject({ inputTokens: 10 });
    for (const call of sidecarCalls) {
      // Both flattened entries are refused fallback hops, so they carry the
      // refusal-specific analytics label rather than the generic drop reason.
      expect(call?.[4]).toMatchObject({
        analyticsSource: "refused_stream",
        skipSessionLedger: true,
      });
    }
  });

  test("unstartable fallback model fails terminally as model_refusal instead of skipping ahead", async () => {
    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          // Must never be called: prepare failure aborts the chain.
        })()
      )
    );
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 }
      );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: turnStreamTextForTests(turnStream, createStreamResult),
    });
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });

    const workspaceId = "fallback-prepare-failure-workspace";
    const messageId = "fallback-prepare-failure-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);

    // Silently skipping to the next chain entry would effectively create
    // fallback-on-auth/config errors, which is out of scope by design.
    const prepare = mock((_nextModelString: string) =>
      Promise.resolve(
        Err("API key not configured for OpenAI. Please add your API key in settings.")
      )
    );

    await runTurnForTests(streamManager, {
      workspaceId,
      messageId,
      historySequence,
      modelFallback: { chain: [fallbackModel], prepare },
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(createStreamResult).not.toHaveBeenCalled();
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({ messageId, errorType: "model_refusal" });
    expect(errorEvents[0]?.error).toContain(
      `Configured fallback model ${fallbackModel} could not be started: API key not configured`
    );

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("model_refusal");
  });

  test("a throwing prepare() fails terminally as model_refusal instead of a retryable error", async () => {
    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          // Must never be called: prepare threw before a request was built.
        })()
      )
    );
    const turnStream = () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 }
      );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: turnStreamTextForTests(turnStream, createStreamResult),
    });
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });

    const workspaceId = "fallback-prepare-throw-workspace";
    const messageId = "fallback-prepare-throw-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);

    // A THROW (not an Err) must not escape into the generic stream-error path,
    // where it would be categorized as a retryable api/unknown error and
    // re-enter the unbounded auto-retry loop refusals exist to prevent.
    const prepare = mock((_nextModelString: string) =>
      Promise.reject(new Error("provider factory exploded"))
    );

    await runTurnForTests(streamManager, {
      workspaceId,
      messageId,
      historySequence,
      modelFallback: { chain: [fallbackModel], prepare },
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(createStreamResult).not.toHaveBeenCalled();
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({ messageId, errorType: "model_refusal" });
    expect(errorEvents[0]?.error).toContain(
      `Configured fallback model ${fallbackModel} could not be started: provider factory exploded`
    );

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("model_refusal");
  });
});
