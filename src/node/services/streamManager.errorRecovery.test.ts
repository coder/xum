import { describe, test, expect } from "bun:test";
import { StreamManager, type TurnEngineEvent } from "./streamManager";
import * as aiSdk from "ai";
import {
  APICallError,
  RetryError,
  StreamProviderError,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createStreamManagerForTests, fakeStreamText } from "./streamManager.testHarness";
import {
  installStreamManagerTestHistory,
  historyService,
  createTestLanguageModel,
  TEST_USAGE,
  testStartOptions,
  appendPartialAssistantForTests,
  createStreamResultForTests,
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

type StreamTextOptions = Parameters<typeof aiSdk.streamText>[0];
type ErrorEvent = Extract<TurnEngineEvent, { type: "error" }>;
type StreamEndEvent = Extract<TurnEngineEvent, { type: "stream-end" }>;

interface AttemptContext {
  /** Requests a soft interrupt, as the session does for a queued user stop. */
  softStop: () => Promise<void>;
  /** Starts a hard stop without awaiting it: the stop waits for this attempt to exit. */
  hardStop: () => void;
}

/**
 * One provider attempt. The fake streamText hands it the request StreamManager
 * built, so the first call is the initial request and later calls are retries.
 */
type Attempt = (
  options: StreamTextOptions,
  context: AttemptContext
) => AsyncGenerator<unknown, void, unknown>;

/** Plays the SDK's per-step preparation so the engine records that step's transcript. */
async function prepareStep(
  options: StreamTextOptions,
  messages: ModelMessage[],
  stepNumber: number
): Promise<void> {
  const prepare = options.prepareStep;
  if (!prepare) throw new Error("Expected StreamManager to pass prepareStep");
  await prepare({
    messages,
    stepNumber,
    model: options.model,
    steps: [],
    initialMessages: messages,
    responseMessages: [],
    instructions: undefined,
    initialInstructions: undefined,
    toolsContext: {},
    runtimeContext: {},
  });
}

function failingAttempt(error: unknown): Attempt {
  return async function* () {
    await Promise.resolve();
    yield { type: "error", error };
  };
}

function textAttempt(text: string, usage: unknown = TEST_USAGE): Attempt {
  return async function* () {
    await Promise.resolve();
    yield { type: "start-step" };
    yield { type: "text-delta", text };
    yield { type: "finish-step", usage };
    yield { type: "finish", finishReason: "stop" };
  };
}

/**
 * Drives turns through startStream with scripted provider attempts and records
 * every emitted engine event. Turns on one harness share a StreamManager, so a
 * later turn observes state (lost response IDs, retry budgets) the earlier left.
 */
function createRecoveryHarness() {
  const events: TurnEngineEvent[] = [];
  let attempts: Attempt[] = [];
  let calls: StreamTextOptions[] = [];
  let streamUsage: unknown = TEST_USAGE;
  let workspaceId = "";
  let stops: Array<Promise<unknown>> = [];
  const context: AttemptContext = {
    softStop: async () => {
      const result = await streamManager.stopStream(workspaceId, { soft: true });
      expect(result.success).toBe(true);
    },
    hardStop: () => {
      stops.push(streamManager.stopStream(workspaceId, { abortReason: "user" }));
    },
  };
  const streamManager = createStreamManagerForTests(historyService, {
    eventSink: (event) => {
      events.push(event);
    },
    streamText: fakeStreamText((options) => {
      calls.push(options);
      const attempt = attempts.shift();
      if (!attempt) throw new Error(`Unexpected provider attempt ${calls.length}`);
      // Set usage explicitly: createStreamResultForTests defaults an undefined total.
      return {
        ...createStreamResultForTests(attempt(options, context)),
        usage: Promise.resolve(streamUsage),
        totalUsage: Promise.resolve(streamUsage),
      };
    }),
  });

  async function run(input: {
    workspaceId: string;
    attempts: Attempt[];
    historySequence?: number;
    model?: LanguageModel;
    modelString?: string;
    messages?: ModelMessage[];
    providerOptions?: Record<string, unknown>;
    /** SDK-reported total usage for every attempt of this turn. */
    streamUsage?: unknown;
  }) {
    const historySequence = input.historySequence ?? 1;
    const messageId = `${input.workspaceId}-${historySequence}`;
    workspaceId = input.workspaceId;
    attempts = [...input.attempts];
    calls = [];
    stops = [];
    streamUsage = "streamUsage" in input ? input.streamUsage : TEST_USAGE;
    await appendPartialAssistantForTests(input.workspaceId, messageId, historySequence);
    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId: input.workspaceId,
        messageId,
        historySequence,
        model: input.model ?? createTestLanguageModel(),
        ...(input.modelString != null ? { modelString: input.modelString } : {}),
        ...(input.messages != null ? { messages: input.messages } : {}),
        providerOptions: input.providerOptions,
        providedRuntimeTempDir: "",
      })
    );
    if (!result.success) throw new Error(`Expected stream to start: ${JSON.stringify(result)}`);
    const completion = await result.data.completion;
    await Promise.all(stops);
    return { calls, completion, messageId };
  }

  return {
    streamManager,
    run,
    events,
    errors: () => events.filter((event): event is ErrorEvent => event.type === "error"),
    streamEnds: () =>
      events.filter((event): event is StreamEndEvent => event.type === "stream-end"),
  };
}

