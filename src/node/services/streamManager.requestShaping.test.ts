import { describe, test, expect, afterEach, mock, spyOn } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { Ok } from "@/common/types/result";
import type { ToolSearchStreamState } from "@/common/utils/tools/toolCatalog";
import { formatAgentMessageEnvelope } from "@/common/utils/agentMessageEnvelope";
import { formatPlanReviewEnvelope } from "@/common/utils/planReview/planReviewEnvelope";
import type { PlanReviewRecord } from "@/common/utils/planReview/planReviewRecord";
import type {
  ModelFallbackPrepareOptions,
  TurnEngineEvent,
  TurnExecutionOptions,
} from "./streamManager";
import type {
  ActiveTurnThinkingOverride,
  LiveTurnRouting,
  RebuildProviderOptionsForThinkingLevel,
} from "./thinkingOverride";
import type { ThinkingLevel } from "@/common/types/thinking";
import type * as aiSdk from "ai";
import { tool, type ModelMessage, type Tool, type ToolResultPart } from "ai";
import { z } from "zod";
import * as modelStatsModule from "@/common/utils/tokens/modelStats";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createStreamManagerForTests, fakeStreamText } from "./streamManager.testHarness";
import {
  installStreamManagerTestHistory,
  historyService,
  createTestLanguageModel,
  testStartOptions,
  appendPartialAssistantForTests,
  createStreamResultForTests,
} from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

let capturedStreamCounter = 0;

/**
 * Starts one stream through the public boundary with an injected streamText
 * spy and waits for the turn to finish. Request-shaping tests assert on the
 * arguments StreamManager hands to streamText.
 */
async function startStreamCapturingStreamTextForTests(
  overrides: Partial<TurnExecutionOptions> & Pick<TurnExecutionOptions, "model">
) {
  const streamText = mock((_options: Parameters<typeof aiSdk.streamText>[0]) =>
    createStreamResultForTests(
      (async function* () {
        await Promise.resolve();
        yield { type: "text-delta", text: "ok" };
        yield { type: "finish", finishReason: "stop" };
      })()
    )
  );
  const streamManager = createStreamManagerForTests(historyService, {
    streamText: fakeStreamText(streamText),
  });
  capturedStreamCounter += 1;
  const workspaceId = `captured-stream-${capturedStreamCounter}`;
  const messageId = `${workspaceId}-message`;
  await appendPartialAssistantForTests(workspaceId, messageId, 1);
  const result = await streamManager.startStream(
    testStartOptions({ workspaceId, messageId, providedRuntimeTempDir: "", ...overrides })
  );
  if (!result.success) throw new Error("Expected stream to start");
  await result.data.completion;
  return { streamText, streamManager };
}

describe("StreamManager - sequential tool execution", () => {
  interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  }

  function createDeferred<T>(): Deferred<T> {
    let resolve: Deferred<T>["resolve"] | undefined;
    let reject: Deferred<T>["reject"] | undefined;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });

    if (!resolve || !reject) {
      throw new Error("createDeferred failed to initialize promise controls");
    }

    return { promise, resolve, reject };
  }

  test("passes sequentially wrapped tools to streamText", async () => {
    const model = createAnthropic({ apiKey: "test" })("claude-sonnet-4-5");
    const executionLog: string[] = [];
    const started = {
      a: createDeferred<void>(),
      b: createDeferred<void>(),
    };
    const release = {
      a: createDeferred<void>(),
      b: createDeferred<void>(),
    };

    const tools = {
      a: tool({
        description: "Tool A",
        inputSchema: z.object({}),
        execute: async () => {
          executionLog.push("start A");
          started.a.resolve();
          await release.a.promise;
          executionLog.push("end A");
          return { tool: "A" };
        },
      }),
      b: tool({
        description: "Tool B",
        inputSchema: z.object({}),
        execute: async () => {
          executionLog.push("start B");
          started.b.resolve();
          await release.b.promise;
          executionLog.push("end B");
          return { tool: "B" };
        },
      }),
    };

    const { streamText: streamTextSpy } = await startStreamCapturingStreamTextForTests({
      model,
      modelString: KNOWN_MODELS.SONNET.id,
      tools,
      hasQueuedMessages: () => false,
    });

    expect(streamTextSpy).toHaveBeenCalledTimes(1);
    const capturedTools = streamTextSpy.mock.calls[0]?.[0]?.tools as
      | Record<string, Tool>
      | undefined;
    expect(capturedTools).toBeDefined();
    expect(capturedTools).not.toBe(tools);
    expect(capturedTools!.a).not.toBe(tools.a);
    expect(capturedTools!.b).not.toBe(tools.b);

    const resultsPromise = Promise.all([
      capturedTools!.a.execute!({}, {} as never),
      capturedTools!.b.execute!({}, {} as never),
    ]);

    await started.a.promise;
    await Promise.resolve();
    expect(executionLog).toEqual(["start A"]);

    release.a.resolve();
    await started.b.promise;
    await Promise.resolve();
    expect(executionLog).toEqual(["start A", "end A", "start B"]);

    release.b.resolve();
    const results = await resultsPromise;

    expect(results).toEqual([{ tool: "A" }, { tool: "B" }]);
    expect(executionLog).toEqual(["start A", "end A", "start B", "end B"]);
  });
});

