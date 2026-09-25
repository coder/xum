import { describe, test, expect, mock } from "bun:test";
import { StreamManager } from "./streamManager";
import * as aiSdk from "ai";
import {
  APICallError,
  RetryError,
  StreamProviderError,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createRuntime } from "@/node/runtime/runtimeFactory";
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
  TEST_USAGE,
  appendPartialAssistantForTests,
  createStreamResultForTests,
  createStreamInfoForTests,
} from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

function createApiCallErrorForTests(overrides: {
  message: string;
  statusCode: number;
  responseBody: string;
  isRetryable: boolean;
  data?: unknown;
  url?: string;
}): APICallError {
  return new APICallError({
    message: overrides.message,
    url: overrides.url ?? "https://api.openai.com/v1/responses",
    requestBodyValues: {},
    statusCode: overrides.statusCode,
    responseHeaders: {},
    responseBody: overrides.responseBody,
    isRetryable: overrides.isRetryable,
    ...(overrides.data !== undefined ? { data: overrides.data } : {}),
  });
}

describe("StreamManager - previousResponseId recovery", () => {
  test("isResponseIdLost returns false for unknown IDs", () => {
    const streamManager = new StreamManager(historyService);

    // Verify the ID is not lost initially
    expect(streamManager.isResponseIdLost("resp_123abc")).toBe(false);
    expect(streamManager.isResponseIdLost("resp_different")).toBe(false);
  });

  test("extractPreviousResponseIdFromError extracts ID from various error formats", () => {
    const streamManager = new StreamManager(historyService);

    // Get the private method via reflection
    const extractMethod = engineInternals(streamManager).extractPreviousResponseIdFromError;
    expect(typeof extractMethod).toBe("function");

    // Test extraction from APICallError with responseBody
    const apiError = new APICallError({
      message: "Previous response with id 'resp_abc123' not found.",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      responseBody:
        '{"error":{"message":"Previous response with id \'resp_abc123\' not found.","code":"previous_response_not_found"}}',
      isRetryable: false,
      data: { error: { code: "previous_response_not_found" } },
    });
    expect(extractMethod.call(streamManager, apiError)).toBe("resp_abc123");

    // Test extraction from error message
    const errorWithMessage = new Error("Previous response with id 'resp_def456' not found.");
    expect(extractMethod.call(streamManager, errorWithMessage)).toBe("resp_def456");

    // Test when no ID is present
    const errorWithoutId = new Error("Some other error");
    expect(extractMethod.call(streamManager, errorWithoutId)).toBeUndefined();
  });

  const lostResponseIdCases = [
    {
      name: "explicit OpenAI errors",
      workspaceId: "workspace-1",
      messageId: "msg-1",
      lostId: "resp_deadbeef",
      error: createApiCallErrorForTests({
        message: "Previous response with id 'resp_deadbeef' not found.",
        statusCode: 400,
        responseBody: "Previous response with id 'resp_deadbeef' not found.",
        isRetryable: false,
        data: { error: { code: "previous_response_not_found" } },
      }),
    },
    {
      name: "500 errors referencing previous responses",
      workspaceId: "workspace-2",
      messageId: "msg-2",
      lostId: "resp_cafebabe",
      error: createApiCallErrorForTests({
        message: "Internal error: Previous response with id 'resp_cafebabe' not found.",
        statusCode: 500,
        responseBody: "Internal error: Previous response with id 'resp_cafebabe' not found.",
        isRetryable: false,
        data: { error: { code: "server_error" } },
      }),
    },
  ];

  for (const lostResponseIdCase of lostResponseIdCases) {
    test(`recordLostResponseIdIfApplicable records IDs for ${lostResponseIdCase.name}`, () => {
      const streamManager = new StreamManager(historyService);
      const recordMethod = engineInternals(streamManager).recordLostResponseIdIfApplicable;

      recordMethod.call(streamManager, lostResponseIdCase.workspaceId, lostResponseIdCase.error, {
        messageId: lostResponseIdCase.messageId,
        model: "openai:gpt-mini",
      });

      expect(streamManager.isResponseIdLost(lostResponseIdCase.lostId)).toBe(true);
    });
  }

  test("retryStreamWithoutPreviousResponseId retries at step boundary with existing parts", async () => {
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: fakeStreamText(() => ({
        fullStream: (async function* () {
          await Promise.resolve();
          yield* [];
        })(),
        totalUsage: Promise.resolve(undefined),
        usage: Promise.resolve(undefined),
        providerMetadata: Promise.resolve(undefined),
        steps: Promise.resolve([]),
      })),
    });

    const retryMethod = engineInternals(streamManager).retryStreamWithoutPreviousResponseId;

    const model = createAnthropic({ apiKey: "test" })("claude-sonnet-4-5");
    const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });
    const stepMessages: ModelMessage[] = [{ role: "user", content: "next step" }];

    const streamInfo = {
      state: "streaming",
      streamResult: {},
      abortController: new AbortController(),
      messageId: "msg-1",
      token: "token",
      startTime: Date.now(),
      model: "mux-gateway:openai/gpt-5.2-codex",
      historySequence: 1,
      stepTracker: { latestMessages: stepMessages },
      didRetryPreviousResponseIdAtStep: false,
      currentStepStartIndex: 1,
      stepStartIndices: [0, 1, 2],
      request: {
        model,
        messages: [{ role: "user", content: "original" }],
        system: "system",
        providerOptions: { openai: { previousResponseId: "resp_abc123" } },
      },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-1",
          toolName: "test",
          state: "output-available",
          input: {},
          output: {},
        },
      ],
      lastPartialWriteTime: 0,
      processingPromise: Promise.resolve(),
      softInterrupt: { pending: false },
      runtimeTempDir: "/tmp",
      runtime,
      cumulativeUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      cumulativeProviderMetadata: { openai: {} },
    };

    const apiError = createApiCallErrorForTests({
      message: "Previous response with id 'resp_abc123' not found.",
      statusCode: 400,
      responseBody: "Previous response with id 'resp_abc123' not found.",
      isRetryable: false,
      data: { error: { code: "previous_response_not_found" } },
    });

    const retried = await retryMethod.call(streamManager, "ws-step", streamInfo, apiError, false);
    expect(retried).toBe(true);
    expect(streamInfo.parts).toHaveLength(1);
    expect(streamInfo.didRetryPreviousResponseIdAtStep).toBe(true);
    expect(streamInfo.stepStartIndices).toEqual([0, 1]);
    expect(streamInfo.request.messages as ModelMessage[]).toBe(stepMessages);

    const openaiOptions = streamInfo.request.providerOptions as {
      openai?: Record<string, unknown>;
    };
    expect(openaiOptions.openai?.previousResponseId).toBeUndefined();
  });

  const totalUsageCases: Array<{
    name: string;
    streamInfo: Record<string, unknown>;
    totalUsage: Record<string, number> | undefined;
    expected: Record<string, number>;
  }> = [
    {
      name: "falls back to cumulative usage when stream total is missing",
      streamInfo: {
        didRetryPreviousResponseIdAtStep: false,
        cumulativeUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      },
      // getStreamMetadata's totalUsage read can time out (slow SDK settlement)
      // even though the provider billed the turn.
      totalUsage: undefined,
      expected: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    },
    {
      name: "falls back to cumulative usage when stream total has zero tokens",
      streamInfo: {
        didRetryPreviousResponseIdAtStep: false,
        cumulativeUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      },
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      expected: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    },
    {
      name: "prefers cumulative usage after step retry",
      streamInfo: {
        didRetryPreviousResponseIdAtStep: true,
        cumulativeUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      },
      totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      expected: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    },
    {
      name: "prefers cumulative usage after empty-output retry",
      streamInfo: {
        didRetryPreviousResponseIdAtStep: false,
        didRetryAfterEmptyOutput: true,
        cumulativeUsage: { inputTokens: 6, outputTokens: 5, totalTokens: 11 },
      },
      totalUsage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
      expected: { inputTokens: 6, outputTokens: 5, totalTokens: 11 },
    },
    {
      name: "prefers cumulative usage after a reasoning-replay step retry",
      streamInfo: {
        didRetryPreviousResponseIdAtStep: false,
        didRetryReasoningReplayAtStep: true,
        cumulativeUsage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      },
      totalUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      expected: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    },
    {
      name: "treats non-zero fields as valid usage",
      streamInfo: {
        didRetryPreviousResponseIdAtStep: true,
        cumulativeUsage: { inputTokens: 4, outputTokens: 1, totalTokens: 0 },
      },
      totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      expected: { inputTokens: 4, outputTokens: 1, totalTokens: 0 },
    },
    {
      name: "keeps stream total without step retry",
      streamInfo: {
        didRetryPreviousResponseIdAtStep: false,
        cumulativeUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      },
      totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      expected: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    },
  ];

  for (const usageCase of totalUsageCases) {
    test(`resolveTotalUsageForStreamEnd ${usageCase.name}`, () => {
      const streamManager = new StreamManager(historyService);
      const resolveMethod = engineInternals(streamManager).resolveTotalUsageForStreamEnd;

      expect(resolveMethod.call(streamManager, usageCase.streamInfo, usageCase.totalUsage)).toEqual(
        usageCase.expected
      );
    });
  }
});