function partTexts(streamEnd: StreamEndEvent | undefined): string[] {
  return (streamEnd?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []));
}

async function committedStepStarts(workspaceId: string, messageId: string) {
  const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
  if (!history.success) throw new Error(history.error);
  return history.data.find((message) => message.id === messageId)?.metadata?.stepStartPartIndices;
}

describe("StreamManager - previousResponseId recovery", () => {
  test("isResponseIdLost returns false for unknown IDs", () => {
    const streamManager = new StreamManager(historyService);

    // Verify the ID is not lost initially
    expect(streamManager.isResponseIdLost("resp_123abc")).toBe(false);
    expect(streamManager.isResponseIdLost("resp_different")).toBe(false);
  });

  const lostResponseIdCases: Array<{ name: string; lostId: string; error: unknown }> = [
    {
      name: "explicit OpenAI errors",
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
      lostId: "resp_cafebabe",
      error: createApiCallErrorForTests({
        message: "Internal error: Previous response with id 'resp_cafebabe' not found.",
        statusCode: 500,
        responseBody: "Internal error: Previous response with id 'resp_cafebabe' not found.",
        isRetryable: false,
        data: { error: { code: "server_error" } },
      }),
    },
    {
      // A structured stream error frame (not an Error): only its message names the ID.
      name: "stream error frames whose message names the ID",
      lostId: "resp_def456",
      error: { message: "Previous response with id 'resp_def456' not found.", statusCode: 400 },
    },
  ];

  for (const lostResponseIdCase of lostResponseIdCases) {
    test(`a failed stream records lost previousResponseIds for ${lostResponseIdCase.name}`, async () => {
      const harness = createRecoveryHarness();

      // No previousResponseId was sent, so there is nothing to retry without.
      const { calls } = await harness.run({
        workspaceId: "lost-response-id",
        attempts: [failingAttempt(lostResponseIdCase.error)],
      });

      expect(calls).toHaveLength(1);
      expect(harness.errors()).toHaveLength(1);
      expect(harness.streamManager.isResponseIdLost(lostResponseIdCase.lostId)).toBe(true);
    });
  }

  test("an error that names no response ID neither retries nor records the sent ID", async () => {
    const harness = createRecoveryHarness();

    const { calls } = await harness.run({
      workspaceId: "unrelated-400",
      providerOptions: { openai: { previousResponseId: "resp_abc123" } },
      attempts: [
        failingAttempt(
          createApiCallErrorForTests({
            message: "Some other error",
            statusCode: 400,
            responseBody: '{"error":{"message":"Some other error"}}',
            isRetryable: false,
          })
        ),
      ],
    });

    expect(calls).toHaveLength(1);
    expect(harness.errors()).toHaveLength(1);
    expect(harness.streamManager.isResponseIdLost("resp_abc123")).toBe(false);
  });

  test("retries without previousResponseId at a step boundary, keeping earlier parts and usage", async () => {
    const harness = createRecoveryHarness();
    const workspaceId = "previous-response-step";
    const stepMessages: ModelMessage[] = [{ role: "user", content: "next step" }];

    const { calls, messageId } = await harness.run({
      workspaceId,
      providerOptions: { openai: { previousResponseId: "resp_abc123" } },
      // The SDK total covers only the restarted stream, not the completed first step.
      streamUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      attempts: [
        async function* (options) {
          yield { type: "start-step" };
          yield { type: "text-delta", text: "step one" };
          yield { type: "finish-step", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
          await prepareStep(options, stepMessages, 1);
          yield {
            type: "error",
            error: createApiCallErrorForTests({
              message: "Previous response with id 'resp_abc123' not found.",
              statusCode: 400,
              responseBody: "Previous response with id 'resp_abc123' not found.",
              isRetryable: false,
              data: { error: { code: "previous_response_not_found" } },
            }),
          };
        },
        textAttempt("step two", { inputTokens: 4, outputTokens: 5, totalTokens: 9 }),
      ],
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.messages).toEqual(stepMessages);
    expect(
      (calls[1]?.providerOptions as { openai?: Record<string, unknown> }).openai?.previousResponseId
    ).toBeUndefined();
    expect(harness.errors()).toEqual([]);
    const [streamEnd] = harness.streamEnds();
    expect(partTexts(streamEnd)).toEqual(["step one", "step two"]);
    // Step-boundary retries report the per-step accumulation, not the restarted SDK total.
    expect(streamEnd?.metadata.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
    });
    // The retried step reuses its start index instead of recording a duplicate.
    expect(await committedStepStarts(workspaceId, messageId)).toEqual([0, 1]);
    expect(harness.streamManager.isResponseIdLost("resp_abc123")).toBe(true);
  });

  function emptyAttempt(usage: unknown): Attempt {
    return async function* () {
      await Promise.resolve();
      yield { type: "start-step" };
      yield { type: "finish-step", usage };
      yield { type: "finish", finishReason: "stop" };
    };
  }

  const totalUsageCases: Array<{
    name: string;
    attempts: Attempt[];
    streamUsage: Record<string, number> | undefined;
    expected: Record<string, number>;
  }> = [
    {
      name: "falls back to per-step usage when the SDK total is missing",
      attempts: [textAttempt("answer", { inputTokens: 4, outputTokens: 5, totalTokens: 9 })],
      // getStreamMetadata's totalUsage read can time out (slow SDK settlement)
      // even though the provider billed the turn.
      streamUsage: undefined,
      expected: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    },
    {
      name: "falls back to per-step usage when the SDK total has zero tokens",
      attempts: [textAttempt("answer", { inputTokens: 4, outputTokens: 5, totalTokens: 9 })],
      streamUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      expected: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    },
    {
      name: "prefers per-step usage after an empty-output retry",
      attempts: [
        emptyAttempt({ inputTokens: 2, outputTokens: 0, totalTokens: 2 }),
        textAttempt("answer", { inputTokens: 4, outputTokens: 5, totalTokens: 9 }),
      ],
      streamUsage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
      expected: { inputTokens: 6, outputTokens: 5, totalTokens: 11 },
    },
    {
      name: "treats any non-zero field as usage after a retry",
      attempts: [
        emptyAttempt({ inputTokens: 4, outputTokens: 0, totalTokens: 0 }),
        textAttempt("answer", { inputTokens: 0, outputTokens: 1, totalTokens: 0 }),
      ],
      streamUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      expected: { inputTokens: 4, outputTokens: 1, totalTokens: 0 },
    },
    {
      name: "keeps the SDK total without a retry",
      attempts: [textAttempt("answer", { inputTokens: 4, outputTokens: 5, totalTokens: 9 })],
      streamUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      expected: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    },
  ];

  for (const usageCase of totalUsageCases) {
    test(`stream-end usage ${usageCase.name}`, async () => {
      const harness = createRecoveryHarness();

      const { calls } = await harness.run({
        workspaceId: "stream-end-usage",
        attempts: usageCase.attempts,
        streamUsage: usageCase.streamUsage,
      });

      expect(calls).toHaveLength(usageCase.attempts.length);
      const [streamEnd] = harness.streamEnds();
      expect(streamEnd?.metadata.usage).toMatchObject(usageCase.expected);
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

  const successfulAttempt = textAttempt("repaired answer");

  /** An OpenAI Responses turn whose transcript replays stale encrypted reasoning. */
  function runReplayTurn(
    harness: ReturnType<typeof createRecoveryHarness>,
    input: {
      workspaceId: string;
      attempts: Attempt[];
      historySequence?: number;
      model?: LanguageModel;
      modelString?: string;
      messages?: ModelMessage[];
    }
  ) {
    return harness.run({
      model: openAIResponsesModel,
      modelString: "openai:gpt-5.2-codex",
      messages: requestMessagesWithReplay(),
      ...input,
    });
  }

  for (const rejection of openAIReasoningReplayRejections) {
    test(`repairs ${rejection.name} once without surfacing an intermediate error`, async () => {
      const harness = createRecoveryHarness();

      const { calls } = await runReplayTurn(harness, {
        workspaceId: "replay-repair",
        attempts: [failingAttempt(rejection.error), successfulAttempt],
      });

      expect(calls).toHaveLength(2);
      expect(calls[0]?.messages).toEqual(requestMessagesWithReplay());
      expect(calls[1]?.messages).toEqual(repairedRequestMessages);
      expect(harness.errors()).toEqual([]);
      expect(harness.streamEnds()).toHaveLength(1);
    });

    test(`repairs ${rejection.name} from the prepared first-step transcript`, async () => {
      const harness = createRecoveryHarness();
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

      const { calls } = await runReplayTurn(harness, {
        workspaceId: "replay-prepared-first",
        attempts: [
          async function* (options) {
            await prepareStep(options, preparedMessages, 0);
            yield { type: "error", error: rejection.error };
          },
          successfulAttempt,
        ],
      });

      expect(calls).toHaveLength(2);
      expect(calls[1]?.messages).toEqual([
        { role: "user", content: "compacted summary" },
        { role: "assistant", content: [{ type: "text", text: "retained answer" }] },
        { role: "user", content: "now" },
      ]);
      expect(harness.errors()).toEqual([]);
      expect(harness.streamEnds()).toHaveLength(1);
    });

    test(`surfaces a repeated ${rejection.name} as terminal reasoning_rejected after one repair`, async () => {
      const workspaceId = "replay-repeat";
      const harness = createRecoveryHarness();

      const { calls, messageId } = await runReplayTurn(harness, {
        workspaceId,
        attempts: [failingAttempt(rejection.error), failingAttempt(rejection.error)],
      });

      expect(calls).toHaveLength(2);
      expect(harness.streamEnds()).toHaveLength(0);
      expect(harness.errors()).toHaveLength(1);
      expect(harness.errors()[0]).toMatchObject({ messageId, errorType: "reasoning_rejected" });
      expect((await historyService.readPartial(workspaceId))?.metadata?.errorType).toBe(
        "reasoning_rejected"
      );

      // The one-shot budget is per stream attempt, not persisted: a manual
      // continuation on the same workspace gets its own repair.
      const continuation = await runReplayTurn(harness, {
        workspaceId,
        historySequence: 2,
        attempts: [failingAttempt(rejection.error), successfulAttempt],
      });
      expect(continuation.calls).toHaveLength(2);
      expect(harness.errors()).toHaveLength(1);
      expect(harness.streamEnds()).toHaveLength(1);
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

      const harness = createRecoveryHarness();
      const repaired = await runReplayTurn(harness, {
        workspaceId: "replay-streamed",
        attempts: [failingAttempt(errors[0]), successfulAttempt],
      });
      expect(repaired.calls).toHaveLength(2);
      expect(harness.errors()).toEqual([]);
      expect(harness.streamEnds()).toHaveLength(1);

      const repeated = await runReplayTurn(harness, {
        workspaceId: "replay-streamed",
        historySequence: 2,
        attempts: [failingAttempt(errors[0]), failingAttempt(errors[0])],
      });
      expect(repeated.calls).toHaveLength(2);
      expect(harness.errors()).toHaveLength(1);
      expect(harness.errors()[0]).toMatchObject({ errorType: "reasoning_rejected" });
      expect(harness.streamEnds()).toHaveLength(1);
    });
  }

  for (const [statusCode, errorType] of [
    [503, "server_error"],
    [401, "authentication"],
    [429, "rate_limit"],
  ] as const) {
    test(`a later ${statusCode} after the repair keeps its ordinary classification`, async () => {
      const harness = createRecoveryHarness();
      const laterError = createApiCallErrorForTests({
        message: "The next request failed",
        statusCode,
        responseBody: '{"error":{"message":"The next request failed"}}',
        isRetryable: statusCode !== 401,
      });

      const { calls } = await runReplayTurn(harness, {
        workspaceId: `replay-then-${statusCode}`,
        attempts: [
          failingAttempt(openAIReasoningReplayRejections[1].error),
          failingAttempt(laterError),
        ],
      });

      expect(calls).toHaveLength(2);
      expect(harness.errors()).toHaveLength(1);
      expect(harness.errors()[0]).toMatchObject({ errorType });
    });
  }

  test("step-boundary repair keeps prior-step parts and usage and replays the stripped step messages", async () => {
    const workspaceId = "replay-step";
    const harness = createRecoveryHarness();
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

    const { calls, messageId } = await runReplayTurn(harness, {
      workspaceId,
      attempts: [
        async function* (options) {
          yield { type: "start-step" };
          yield { type: "text-delta", text: "step one" };
          yield {
            type: "finish-step",
            usage: { inputTokens: 40, outputTokens: 9, totalTokens: 49 },
          };
          await prepareStep(options, stepMessages, 1);
          yield { type: "error", error: openAIReasoningReplayRejections[0].error };
        },
        successfulAttempt,
      ],
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.messages).toEqual([
      ...repairedRequestMessages,
      { role: "assistant", content: [toolCall] },
      toolResult,
    ]);
    expect(harness.errors()).toEqual([]);
    const [streamEnd] = harness.streamEnds();
    expect(partTexts(streamEnd)).toEqual(["step one", "repaired answer"]);
    // Prior-step usage survives the repair and wins over the restarted SDK total.
    expect(streamEnd?.metadata.usage).toMatchObject({
      inputTokens: 41,
      outputTokens: 10,
      totalTokens: 51,
    });
    expect(await committedStepStarts(workspaceId, messageId)).toEqual([0, 1]);
  });

  const unsafeRepairCases: Array<{
    name: string;
    attempt: Attempt;
    messages?: ModelMessage[];
  }> = [
    {
      // A matching rejection that reaches failure handling while a soft stop
      // is pending must not stay in the auto-retryable `api` class, or the
      // outer loop replays it forever.
      name: "a soft interrupt is pending",
      attempt: async function* (_options, context) {
        await context.softStop();
        yield { type: "error", error: openAIReasoningReplayRejections[1].error };
      },
    },
    {
      name: "the current step already emitted parts",
      attempt: async function* () {
        await Promise.resolve();
        yield { type: "start-step" };
        yield { type: "text-delta", text: "partial" };
        yield { type: "error", error: openAIReasoningReplayRejections[1].error };
      },
    },
    {
      name: "a completed step left no step snapshot",
      attempt: async function* () {
        await Promise.resolve();
        yield { type: "start-step" };
        yield { type: "text-delta", text: "step one" };
        yield { type: "finish-step", usage: TEST_USAGE };
        yield { type: "error", error: openAIReasoningReplayRejections[1].error };
      },
    },
    {
      name: "there is nothing to strip",
      attempt: failingAttempt(openAIReasoningReplayRejections[1].error),
      messages: repairedRequestMessages,
    },
  ];

  for (const unsafeCase of unsafeRepairCases) {
    test(`does not replay when ${unsafeCase.name} and classifies the rejection reasoning_rejected`, async () => {
      const harness = createRecoveryHarness();

      const { calls } = await runReplayTurn(harness, {
        workspaceId: "replay-unsafe",
        attempts: [unsafeCase.attempt],
        ...(unsafeCase.messages != null ? { messages: unsafeCase.messages } : {}),
      });

      expect(calls).toHaveLength(1);
      expect(harness.errors()).toHaveLength(1);
      expect(harness.errors()[0]).toMatchObject({ errorType: "reasoning_rejected" });
    });
  }

  test("does not replay a rejection that surfaces after the stream was stopped", async () => {
    const harness = createRecoveryHarness();

    const { calls, completion } = await runReplayTurn(harness, {
      workspaceId: "replay-stopped",
      attempts: [
        async function* (options, context) {
          yield* [];
          context.hardStop();
          await new Promise<void>((resolve) => {
            if (options.abortSignal?.aborted) resolve();
            options.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });
          // The transport rejects the iterator once the request is cancelled.
          throw openAIReasoningReplayRejections[1].error;
        },
      ],
    });

    expect(calls).toHaveLength(1);
    expect(completion.status).toBe("aborted");
    expect(harness.errors()).toEqual([]);
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
      const harness = createRecoveryHarness();

      const { calls } = await runReplayTurn(harness, {
        workspaceId: "replay-non-matching",
        model: nonMatching.model,
        attempts: [failingAttempt(nonMatching.error)],
      });

      expect(calls).toHaveLength(1);
      expect(harness.errors()).toHaveLength(1);
      expect(harness.errors()[0]?.errorType).not.toBe("reasoning_rejected");
    });
  }

  for (const [modelId, repaired] of [
    ["openai/gpt-5.2-codex", true],
    ["anthropic/claude-opus-4-5", false],
  ] as const) {
    test(`Xum gateway ${modelId} ${repaired ? "is" : "is not"} eligible for the repair`, async () => {
      const harness = createRecoveryHarness();

      const { calls } = await runReplayTurn(harness, {
        workspaceId: "replay-gateway",
        model: createTestLanguageModel(modelId, "gateway"),
        modelString: `mux-gateway:${modelId}`,
        attempts: repaired
          ? [failingAttempt(openAIReasoningReplayRejections[0].error), successfulAttempt]
          : [failingAttempt(openAIReasoningReplayRejections[0].error)],
      });

      expect(calls).toHaveLength(repaired ? 2 : 1);
      expect(harness.streamEnds()).toHaveLength(repaired ? 1 : 0);
      expect(harness.errors()).toHaveLength(repaired ? 0 : 1);
      expect(harness.errors()[0]?.errorType).not.toBe("reasoning_rejected");
    });
  }
});

describe("StreamManager - stream error classification", () => {
  /** Fails one stream with `error` and returns the errorType the turn surfaced. */
  async function errorTypeForStreamFailure(error: unknown): Promise<unknown> {
    const harness = createRecoveryHarness();
    const { calls, messageId } = await harness.run({
      workspaceId: "classify-error",
      attempts: [failingAttempt(error)],
    });
    expect(calls).toHaveLength(1);
    expect(harness.errors()).toHaveLength(1);
    // The persisted partial carries the same classification the event reported.
    const partial = await historyService.readPartial("classify-error");
    expect(partial?.id).toBe(messageId);
    expect(partial?.metadata?.errorType).toBe(harness.errors()[0]?.errorType);
    return harness.errors()[0]?.errorType;
  }

  test("unwraps RetryError.lastError to classify model_not_found", async () => {
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

    expect(await errorTypeForStreamFailure(retryError)).toBe("model_not_found");
  });

  test("classifies OpenAI 404 model_not_found by error code", async () => {
    const apiError = createApiCallErrorForTests({
      message: "The model `gpt-nonexistent` does not exist or you do not have access to it.",
      statusCode: 404,
      responseBody:
        '{"error":{"message":"The model `gpt-nonexistent` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}',
      isRetryable: false,
      data: { error: { type: "invalid_request_error", code: "model_not_found" } },
    });

    expect(await errorTypeForStreamFailure(apiError)).toBe("model_not_found");
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
    test(categorizeCase.name, async () => {
      expect(await errorTypeForStreamFailure(categorizeCase.error)).toBe(categorizeCase.expected);
    });
  }
});