describe("StreamManager - call settings overrides", () => {
  const model = createAnthropic({ apiKey: "test" })("claude-sonnet-4-5");
  const modelString = KNOWN_MODELS.SONNET.id;

  afterEach(() => {
    mock.restore();
  });

  test("uses config maxOutputTokens override when explicit maxOutputTokens is missing", async () => {
    spyOn(modelStatsModule, "getModelStats").mockReturnValue({
      max_input_tokens: 200000,
      max_output_tokens: 8192,
      input_cost_per_token: 0,
      output_cost_per_token: 0,
    });

    const { streamText } = await startStreamCapturingStreamTextForTests({
      model,
      modelString,
      callSettingsOverrides: { maxOutputTokens: 4096 },
    });

    expect(streamText).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 4096 }));
  });

  test("uses explicit maxOutputTokens over config maxOutputTokens override", async () => {
    spyOn(modelStatsModule, "getModelStats").mockReturnValue({
      max_input_tokens: 200000,
      max_output_tokens: 8192,
      input_cost_per_token: 0,
      output_cost_per_token: 0,
    });

    const { streamText } = await startStreamCapturingStreamTextForTests({
      model,
      modelString,
      maxOutputTokens: 1024,
      callSettingsOverrides: { maxOutputTokens: 4096 },
    });

    expect(streamText).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 1024 }));
  });

  test("forwards stream call settings to streamText", async () => {
    const { streamText } = await startStreamCapturingStreamTextForTests({
      model,
      modelString,
      callSettingsOverrides: { temperature: 0.5, topP: 0.9 },
    });

    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.5,
        topP: 0.9,
      })
    );
  });

  test("forwards onChunk to streamText unchanged", async () => {
    const onChunk = mock(() => undefined);

    const { streamText } = await startStreamCapturingStreamTextForTests({
      model,
      modelString,
      onChunk,
    });

    expect(streamText).toHaveBeenCalledWith(expect.objectContaining({ onChunk }));
  });
});

// Note: Comprehensive Anthropic cache control tests are in cacheStrategy.test.ts
// Those unit tests cover all cache control functionality without requiring
// complex setup. StreamManager integrates those functions directly.

describe("StreamManager - tool search activeTools scoping", () => {
  // prepareStep only destructures `messages`; the remaining PrepareStepFunction
  // fields are irrelevant to this behavior.
  type CapturedPrepareStep = (options: {
    messages: ModelMessage[];
  }) => Promise<{ messages?: ModelMessage[]; activeTools?: string[] } | undefined>;

  const model = createAnthropic({ apiKey: "test" })("claude-sonnet-4-5");
  const messages: ModelMessage[] = [{ role: "user", content: "hello" }];

  function capturePrepareStep(
    streamTextSpy: Awaited<ReturnType<typeof startStreamCapturingStreamTextForTests>>["streamText"]
  ): CapturedPrepareStep {
    const prepareStep = streamTextSpy.mock.calls[0]?.[0]?.prepareStep as
      | CapturedPrepareStep
      | undefined;
    expect(typeof prepareStep).toBe("function");
    if (!prepareStep) {
      throw new Error("Expected prepareStep to be captured");
    }
    return prepareStep;
  }

  afterEach(() => {
    mock.restore();
  });

  test("returns undefined (not {}) without tool search state and unchanged messages", async () => {
    const { streamText: streamTextSpy } = await startStreamCapturingStreamTextForTests({
      model,
      messages,
    });

    const prepareStep = capturePrepareStep(streamTextSpy);
    // Feature-off path must stay byte-identical to today's behavior.
    expect(await prepareStep({ messages })).toBeUndefined();
  });

  test("scopes activeTools to core + activated deferred tools, reflecting live activations", async () => {
    const toolSearchState: ToolSearchStreamState = {
      catalog: [
        { name: "slack_send_message", description: "Send a message", paramText: "" },
        { name: "slack_list_channels", description: "List channels", paramText: "" },
      ],
      deferredToolNames: new Set(["slack_send_message", "slack_list_channels"]),
      allToolNames: ["bash", "tool_catalog_search", "slack_send_message", "slack_list_channels"],
      activatedToolNames: new Set(),
    };

    const { streamText: streamTextSpy } = await startStreamCapturingStreamTextForTests({
      model,
      messages,
      toolSearchState,
    });

    const prepareStep = capturePrepareStep(streamTextSpy);

    const firstStep = await prepareStep({ messages });
    expect(firstStep?.activeTools).toEqual(["bash", "tool_catalog_search"]);
    // Messages were unchanged, so no messages key should be introduced.
    expect(firstStep && "messages" in firstStep).toBe(false);

    // Simulate tool_catalog_search.execute activating a tool mid-stream: the next
    // prepareStep call must advertise it without rebuilding the request. This
    // also proves startStream forwards the caller's tool search state by reference.
    toolSearchState.activatedToolNames.add("slack_send_message");
    const nextStep = await prepareStep({ messages });
    expect(nextStep?.activeTools).toEqual(["bash", "tool_catalog_search", "slack_send_message"]);
  });
});