describe("StreamManager - OpenAI reasoning replay recovery", () => {
  const openAIReasoningReplayRejections = [
    {
      name: "rs_ item not found",
      // Gateways can drop the structured code: the message alone must match.
      error: createApiCallErrorForTests({
        message:
          "Item with id 'rs_0d8a3f9c2b1e4a7d' not found. Items are not persisted when `store` is set to false. Try again with `store` set to true, or remove this item from your input.",
        statusCode: 400,
        responseBody:
          '{"error":{"message":"Item with id \'rs_0d8a3f9c2b1e4a7d\' not found. Items are not persisted when `store` is set to false. Try again with `store` set to true, or remove this item from your input.","type":"invalid_request_error","param":"input","code":null}}',
        isRetryable: false,
        data: { error: { type: "invalid_request_error", param: "input", code: null } },
      }),
    },
    {
      name: "invalid_encrypted_content",
      error: createApiCallErrorForTests({
        message:
          "The encrypted content for item rs_09beb6f8c1d2e3f4 could not be verified. Reason: Encrypted content organization_id did not match the target organization.",
        statusCode: 400,
        responseBody:
          '{"error":{"message":"The encrypted content for item rs_09beb6f8c1d2e3f4 could not be verified. Reason: Encrypted content organization_id did not match the target organization.","type":"invalid_request_error","code":"invalid_encrypted_content"}}',
        isRetryable: false,
        data: { error: { type: "invalid_request_error", code: "invalid_encrypted_content" } },
      }),
    },
    {
      name: "streamed rs_ item not found",
      error: new StreamProviderError({
        message: "Item with id 'rs_stream' not found.",
        statusCode: 500,
        data: { type: "error", code: null },
      }),
    },
  ];

  const openAIResponsesModel = createTestLanguageModel("gpt-5.2-codex", "openai.responses");

  const openaiReasoningPart = {
    type: "reasoning" as const,
    text: "stale thinking",
    providerOptions: { openai: { reasoningEncryptedContent: "gAAA-stale" } },
  };
  const requestMessagesWithReplay = (): ModelMessage[] => [
    { role: "user", content: "earlier" },
    { role: "assistant", content: [openaiReasoningPart, { type: "text", text: "earlier answer" }] },
    { role: "user", content: "now" },
  ];
  const repairedRequestMessages: ModelMessage[] = [
    { role: "user", content: "earlier" },
    { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
    { role: "user", content: "now" },
  ];

  async function* failingStream(error: unknown) {
    await Promise.resolve();
    yield { type: "error", error };
  }

  async function* successfulStream() {
    await Promise.resolve();
    yield { type: "start-step" };
    yield { type: "text-delta", text: "repaired answer" };
    yield { type: "finish-step", usage: TEST_USAGE };
    yield { type: "finish", finishReason: "stop" };
  }

  function createRecoveryHarness(workspaceId: string) {
    // Each run() installs a fresh retry-stream factory so callers can count its calls.
    let createStreamResult = mock((): unknown => undefined);
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: fakeStreamText(() => createStreamResult()),
    });
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];
    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => streamEndEvents.push(data));
    const processStreamWithCleanup = engineInternals(streamManager).processStreamWithCleanup;
    const run = async (
      streamInfo: Record<string, unknown>,
      nextStreams: Array<() => AsyncGenerator<unknown, void, unknown>>
    ) => {
      createStreamResult = mock(() => {
        const next = nextStreams.shift();
        expect(next).toBeDefined();
        return createStreamResultForTests(next!());
      });
      const historySequence = streamInfo.historySequence as number;
      await appendPartialAssistantForTests(
        workspaceId,
        streamInfo.messageId as string,
        historySequence
      );
      await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);
      return createStreamResult;
    };
    return { streamManager, errorEvents, streamEndEvents, run };
  }

  function replayStreamInfo(
    firstStream: AsyncGenerator<unknown, void, unknown>,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return createStreamInfoForTests({
      messageId: `replay-${Math.random().toString(36).slice(2, 8)}`,
      streamResult: createStreamResultForTests(firstStream),
      model: "openai:gpt-5.2-codex",
      metadataModel: "openai:gpt-5.2-codex",
      request: {
        model: openAIResponsesModel,
        messages: requestMessagesWithReplay(),
        providerOptions: undefined,
      },
      ...overrides,
    });
  }

  for (const rejection of openAIReasoningReplayRejections) {
    test(`repairs ${rejection.name} once without surfacing an intermediate error`, async () => {
      const { errorEvents, streamEndEvents, run } = createRecoveryHarness("replay-repair");
      const streamInfo = replayStreamInfo(failingStream(rejection.error));

      const createStreamResult = await run(streamInfo, [successfulStream]);

      expect(createStreamResult).toHaveBeenCalledTimes(1);
      expect((streamInfo.request as { messages: ModelMessage[] }).messages).toEqual(
        repairedRequestMessages
      );
      expect(errorEvents).toEqual([]);
      expect(streamEndEvents).toHaveLength(1);
    });

    test(`repairs ${rejection.name} from the prepared first-step transcript`, async () => {
      const { errorEvents, streamEndEvents, run } = createRecoveryHarness("replay-prepared-first");
      // prepareStep can replace the initial transcript before any output exists.
      // Recovery must not restore the context discarded by that preparation.
      const preparedMessages: ModelMessage[] = [
        { role: "user", content: "compacted summary" },
        {
          role: "assistant",
          content: [openaiReasoningPart, { type: "text", text: "retained answer" }],
        },
        { role: "user", content: "now" },
      ];
      const streamInfo = replayStreamInfo(failingStream(rejection.error), {
        stepTracker: { latestMessages: preparedMessages },
      });
      expect(streamInfo.parts).toEqual([]);

      const createStreamResult = await run(streamInfo, [successfulStream]);

      expect(createStreamResult).toHaveBeenCalledTimes(1);
      expect((streamInfo.request as { messages: ModelMessage[] }).messages).toEqual([
        { role: "user", content: "compacted summary" },
        { role: "assistant", content: [{ type: "text", text: "retained answer" }] },
        { role: "user", content: "now" },
      ]);
      expect(errorEvents).toEqual([]);
      expect(streamEndEvents).toHaveLength(1);
    });

    test(`surfaces a repeated ${rejection.name} as terminal reasoning_rejected after one repair`, async () => {
      const workspaceId = "replay-repeat";
      const { errorEvents, streamEndEvents, run } = createRecoveryHarness(workspaceId);
      const streamInfo = replayStreamInfo(failingStream(rejection.error));

      const createStreamResult = await run(streamInfo, [() => failingStream(rejection.error)]);

      expect(createStreamResult).toHaveBeenCalledTimes(1);
      expect(streamEndEvents).toHaveLength(0);
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({
        messageId: streamInfo.messageId,
        errorType: "reasoning_rejected",
      });
      expect((await historyService.readPartial(workspaceId))?.metadata?.errorType).toBe(
        "reasoning_rejected"
      );

      // The one-shot budget is per stream attempt, not persisted: a manual
      // continuation on the same workspace gets its own repair.
      const retry = replayStreamInfo(failingStream(rejection.error), { historySequence: 2 });
      const retryCreateStreamResult = await run(retry, [successfulStream]);
      expect(retryCreateStreamResult).toHaveBeenCalledTimes(1);
      expect(errorEvents).toHaveLength(1);
      expect(streamEndEvents).toHaveLength(1);
    });
  }

  for (const { code, maxRetries } of [
    { code: null, maxRetries: 0 },
    { code: null, maxRetries: 1 },
    { code: "invalid_encrypted_content", maxRetries: 0 },
  ]) {
    test(`repairs SDK-decoded streamed reasoning rejection (${code ?? "rs_ not found"}, SDK retries ${maxRetries}) only once`, async () => {
      // The WebSocket adapter returns HTTP 200 and forwards error frames as SSE.
      // Exercise the real SDK decoder: a null code gets a synthetic 500 status.
      const event = {
        type: "error",
        sequence_number: 0,
        code,
        message: code
          ? "The encrypted content could not be verified."
          : "Item with id 'rs_stream' not found.",
        param: null,
      };
      const result = aiSdk.streamText({
        model: createOpenAI({
          apiKey: "test-key",
          fetch: Object.assign(
            () =>
              Promise.resolve(
                new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
                  headers: { "content-type": "text/event-stream" },
                })
              ),
            { preconnect: fetch.preconnect.bind(fetch) }
          ),
        }).responses("gpt-5.2"),
        prompt: "continue",
        maxRetries,
      });
      const errors: unknown[] = [];
      for await (const part of result.fullStream) {
        if (part.type === "error") errors.push(part.error);
      }
      expect(errors).toHaveLength(1);
      expect(RetryError.isInstance(errors[0])).toBe(maxRetries > 0);
      const apiError = RetryError.isInstance(errors[0]) ? errors[0].lastError : errors[0];
      expect(APICallError.isInstance(apiError)).toBe(true);
      expect(apiError).toMatchObject({ statusCode: code ? 400 : 500 });

      const { errorEvents, streamEndEvents, run } = createRecoveryHarness("replay-streamed");
      const repaired = await run(replayStreamInfo(failingStream(errors[0])), [successfulStream]);
      expect(repaired).toHaveBeenCalledTimes(1);
      expect(errorEvents).toEqual([]);
      expect(streamEndEvents).toHaveLength(1);

      const repeated = await run(
        replayStreamInfo(failingStream(errors[0]), { historySequence: 2 }),
        [() => failingStream(errors[0])]
      );
      expect(repeated).toHaveBeenCalledTimes(1);
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({ errorType: "reasoning_rejected" });
      expect(streamEndEvents).toHaveLength(1);
    });
  }

  for (const [statusCode, errorType] of [
    [503, "server_error"],
    [401, "authentication"],
    [429, "rate_limit"],
  ] as const) {
    test(`a later ${statusCode} after the repair keeps its ordinary classification`, async () => {
      const { errorEvents, run } = createRecoveryHarness(`replay-then-${statusCode}`);
      const laterError = createApiCallErrorForTests({
        message: "The next request failed",
        statusCode,
        responseBody: '{"error":{"message":"The next request failed"}}',
        isRetryable: statusCode !== 401,
      });
      const streamInfo = replayStreamInfo(failingStream(openAIReasoningReplayRejections[1].error));

      const createStreamResult = await run(streamInfo, [() => failingStream(laterError)]);

      expect(createStreamResult).toHaveBeenCalledTimes(1);
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({ errorType });
    });
  }

  test("step-boundary repair keeps prior-step parts and usage and replays the stripped step messages", async () => {
    const createStreamResult = mock(() => createStreamResultForTests(successfulStream()));
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: fakeStreamText(createStreamResult),
    });
    const retryMethod = engineInternals(streamManager).retryStreamWithoutOpenAIReasoningReplay;

    const toolCall = {
      type: "tool-call" as const,
      toolCallId: "call-1",
      toolName: "bash",
      input: { script: "pwd" },
    };
    const toolResult: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "bash",
          output: { type: "text", value: "/tmp" },
        },
      ],
    };
    // What the SDK prepared for the failing step: same-turn reasoning carries
    // itemId + encrypted content copied from providerMetadata.
    const stepMessages: ModelMessage[] = [
      ...requestMessagesWithReplay(),
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "step thinking",
            providerOptions: { openai: { itemId: "rs_step", reasoningEncryptedContent: "gAAA-1" } },
          },
          toolCall,
        ],
      },
      toolResult,
    ];
    const priorParts = [
      {
        type: "dynamic-tool",
        toolCallId: "call-1",
        toolName: "bash",
        state: "output-available",
        input: { script: "pwd" },
        output: "/tmp",
      },
    ];
    const cumulativeUsage = { inputTokens: 40, outputTokens: 9, totalTokens: 49 };
    const streamInfo = replayStreamInfo(failingStream(undefined), {
      parts: priorParts,
      currentStepStartIndex: 1,
      stepStartIndices: [0, 1],
      stepTracker: { latestMessages: stepMessages },
      cumulativeUsage,
    });

    const retried = await retryMethod.call(
      streamManager,
      "replay-step",
      streamInfo,
      openAIReasoningReplayRejections[0].error,
      false
    );

    expect(retried).toBe(true);
    expect(streamInfo.parts).toBe(priorParts);
    expect(streamInfo.cumulativeUsage).toEqual(cumulativeUsage);
    expect(streamInfo.didRetryReasoningReplayAtStep).toBe(true);
    expect(streamInfo.stepStartIndices).toEqual([0, 1]);
    expect(createStreamResult).toHaveBeenCalledTimes(1);
    expect((streamInfo.request as { messages: ModelMessage[] }).messages).toEqual([
      ...repairedRequestMessages,
      { role: "assistant", content: [toolCall] },
      toolResult,
    ]);
  });

  const unsafeRepairCases: Array<{
    name: string;
    overrides: Record<string, unknown>;
    prepare?: (streamInfo: Record<string, unknown>) => void;
  }> = [
    {
      name: "aborted stream",
      overrides: {},
      prepare: (streamInfo) => (streamInfo.abortController as AbortController).abort(),
    },
    { name: "pending soft interrupt", overrides: { softInterrupt: { pending: true } } },
    {
      name: "current step already emitted parts",
      overrides: {
        parts: [{ type: "text", text: "partial", timestamp: 1 }],
        currentStepStartIndex: 0,
        stepStartIndices: [0],
        stepTracker: { latestMessages: requestMessagesWithReplay() },
      },
    },
    {
      name: "missing step snapshot after a completed step",
      overrides: {
        parts: [{ type: "text", text: "step one", timestamp: 1 }],
        currentStepStartIndex: 1,
        stepStartIndices: [0, 1],
        stepTracker: {},
      },
    },
    {
      name: "nothing to strip",
      overrides: {
        request: {
          model: openAIResponsesModel,
          messages: repairedRequestMessages,
          providerOptions: undefined,
        },
      },
    },
  ];

  for (const unsafeCase of unsafeRepairCases) {
    test(`does not replay when ${unsafeCase.name}`, async () => {
      const createStreamResult = mock(() => createStreamResultForTests(successfulStream()));
      const streamManager = createStreamManagerForTests(historyService, {
        streamText: fakeStreamText(createStreamResult),
      });
      const retryMethod = engineInternals(streamManager).retryStreamWithoutOpenAIReasoningReplay;
      const streamInfo = replayStreamInfo(failingStream(undefined), unsafeCase.overrides);
      unsafeCase.prepare?.(streamInfo);
      const originalMessages = (streamInfo.request as { messages: ModelMessage[] }).messages;

      const retried = await retryMethod.call(
        streamManager,
        "replay-unsafe",
        streamInfo,
        openAIReasoningReplayRejections[1].error,
        false
      );

      expect(retried).toBe(false);
      expect(createStreamResult).not.toHaveBeenCalled();
      expect((streamInfo.request as { messages: ModelMessage[] }).messages).toBe(originalMessages);
    });
  }

  test("an unrepairable matching rejection is still classified reasoning_rejected", async () => {
    // Soft interrupt makes the repair unsafe; the final error must not stay
    // in the auto-retryable `api` class or the outer loop replays it forever.
    const { errorEvents, run } = createRecoveryHarness("replay-unsafe-final");
    const streamInfo = replayStreamInfo(failingStream(openAIReasoningReplayRejections[0].error), {
      softInterrupt: { pending: true },
    });

    const createStreamResult = await run(streamInfo, []);

    expect(createStreamResult).not.toHaveBeenCalled();
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({ errorType: "reasoning_rejected" });
  });

  const nonMatchingRejections: Array<{ name: string; model: LanguageModel; error: unknown }> = [
    {
      name: "a loose rs_ mention on an unrelated 400",
      model: openAIResponsesModel,
      error: createApiCallErrorForTests({
        message: "Invalid value: 'rs_0d8a3f9c2b1e4a7d'. Supported values are: 'auto'.",
        statusCode: 400,
        responseBody:
          '{"error":{"message":"Invalid value: \'rs_0d8a3f9c2b1e4a7d\'. Supported values are: \'auto\'.","type":"invalid_request_error","code":"invalid_value"}}',
        isRetryable: false,
        data: { error: { type: "invalid_request_error", code: "invalid_value" } },
      }),
    },
    {
      name: "a non-reasoning item that was not found",
      model: openAIResponsesModel,
      error: createApiCallErrorForTests({
        message: "Item with id 'msg_0d8a3f9c2b1e4a7d' not found.",
        statusCode: 404,
        responseBody: '{"error":{"message":"Item with id \'msg_0d8a3f9c2b1e4a7d\' not found."}}',
        isRetryable: false,
      }),
    },
    {
      name: "a matching message on a non-4xx status",
      model: openAIResponsesModel,
      error: createApiCallErrorForTests({
        message: "The encrypted content for item rs_09beb6f8c1d2e3f4 could not be verified.",
        statusCode: 500,
        responseBody:
          '{"error":{"message":"The encrypted content for item rs_09beb6f8c1d2e3f4 could not be verified."}}',
        isRetryable: false,
      }),
    },
    {
      name: "an HTTP 500 with an SSE header but no stream error frame",
      model: openAIResponsesModel,
      error: new APICallError({
        message: "Item with id 'rs_stream' not found.",
        url: "https://api.openai.com/v1/responses",
        requestBodyValues: {},
        statusCode: 500,
        responseHeaders: { "content-type": "text/event-stream" },
        data: { error: { message: "Item with id 'rs_stream' not found." } },
      }),
    },
    {
      name: "an SDK retry sequence whose final error is unrelated",
      model: openAIResponsesModel,
      error: new RetryError({
        message: "AI SDK retry exhausted",
        reason: "maxRetriesExceeded",
        errors: [
          openAIReasoningReplayRejections[0].error,
          new StreamProviderError({ message: "Internal server error", statusCode: 500 }),
        ],
      }),
    },
    {
      name: "an unrelated streamed server error",
      model: openAIResponsesModel,
      error: new StreamProviderError({ message: "Internal server error", statusCode: 500 }),
    },
    {
      name: "an xAI streamed reasoning rejection",
      model: createTestLanguageModel("grok-4", "xai.responses"),
      error: new StreamProviderError({
        message: "Item with id 'rs_stream' not found.",
        statusCode: 500,
      }),
    },
    {
      name: "an xAI Responses model",
      model: createTestLanguageModel("grok-4", "xai.responses"),
      error: openAIReasoningReplayRejections[0].error,
    },
    {
      name: "an OpenAI chat-completions wire",
      model: createTestLanguageModel("gpt-5.2", "openai.chat"),
      error: openAIReasoningReplayRejections[1].error,
    },
  ];

  for (const nonMatching of nonMatchingRejections) {
    test(`leaves ${nonMatching.name} to ordinary error handling`, async () => {
      const { errorEvents, run } = createRecoveryHarness("replay-non-matching");
      const streamInfo = replayStreamInfo(failingStream(nonMatching.error), {
        request: {
          model: nonMatching.model,
          messages: requestMessagesWithReplay(),
          providerOptions: undefined,
        },
      });

      const createStreamResult = await run(streamInfo, []);

      expect(createStreamResult).not.toHaveBeenCalled();
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]?.errorType).not.toBe("reasoning_rejected");
    });
  }

  test("Xum gateway OpenAI models are eligible while other gateway upstreams are not", async () => {
    const createStreamResult = mock(() => createStreamResultForTests(successfulStream()));
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: fakeStreamText(createStreamResult),
    });
    const retryMethod = engineInternals(streamManager).retryStreamWithoutOpenAIReasoningReplay;

    for (const [modelId, expected] of [
      ["openai/gpt-5.2-codex", true],
      ["anthropic/claude-opus-4-5", false],
    ] as const) {
      const streamInfo = replayStreamInfo(failingStream(undefined), {
        model: `mux-gateway:${modelId}`,
        request: {
          model: createTestLanguageModel(modelId, "gateway"),
          messages: requestMessagesWithReplay(),
          providerOptions: undefined,
        },
      });
      expect(
        await retryMethod.call(
          streamManager,
          "replay-gateway",
          streamInfo,
          openAIReasoningReplayRejections[0].error,
          false
        )
      ).toBe(expected);
    }
    expect(createStreamResult).toHaveBeenCalledTimes(1);
  });
});