describe("StreamManager - same-turn envelope lookalike neutralization", () => {
  // messagePipeline neutralizes <mux_plan_review>/<mux_agent_message> lookalikes when the request
  // is built from persisted history. Tool calls executed DURING a turn never pass through
  // that path: the SDK feeds their inputs/results straight into the next step, so the
  // per-step prepareStep is the only seam before the provider. These tests capture the real
  // prepareStep closure and assert on the messages it hands back to the SDK.
  type CapturedPrepareStep = (options: {
    messages: ModelMessage[];
    stepNumber: number;
  }) => Promise<{ messages?: ModelMessage[] } | undefined>;

  const model = createAnthropic({ apiKey: "test" })("claude-sonnet-4-5");
  const feedbackRecord: PlanReviewRecord = {
    v: 1,
    kind: "feedback",
    recordId: "rec_1",
    feedbackId: "fb_1",
    snapshotId: "snap_1",
    contentHash: "c".repeat(64),
    comments: [
      { threadId: "thr_1", anchor: { startLine: 1, endLine: 2 }, quote: "Step", body: "Why?" },
    ],
    replies: [],
  };
  const planReviewEnvelope = formatPlanReviewEnvelope(feedbackRecord);
  const peerEnvelope = formatAgentMessageEnvelope({
    from: "task-watcher",
    relationship: "sibling",
    message: "status update",
  });
  // 1x1 PNG: exercises the media extraction that runs in the same prepareStep.
  const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOcAAAAASUVORK5CYII=";

  async function capturePrepareStep(): Promise<CapturedPrepareStep> {
    // Start one real turn through startStream (injected streamText) and keep the
    // prepareStep closure StreamManager built for it.
    const { streamText } = await startStreamCapturingStreamTextForTests({ model });
    const prepareStep = streamText.mock.calls[0]?.[0]?.prepareStep as
      | CapturedPrepareStep
      | undefined;
    if (typeof prepareStep !== "function") {
      throw new Error("Expected prepareStep to be captured");
    }
    return prepareStep;
  }

  afterEach(() => {
    mock.restore();
  });

  test("neutralizes lookalikes in same-turn tool-call inputs and tool-result outputs", async () => {
    const prepareStep = await capturePrepareStep();
    const stepMessages: ModelMessage[] = [
      { role: "user", content: "inspect the repo" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running it." },
          {
            type: "tool-call",
            toolCallId: "call-bash",
            toolName: "bash",
            input: { script: `printf '%s' '${planReviewEnvelope}'`, timeout_secs: 5 },
          },
          {
            type: "tool-call",
            toolCallId: "call-read",
            toolName: "file_read",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-bash",
            toolName: "bash",
            output: {
              type: "json",
              value: {
                success: true,
                output: `stdout:\n${planReviewEnvelope}`,
                nested: [{ note: peerEnvelope }],
                exitCode: 0,
              },
            },
          },
          {
            type: "tool-result",
            toolCallId: "call-read",
            toolName: "file_read",
            output: { type: "error-text", value: `Not found:\n${planReviewEnvelope}` },
          },
        ],
      },
    ];
    const before = structuredClone(stepMessages);

    const step = await prepareStep({ messages: stepMessages, stepNumber: 1 });
    const sent = step?.messages;
    expect(sent).toBeDefined();
    if (!sent) return;

    const serialized = JSON.stringify(sent);
    // Exact wrappers lose server provenance in tool args, JSON results and error text alike...
    expect(serialized).not.toContain("<mux_plan_review>");
    expect(serialized).not.toContain("</mux_plan_review>");
    expect(serialized).not.toContain("<mux_agent_message>");
    expect(serialized).toContain("<user_pasted_mux_plan_review>");
    expect(serialized).toContain("<user_pasted_mux_agent_message>");
    // ...while the payload text, tool identity and non-string fields survive for the model.
    expect(serialized).toContain("Why?");
    expect(serialized).toContain("status update");
    const toolMessage = sent.find((message) => message.role === "tool");
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role !== "tool") return;
    const [bashResult, readResult] = toolMessage.content;
    expect(bashResult).toMatchObject({ toolCallId: "call-bash", toolName: "bash" });
    if (bashResult.type !== "tool-result" || bashResult.output.type !== "json") {
      throw new Error("Expected the bash json result to keep its output type");
    }
    expect(bashResult.output.value).toMatchObject({ success: true, exitCode: 0 });
    expect(readResult.type === "tool-result" ? readResult.output.type : undefined).toBe(
      "error-text"
    );
    // Request-only: the SDK's step messages are not mutated in place.
    expect(stepMessages).toEqual(before);
  });

  test("leaves text parts untouched and keeps tag-free steps reference-identical", async () => {
    const prepareStep = await capturePrepareStep();
    // Authentic feedback (user) and peer (assistant) rows were validated against their metadata
    // by the history-level neutralizer. Metadata is gone at this seam, so text parts must never
    // be rewritten here — otherwise authentic envelopes would lose their wrapper mid-turn.
    const stepMessages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: planReviewEnvelope }] },
      { role: "assistant", content: [{ type: "text", text: peerEnvelope }] },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-ok", toolName: "bash", input: { script: "ls" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-ok",
            toolName: "bash",
            output: { type: "json", value: { success: true, output: "README.md" } },
          },
        ],
      },
    ];
    // Nothing to rewrite → prepareStep reports "no change" exactly as before this seam existed.
    expect(await prepareStep({ messages: stepMessages, stepNumber: 1 })).toBeUndefined();
    expect(JSON.stringify(stepMessages)).toContain("<mux_plan_review>");
    expect(JSON.stringify(stepMessages)).toContain("<mux_agent_message>");
  });

  test("composes with workflow run record stripping and tool media extraction", async () => {
    const prepareStep = await capturePrepareStep();
    const stepMessages: ModelMessage[] = [
      { role: "user", content: "go" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-workflow",
            toolName: "workflow_run",
            output: {
              type: "json",
              value: {
                status: "running",
                runId: "wfr_demo",
                result: null,
                run: {
                  id: "wfr_demo",
                  source: "export default function inlineSecretWorkflow() {}",
                },
              },
            },
          },
          {
            type: "tool-result",
            toolCallId: "call-attach",
            toolName: "attach_file",
            output: {
              type: "content",
              value: [
                { type: "text", text: `[Attachment prepared: ${planReviewEnvelope}]` },
                { type: "media", mediaType: "image/png", data: PNG_BASE64 },
              ],
            } as unknown as ToolResultPart["output"],
          },
        ],
      },
    ];

    const step = await prepareStep({ messages: stepMessages, stepNumber: 1 });
    const sent = step?.messages;
    expect(sent).toBeDefined();
    if (!sent) return;
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain("<mux_plan_review>");
    expect(serialized).toContain("<user_pasted_mux_plan_review>");
    // The existing per-step transforms still run on the same pass.
    expect(serialized).not.toContain("inlineSecretWorkflow");
    const syntheticUser = sent.find(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "image")
    );
    expect(syntheticUser).toBeDefined();
    const imagePart =
      syntheticUser && Array.isArray(syntheticUser.content)
        ? syntheticUser.content.find((part) => part.type === "image")
        : undefined;
    // Media bytes are never touched by the string rewrite.
    expect(imagePart?.type === "image" ? imagePart.image : undefined).toBe(PNG_BASE64);
  });
});