describe("StreamManager - categorizeError", () => {
  function categorizeErrorForTests(error: unknown): unknown {
    const streamManager = new StreamManager(historyService);
    const categorizeMethod = engineInternals(streamManager).categorizeError;
    return categorizeMethod.call(streamManager, error);
  }

  test("unwraps RetryError.lastError to classify model_not_found", () => {
    const apiError = createApiCallErrorForTests({
      message: "The model `gpt-5.2-codex` does not exist or you do not have access to it.",
      statusCode: 400,
      responseBody:
        '{"error":{"message":"The model `gpt-5.2-codex` does not exist or you do not have access to it.","code":"model_not_found"}}',
      isRetryable: false,
      data: { error: { code: "model_not_found" } },
    });
    const retryError = new RetryError({
      message: "AI SDK retry exhausted",
      reason: "maxRetriesExceeded",
      errors: [apiError],
    });

    expect(categorizeErrorForTests(retryError)).toBe("model_not_found");
  });

  test("classifies OpenAI 404 model_not_found by error code", () => {
    const apiError = createApiCallErrorForTests({
      message: "The model `gpt-nonexistent` does not exist or you do not have access to it.",
      statusCode: 404,
      responseBody:
        '{"error":{"message":"The model `gpt-nonexistent` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}',
      isRetryable: false,
      data: { error: { type: "invalid_request_error", code: "model_not_found" } },
    });

    expect(categorizeErrorForTests(apiError)).toBe("model_not_found");
  });

  const categorizeCases: Array<{ name: string; error: unknown; expected: string }> = [
    {
      name: "classifies Anthropic missing message_stop as stream_truncated",
      error: new Error("anthropic stream closed before message_stop"),
      expected: "stream_truncated",
    },
    {
      name: "classifies OpenAI Responses missing terminal event as stream_truncated",
      error: new Error("openai responses stream closed before terminal event"),
      expected: "stream_truncated",
    },
    {
      name: "classifies model_not_found via message fallback",
      error: new Error("The model `gpt-5.2-codex` does not exist or you do not have access to it."),
      expected: "model_not_found",
    },
    {
      name: "classifies 402 payment required as quota (avoid auto-retry)",
      error: createApiCallErrorForTests({
        message: "Insufficient balance. Please add credits to continue.",
        url: "https://gateway.mux.coder.com/api/v1/ai-gateway/v1/ai/language-model",
        statusCode: 402,
        responseBody:
          '{"error":{"message":"Insufficient balance. Please add credits to continue.","type":"invalid_request_error"}}',
        isRetryable: false,
        data: { error: { message: "Insufficient balance. Please add credits to continue." } },
      }),
      expected: "quota",
    },
    {
      name: "classifies 429 insufficient_quota responses as quota",
      error: createApiCallErrorForTests({
        message: "Request failed",
        statusCode: 429,
        responseBody:
          '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
        isRetryable: false,
        data: {
          error: { code: "insufficient_quota", message: "You exceeded your current quota" },
        },
      }),
      expected: "quota",
    },
    {
      name: "classifies generic 429 throttling as rate_limit",
      error: createApiCallErrorForTests({
        message: "Too many requests, please retry shortly",
        statusCode: 429,
        responseBody: '{"error":{"message":"Too many requests"}}',
        isRetryable: true,
      }),
      expected: "rate_limit",
    },
    {
      name: "classifies 429 mentioning quota limits as rate_limit (not billing)",
      error: createApiCallErrorForTests({
        message: "Per-minute quota limit reached. Retry in 10s.",
        statusCode: 429,
        responseBody: '{"error":{"message":"Per-minute quota limit reached"}}',
        isRetryable: true,
      }),
      expected: "rate_limit",
    },
  ];

  for (const categorizeCase of categorizeCases) {
    test(categorizeCase.name, () => {
      expect(categorizeErrorForTests(categorizeCase.error)).toBe(categorizeCase.expected);
    });
  }
});