describe("StreamManager - mid-turn thinking override", () => {
  type StreamTextOptions = Parameters<typeof aiSdk.streamText>[0];
  type StepResult = Awaited<ReturnType<NonNullable<StreamTextOptions["prepareStep"]>>>;
  type StreamEndEvent = Extract<TurnEngineEvent, { type: "stream-end" }>;
  type Attempt = (options: StreamTextOptions) => AsyncGenerator<unknown, void, unknown>;

  const model = createAnthropic({ apiKey: "test" })("claude-sonnet-4-5");
  const messages: ModelMessage[] = [{ role: "user", content: "hello" }];
  const routed = {
    status: "routed" as const,
    tierId: "hard",
    model: "openai:gpt-4.1-mini",
    requestedFallbackModel: "openai:gpt-4.1-mini",
  };
  const thinkingRouted = { ...routed, thinkingLevel: "low" as const };

  /** Plays one SDK step preparation against the prepareStep StreamManager handed to streamText. */
  async function prepareStep(
    options: StreamTextOptions,
    stepMessages: ModelMessage[],
    stepNumber: number
  ): Promise<StepResult> {
    const prepare = options.prepareStep;
    if (!prepare) throw new Error("Expected StreamManager to pass prepareStep");
    return await prepare({
      messages: stepMessages,
      stepNumber,
      model: options.model,
      steps: [],
      initialMessages: stepMessages,
      responseMessages: [],
      instructions: undefined,
      initialInstructions: undefined,
      toolsContext: {},
      runtimeContext: {},
    });
  }

  async function* answer(): AsyncGenerator<unknown, void, unknown> {
    await Promise.resolve();
    yield { type: "text-delta", text: "done" };
    yield { type: "finish", finishReason: "stop" };
  }

  let turnCounter = 0;

  /**
   * Runs one turn through startStream. Each provider attempt (initial request,
   * then a fallback) gets the streamText options StreamManager built for it.
   */
  async function runTurn(
    options: Partial<TurnExecutionOptions>,
    attempts: Attempt[]
  ): Promise<{ calls: StreamTextOptions[]; streamEnd: StreamEndEvent | undefined }> {
    const calls: StreamTextOptions[] = [];
    const pending = [...attempts];
    const events: TurnEngineEvent[] = [];
    const streamManager = createStreamManagerForTests(historyService, {
      eventSink: (event) => {
        events.push(event);
      },
      streamText: fakeStreamText((streamTextOptions) => {
        calls.push(streamTextOptions);
        const attempt = pending.shift();
        if (!attempt) throw new Error(`Unexpected provider attempt ${calls.length}`);
        return createStreamResultForTests(attempt(streamTextOptions));
      }),
    });
    turnCounter += 1;
    const workspaceId = `thinking-override-${turnCounter}`;
    const messageId = `${workspaceId}-message`;
    await appendPartialAssistantForTests(workspaceId, messageId, 1);
    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId,
        messageId,
        model,
        messages,
        providedRuntimeTempDir: "",
        ...options,
      })
    );
    if (!result.success) throw new Error("Expected stream to start");
    const completion = await result.data.completion;
    expect(completion.status).toBe("completed");
    expect(pending).toEqual([]);
    return {
      calls,
      streamEnd: events.find((event): event is StreamEndEvent => event.type === "stream-end"),
    };
  }

  /**
   * One provider attempt that prepares each scripted step (running `before`
   * first, as a session write between steps would) and then answers.
   */
  function stepsThenAnswer(
    steps: Array<{ messages: ModelMessage[]; stepNumber?: number; before?: () => void }>,
    results: StepResult[]
  ): Attempt {
    return async function* (options) {
      for (const step of steps) {
        step.before?.();
        results.push(await prepareStep(options, step.messages, step.stepNumber ?? 1));
      }
      yield* answer();
    };
  }

  test("applies a pending override in place: same object identity, old keys deleted, level recorded", async () => {
    const state: ActiveTurnThinkingOverride = { pending: "high" };
    const originalProviderOptions: Record<string, unknown> = {
      anthropic: { effort: "low", thinking: { type: "enabled", budgetTokens: 4000 } },
      staleNamespace: { key: "must-be-deleted" },
    };
    const rebuilt = { anthropic: { effort: "high", thinking: { type: "enabled" } } };
    const rebuild = mock((level: string) =>
      level === "high" ? { effectiveLevel: "high" as const, providerOptions: rebuilt } : null
    );
    const results: StepResult[] = [];

    const { calls, streamEnd } = await runTurn(
      {
        providerOptions: originalProviderOptions,
        thinkingOverrideState: state,
        rebuildProviderOptionsForThinkingLevel:
          rebuild as unknown as RebuildProviderOptionsForThinkingLevel,
      },
      [stepsThenAnswer([{ messages }, { messages }], results)]
    );

    // Rebuilt options are returned for the step (defense in depth) …
    expect(results[0]?.providerOptions).toEqual(rebuilt);
    // … and the object streamText captured is replaced IN PLACE (same identity),
    // deleting keys the SDK's deep-merge could never remove.
    expect(calls[0]?.providerOptions as unknown).toBe(originalProviderOptions);
    expect(originalProviderOptions).toEqual(rebuilt);
    // Consume-once bookkeeping, and the applied level lands on the turn's record.
    expect(state.pending).toBeUndefined();
    expect(state.applied).toBe("high");
    expect(streamEnd?.metadata.thinkingLevel).toBe("high");
    // Without a new pending value the next step is a no-op again.
    expect(results[1]).toBeUndefined();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  test("clears pending without touching options when the rebuild reports not-applicable", async () => {
    const state: ActiveTurnThinkingOverride = { pending: "off" };
    const rebuild = mock(() => null);
    const results: StepResult[] = [];

    const { calls, streamEnd } = await runTurn(
      {
        providerOptions: { xai: { some: "config" } },
        thinkingOverrideState: state,
        rebuildProviderOptionsForThinkingLevel:
          rebuild as unknown as RebuildProviderOptionsForThinkingLevel,
      },
      [stepsThenAnswer([{ messages }, { messages }], results)]
    );

    expect(results).toEqual([undefined, undefined]);
    expect(calls[0]?.providerOptions).toEqual({ xai: { some: "config" } });
    // Consume-once: a skipped application must not retry on every later step.
    expect(state.pending).toBeUndefined();
    expect(state.applied).toBeUndefined();
    expect(streamEnd?.metadata.thinkingLevel).toBeUndefined();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  test("startStream normalizes providerOptions to a stable mutable object only when a rebuild closure exists", async () => {
    // Without the closure, an absent providerOptions stays absent (no behavior change).
    const plain = await runTurn({}, [stepsThenAnswer([], [])]);
    expect(plain.calls[0]?.providerOptions).toBeUndefined();

    // With the closure, undefined normalizes to the object streamText() captures,
    // so the in-place rebuild at prepareStep time reaches the SDK's per-step merge.
    const state: ActiveTurnThinkingOverride = { pending: "high" };
    const rebuilt = { anthropic: { effort: "high" } };
    const normalized = await runTurn(
      {
        thinkingOverrideState: state,
        rebuildProviderOptionsForThinkingLevel: () => ({
          effectiveLevel: "high",
          providerOptions: rebuilt,
        }),
      },
      [stepsThenAnswer([{ messages }], [])]
    );
    expect(normalized.calls[0]?.providerOptions).toEqual(rebuilt);
    expect(state.applied).toBe("high");
  });

  // Auto-set thinking escalation (autoThinkingEscalation.ts) rides the same override.
  function stuckTranscript(): ModelMessage[] {
    const failing = (index: number): ModelMessage[] => [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: `call-${index}`, toolName: "bash", input: { c: index } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `call-${index}`,
            toolName: "bash",
            output: { type: "json", value: { success: false, error: "boom" } },
          },
        ],
      },
    ];
    return [{ role: "user", content: "fix it" }, ...failing(0), ...failing(1), ...failing(2)];
  }
  // Three more failing steps after the first raise's judged steps.
  const longerStuckTranscript = () => [...stuckTranscript(), ...stuckTranscript().slice(1)];

  function escalatingRebuild(clamp: (level: string) => string = (level) => level) {
    return mock((level: string) => ({
      effectiveLevel: clamp(level) as ThinkingLevel,
      providerOptions: { anthropic: { effort: clamp(level) } },
    }));
  }

  test("a stuck Auto-set thinking level escalates through the rebuild and records provenance", async () => {
    const state: ActiveTurnThinkingOverride = {};
    const rebuild = escalatingRebuild();
    const results: StepResult[] = [];
    const transcript = stuckTranscript();

    const { streamEnd } = await runTurn(
      {
        providerOptions: {},
        thinkingOverrideState: state,
        rebuildProviderOptionsForThinkingLevel:
          rebuild as unknown as RebuildProviderOptionsForThinkingLevel,
        initialMetadata: { autoModelRouting: thinkingRouted },
      },
      [
        stepsThenAnswer(
          [
            { messages: transcript, stepNumber: 3 },
            { messages: transcript, stepNumber: 4 },
          ],
          results
        ),
      ]
    );

    expect(results[0]?.providerOptions).toEqual({ anthropic: { effort: "medium" } });
    expect(state.applied).toBe("medium");
    expect(streamEnd?.metadata.autoModelRouting?.escalations).toMatchObject([
      { step: 4, from: "low", to: "medium" },
    ]);
    // The judged steps do not fire again, and the user never touched the slider.
    expect(results[1]).toBeUndefined();
    expect(state.manual).toBeUndefined();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  test("a slider move this turn disables Auto's escalation", async () => {
    const rebuild = mock(() => null);
    const results: StepResult[] = [];

    const { streamEnd } = await runTurn(
      {
        providerOptions: {},
        thinkingOverrideState: { manual: true, applied: "off" },
        rebuildProviderOptionsForThinkingLevel:
          rebuild as unknown as RebuildProviderOptionsForThinkingLevel,
        initialMetadata: { autoModelRouting: thinkingRouted },
      },
      [stepsThenAnswer([{ messages: stuckTranscript(), stepNumber: 3 }], results)]
    );

    expect(results).toEqual([undefined]);
    expect(rebuild).not.toHaveBeenCalled();
    expect(streamEnd?.metadata.autoModelRouting?.escalations).toBeUndefined();
  });

  test("a raise a sparse ladder clamps upward is recorded at the level that applied", async () => {
    const state: ActiveTurnThinkingOverride = {};
    // The model offers low, high and xhigh: the requested medium lands on high.
    const rebuild = escalatingRebuild((level) => (level === "medium" ? "high" : level));
    const results: StepResult[] = [];

    const { streamEnd } = await runTurn(
      {
        providerOptions: {},
        thinkingOverrideState: state,
        rebuildProviderOptionsForThinkingLevel:
          rebuild as unknown as RebuildProviderOptionsForThinkingLevel,
        initialMetadata: { autoModelRouting: thinkingRouted },
      },
      [
        stepsThenAnswer(
          [
            { messages: stuckTranscript(), stepNumber: 3 },
            { messages: longerStuckTranscript(), stepNumber: 6 },
          ],
          results
        ),
      ]
    );

    expect(results[0]?.providerOptions).toEqual({ anthropic: { effort: "high" } });
    // Provenance names the level the turn now runs at, and the ladder continues from it.
    expect(rebuild.mock.calls.map(([level]) => level)).toEqual(["medium", "xhigh"]);
    expect(state.applied).toBe("xhigh");
    expect(streamEnd?.metadata.autoModelRouting?.escalations).toMatchObject([
      { step: 4, from: "low", to: "high" },
      { from: "high", to: "xhigh" },
    ]);
  });

  test("a raise the model ceiling clamps away is not provenance and ends further attempts", async () => {
    // The model tops out at high: the rebuild reports the clamped level as a no-op.
    const rebuild = mock(() => null);
    const results: StepResult[] = [];

    const { streamEnd } = await runTurn(
      {
        providerOptions: {},
        thinkingOverrideState: {},
        rebuildProviderOptionsForThinkingLevel:
          rebuild as unknown as RebuildProviderOptionsForThinkingLevel,
        initialMetadata: { autoModelRouting: { ...routed, thinkingLevel: "high" } },
      },
      [
        stepsThenAnswer(
          [
            { messages: stuckTranscript(), stepNumber: 3 },
            // Three more failures would qualify again; the exhausted state stops the retry.
            { messages: longerStuckTranscript(), stepNumber: 6 },
          ],
          results
        ),
      ]
    );

    expect(results).toEqual([undefined, undefined]);
    expect(streamEnd?.metadata.autoModelRouting?.escalations).toBeUndefined();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  test("startStream arms escalation only for an Auto-set thinking level, lands raises on the stream-end record, and reports live routing to the session", async () => {
    const cases = [
      { name: "thinking", autoModelRouting: thinkingRouted, sliderMove: false },
      { name: "model-only", autoModelRouting: routed, sliderMove: false },
      // The user moved the slider after the raise: Auto's claim (level and raises) is withdrawn.
      { name: "manual", autoModelRouting: thinkingRouted, sliderMove: true },
    ];
    const outcomes: Record<
      string,
      {
        levels: string[];
        streamEnd: StreamEndEvent | undefined;
        sessionSaw: LiveTurnRouting[];
      }
    > = {};
    for (const testCase of cases) {
      const sessionSaw: LiveTurnRouting[] = [];
      const holder: ActiveTurnThinkingOverride = {
        onLiveRoutingChanged: (live) => sessionSaw.push(live),
      };
      const rebuild = escalatingRebuild();
      const { streamEnd } = await runTurn(
        {
          tools: {},
          thinkingOverrideState: holder,
          rebuildProviderOptionsForThinkingLevel:
            rebuild as unknown as RebuildProviderOptionsForThinkingLevel,
          initialMetadata: { autoModelRouting: testCase.autoModelRouting },
        },
        [
          stepsThenAnswer(
            [
              { messages: stuckTranscript(), stepNumber: 3 },
              ...(testCase.sliderMove
                ? [
                    {
                      messages: stuckTranscript(),
                      stepNumber: 4,
                      before: () => {
                        // What the session's slider setter writes.
                        holder.manual = true;
                        holder.pending = "max";
                      },
                    },
                  ]
                : []),
            ],
            []
          ),
        ]
      );
      outcomes[testCase.name] = {
        levels: rebuild.mock.calls.map(([level]) => level),
        streamEnd,
        sessionSaw,
      };
    }

    const raise = { step: 4, from: "low", to: "medium" };
    // Armed streams raise the stuck turn; the model-only route never asks the rebuild.
    expect(outcomes.thinking?.levels).toEqual(["medium"]);
    expect(outcomes["model-only"]?.levels).toEqual([]);
    expect(outcomes.manual?.levels).toEqual(["medium", "max"]);

    expect(outcomes.thinking?.streamEnd?.metadata.autoModelRouting).toMatchObject({
      thinkingLevel: "low",
      escalations: [raise],
    });
    expect(
      outcomes["model-only"]?.streamEnd?.metadata.autoModelRouting?.escalations
    ).toBeUndefined();
    const manual = outcomes.manual?.streamEnd?.metadata;
    expect(manual?.thinkingLevel).toBe("max");
    expect(manual?.autoModelRouting?.tierId).toBe("hard");
    expect(manual?.autoModelRouting?.thinkingLevel).toBeUndefined();
    expect(manual?.autoModelRouting?.escalations).toBeUndefined();
    // The session's live-routing sink saw the same record each change landed on.
    expect(outcomes.thinking?.sessionSaw.at(-1)?.autoModelRouting).toMatchObject({
      thinkingLevel: "low",
      escalations: [raise],
    });
    expect(outcomes["model-only"]?.sessionSaw).toEqual([]);
    const manualLive = outcomes.manual?.sessionSaw.at(-1);
    expect(manualLive?.thinkingLevel).toBe("max");
    expect(manualLive?.autoModelRouting).not.toHaveProperty("thinkingLevel");
    expect(manualLive?.autoModelRouting).not.toHaveProperty("escalations");
  });

  test("model fallback folds the pending override into prepare() and rebinds holder + closure on the swapped request", async () => {
    const fallbackModel = KNOWN_MODELS.GPT.id;
    const fallbackLanguageModel = createTestLanguageModel("fallback-model");
    // The refused model's ceiling retires Auto's first raise on that model.
    const refusedRebuild = mock(() => null);
    const fallbackRebuild = escalatingRebuild();
    const prepareOptions: Array<ModelFallbackPrepareOptions | undefined> = [];
    const prepare = mock((nextModelString: string, options?: ModelFallbackPrepareOptions) => {
      prepareOptions.push(options);
      return Promise.resolve(
        Ok({
          model: fallbackLanguageModel,
          modelString: nextModelString,
          messages: [],
          system: "fallback system",
          tools: undefined,
          thinkingLevel: "high" as const,
          rebuildProviderOptionsForThinkingLevel:
            fallbackRebuild as unknown as RebuildProviderOptionsForThinkingLevel,
        })
      );
    });
    const sessionSaw: LiveTurnRouting[] = [];
    const holder: ActiveTurnThinkingOverride = {
      onLiveRoutingChanged: (live) => sessionSaw.push(live),
    };
    let atFallbackStart: { live?: LiveTurnRouting; pending?: string; applied?: string } = {};

    const { calls } = await runTurn(
      {
        model: createTestLanguageModel("refused-model"),
        modelString: KNOWN_MODELS.SONNET.id,
        thinkingOverrideState: holder,
        rebuildProviderOptionsForThinkingLevel:
          refusedRebuild as unknown as RebuildProviderOptionsForThinkingLevel,
        initialMetadata: {
          autoModelRouting: {
            status: "routed",
            tierId: "hard",
            model: KNOWN_MODELS.SONNET.id,
            requestedFallbackModel: KNOWN_MODELS.SONNET.id,
            thinkingLevel: "low",
          },
        },
        modelFallback: { chain: [fallbackModel], prepare },
      },
      [
        async function* (options) {
          await prepareStep(options, stuckTranscript(), 3);
          // A pending override that never got a next step on the refusing
          // stream: the fallback hop must not silently revert it.
          holder.pending = "high";
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        },
        async function* (options) {
          atFallbackStart = {
            live: sessionSaw.at(-1),
            pending: holder.pending,
            applied: holder.applied,
          };
          // The next raise climbs from the level the fallback runs at, not the
          // refused model's, and the refused model's ceiling no longer retires it.
          await prepareStep(options, longerStuckTranscript(), 6);
          yield* answer();
        },
      ]
    );

    expect(calls).toHaveLength(2);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepareOptions[0]?.thinkingLevelOverride).toBe("high");
    // Pending was folded into the fallback baseline (consumed, kept as applied).
    expect(atFallbackStart.pending).toBeUndefined();
    expect(atFallbackStart.applied).toBe("high");
    // The session learns what the stream runs on now: the fallback model and the level the
    // fallback preparation clamped Auto's claim to.
    expect(atFallbackStart.live).toEqual({
      model: fallbackModel,
      thinkingLevel: "high",
      autoModelRouting: {
        status: "routed",
        tierId: "hard",
        model: fallbackModel,
        requestedFallbackModel: KNOWN_MODELS.SONNET.id,
        thinkingLevel: "high",
      },
    });
    // The swapped request carries the SAME holder and the fallback-bound rebuild closure.
    expect(refusedRebuild).toHaveBeenCalledTimes(1);
    expect(fallbackRebuild.mock.calls.map(([level]) => level)).toEqual(["xhigh"]);
    expect(holder.applied).toBe("xhigh");
  });
});
