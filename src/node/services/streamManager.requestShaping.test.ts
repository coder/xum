import { describe, test, expect, afterEach, mock, spyOn } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { Ok } from "@/common/types/result";
import type { ToolSearchStreamState } from "@/common/utils/tools/toolCatalog";
import { formatAgentMessageEnvelope } from "@/common/utils/agentMessageEnvelope";
import { formatPlanReviewEnvelope } from "@/common/utils/planReview/planReviewEnvelope";
import type { PlanReviewRecord } from "@/common/utils/planReview/planReviewRecord";
import {
  StreamManager,
  type ModelFallbackPrepareOptions,
  type TurnExecutionOptions,
} from "./streamManager";
import type {
  ActiveTurnThinkingOverride,
  LiveTurnRouting,
  RebuildProviderOptionsForThinkingLevel,
} from "./thinkingOverride";
import {
  createAutoThinkingEscalationState,
  markAutoThinkingEscalationExhausted,
  type AutoThinkingEscalationState,
} from "./autoThinkingEscalation";
import type { AutoModelRoutingEscalation } from "@/common/types/autoModelRouting";
import type { ThinkingLevel } from "@/common/types/thinking";
import * as aiSdk from "ai";
import { tool, type ModelMessage, type Tool, type ToolResultPart } from "ai";
import { z } from "zod";
import * as modelStatsModule from "@/common/utils/tokens/modelStats";
import { createAnthropic } from "@ai-sdk/anthropic";
import {
  createStreamManagerForTests,
  engineInternals,
  fakeStreamText,
  onTurnEngineEvent,
  type StreamRequestConfigForTests,
} from "./streamManager.testHarness";
import {
  installStreamManagerTestHistory,
  historyService,
  createTestLanguageModel,
  LOCAL_TEST_RUNTIME,
  testStartOptions,
  appendPartialAssistantForTests,
  createStreamResultForTests,
  createStreamInfoForTests,
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
  type OverrideRequestForTests = StreamRequestConfigForTests;

  type BuildStreamRequestConfig = (input: Record<string, unknown>) => OverrideRequestForTests;
  type CreateStreamResult = (
    request: OverrideRequestForTests,
    abortController: AbortController,
    stepTracker?: { autoThinkingEscalation?: AutoThinkingEscalationState }
  ) => unknown;
  type CapturedPrepareStep = (options: {
    messages: ModelMessage[];
    stepNumber?: number;
  }) => Promise<
    | {
        messages?: ModelMessage[];
        activeTools?: string[];
        providerOptions?: Record<string, unknown>;
      }
    | undefined
  >;

  const model = createAnthropic({ apiKey: "test" })("claude-sonnet-4-5");
  const messages: ModelMessage[] = [{ role: "user", content: "hello" }];

  function getRequestHelpers(streamManager: StreamManager): {
    buildRequestConfig: BuildStreamRequestConfig;
    createStreamResult: CreateStreamResult;
  } {
    const buildRequestConfig = engineInternals(streamManager).buildStreamRequestConfig;
    const createStreamResultMethod = engineInternals(streamManager).createStreamResult;
    expect(typeof buildRequestConfig).toBe("function");
    expect(typeof createStreamResultMethod).toBe("function");
    if (!buildRequestConfig || !createStreamResultMethod) {
      throw new Error("Expected StreamManager private helpers to exist");
    }
    return {
      buildRequestConfig: (input) => buildRequestConfig.call(streamManager, input),
      createStreamResult: (request, abortController, stepTracker) =>
        createStreamResultMethod.call(streamManager, request, abortController, stepTracker),
    };
  }

  function setupStreamTextSpy() {
    return spyOn(aiSdk, "streamText").mockReturnValue({
      fullStream: (async function* asyncGenerator() {
        yield* [] as unknown[];
        await Promise.resolve();
      })(),
      usage: Promise.resolve(undefined),
      providerMetadata: Promise.resolve(undefined),
      totalUsage: Promise.resolve(undefined),
      steps: Promise.resolve([]),
    } as unknown as ReturnType<typeof aiSdk.streamText>);
  }

  function capturePrepareStep(
    streamTextSpy: ReturnType<typeof setupStreamTextSpy>
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

  test("applies a pending override in place: same object identity, old keys deleted, sink invoked", async () => {
    const streamManager = new StreamManager(historyService);
    const { createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    const appliedLevels: string[] = [];
    const state: ActiveTurnThinkingOverride = {
      pending: "high",
      onApplied: (level) => appliedLevels.push(level),
    };
    const originalProviderOptions: Record<string, unknown> = {
      anthropic: { effort: "low", thinking: { type: "enabled", budgetTokens: 4000 } },
      staleNamespace: { key: "must-be-deleted" },
    };
    const rebuilt = { anthropic: { effort: "high", thinking: { type: "enabled" } } };
    const rebuild = mock((level: string) =>
      level === "high" ? { effectiveLevel: "high" as const, providerOptions: rebuilt } : null
    );

    const request: OverrideRequestForTests = {
      model,
      messages,
      system: "system",
      providerOptions: originalProviderOptions,
      thinkingOverrideState: state,
      rebuildProviderOptionsForThinkingLevel:
        rebuild as unknown as RebuildProviderOptionsForThinkingLevel,
    };
    createStreamResult(request, new AbortController());
    const prepareStep = capturePrepareStep(streamTextSpy);

    const step = await prepareStep({ messages });
    // Rebuilt options are returned for the step (defense in depth) …
    expect(step?.providerOptions).toEqual(rebuilt);
    // … and the live request object is replaced IN PLACE (same identity),
    // deleting keys the SDK's deep-merge could never remove.
    expect(request.providerOptions).toBe(originalProviderOptions);
    expect(request.providerOptions).toEqual(rebuilt);
    expect("staleNamespace" in originalProviderOptions).toBe(false);
    // Consume-once bookkeeping + metadata sink.
    expect(state.pending).toBeUndefined();
    expect(state.applied).toBe("high");
    expect(appliedLevels).toEqual(["high"]);
    // Without a new pending value the next step is a no-op again.
    expect(await prepareStep({ messages })).toBeUndefined();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  test("clears pending without touching options when the rebuild reports not-applicable", async () => {
    const streamManager = new StreamManager(historyService);
    const { createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    const state: ActiveTurnThinkingOverride = { pending: "off" };
    const originalProviderOptions: Record<string, unknown> = { xai: { some: "config" } };
    const rebuild = mock(() => null);

    const request: OverrideRequestForTests = {
      model,
      messages,
      system: "system",
      providerOptions: originalProviderOptions,
      thinkingOverrideState: state,
      rebuildProviderOptionsForThinkingLevel:
        rebuild as unknown as RebuildProviderOptionsForThinkingLevel,
    };
    createStreamResult(request, new AbortController());
    const prepareStep = capturePrepareStep(streamTextSpy);

    expect(await prepareStep({ messages })).toBeUndefined();
    expect(request.providerOptions).toEqual({ xai: { some: "config" } });
    // Consume-once: a skipped application must not retry on every later step.
    expect(state.pending).toBeUndefined();
    expect(state.applied).toBeUndefined();
    expect(await prepareStep({ messages })).toBeUndefined();
    expect(rebuild).toHaveBeenCalledTimes(1);
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

  test("a stuck Auto-set thinking level escalates through the rebuild and records provenance", async () => {
    const streamManager = new StreamManager(historyService);
    const { createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    const state: ActiveTurnThinkingOverride = {};
    const persisted: AutoModelRoutingEscalation[][] = [];
    const stepTracker = {
      autoThinkingEscalation: createAutoThinkingEscalationState("low", [], (escalations) =>
        persisted.push(escalations)
      ),
    };
    const rebuild = mock((level: string) => ({
      effectiveLevel: level as ThinkingLevel,
      providerOptions: { anthropic: { effort: level } },
    }));
    const request: OverrideRequestForTests = {
      model,
      messages,
      system: "system",
      providerOptions: {},
      thinkingOverrideState: state,
      rebuildProviderOptionsForThinkingLevel:
        rebuild as unknown as RebuildProviderOptionsForThinkingLevel,
    };
    createStreamResult(request, new AbortController(), stepTracker);
    const prepareStep = capturePrepareStep(streamTextSpy);

    const transcript = stuckTranscript();
    const step = await prepareStep({ messages: transcript, stepNumber: 3 });
    expect(step?.providerOptions).toEqual({ anthropic: { effort: "medium" } });
    expect(state.applied).toBe("medium");
    expect(persisted.at(-1)).toMatchObject([{ step: 4, from: "low", to: "medium" }]);
    // The judged steps do not fire again, and the user never touched the slider.
    expect(await prepareStep({ messages: transcript, stepNumber: 4 })).toBeUndefined();
    expect(state.manual).toBeUndefined();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  test("a slider move this turn disables Auto's escalation", async () => {
    const streamManager = new StreamManager(historyService);
    const { createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    const state: ActiveTurnThinkingOverride = { manual: true, applied: "off" };
    const persisted: AutoModelRoutingEscalation[][] = [];
    const stepTracker = {
      autoThinkingEscalation: createAutoThinkingEscalationState("low", [], (escalations) =>
        persisted.push(escalations)
      ),
    };
    const rebuild = mock(() => null);
    const request: OverrideRequestForTests = {
      model,
      messages,
      system: "system",
      providerOptions: {},
      thinkingOverrideState: state,
      rebuildProviderOptionsForThinkingLevel:
        rebuild as unknown as RebuildProviderOptionsForThinkingLevel,
    };
    createStreamResult(request, new AbortController(), stepTracker);
    const prepareStep = capturePrepareStep(streamTextSpy);

    expect(await prepareStep({ messages: stuckTranscript(), stepNumber: 3 })).toBeUndefined();
    expect(rebuild).not.toHaveBeenCalled();
    expect(persisted).toEqual([]);
  });

  test("a raise a sparse ladder clamps upward is recorded at the level that applied", async () => {
    const streamManager = new StreamManager(historyService);
    const { createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    const state: ActiveTurnThinkingOverride = {};
    const persisted: AutoModelRoutingEscalation[][] = [];
    const stepTracker = {
      autoThinkingEscalation: createAutoThinkingEscalationState("low", [], (escalations) =>
        persisted.push(escalations)
      ),
    };
    // The model offers only low and high: the requested medium lands on high.
    const rebuild = mock((level: string) => ({
      effectiveLevel: (level === "medium" ? "high" : level) as ThinkingLevel,
      providerOptions: { google: { thinkingLevel: level === "medium" ? "high" : level } },
    }));
    const request: OverrideRequestForTests = {
      model,
      messages,
      system: "system",
      providerOptions: {},
      thinkingOverrideState: state,
      rebuildProviderOptionsForThinkingLevel:
        rebuild as unknown as RebuildProviderOptionsForThinkingLevel,
    };
    createStreamResult(request, new AbortController(), stepTracker);
    const prepareStep = capturePrepareStep(streamTextSpy);

    const step = await prepareStep({ messages: stuckTranscript(), stepNumber: 3 });
    expect(step?.providerOptions).toEqual({ google: { thinkingLevel: "high" } });
    expect(state.applied).toBe("high");
    // Provenance names the level the turn now runs at, and the ladder continues from it.
    expect(persisted.at(-1)).toMatchObject([{ step: 4, from: "low", to: "high" }]);
    expect(stepTracker.autoThinkingEscalation.level).toBe("high");
    expect(stepTracker.autoThinkingEscalation.exhausted).toBe(false);
  });

  test("a raise the model ceiling clamps away is not provenance and ends further attempts", async () => {
    const streamManager = new StreamManager(historyService);
    const { createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    const state: ActiveTurnThinkingOverride = {};
    const persisted: AutoModelRoutingEscalation[][] = [];
    const stepTracker = {
      autoThinkingEscalation: createAutoThinkingEscalationState("high", [], (escalations) =>
        persisted.push(escalations)
      ),
    };
    // The model tops out at high: the rebuild reports the clamped level as a no-op.
    const rebuild = mock(() => null);
    const request: OverrideRequestForTests = {
      model,
      messages,
      system: "system",
      providerOptions: {},
      thinkingOverrideState: state,
      rebuildProviderOptionsForThinkingLevel:
        rebuild as unknown as RebuildProviderOptionsForThinkingLevel,
    };
    createStreamResult(request, new AbortController(), stepTracker);
    const prepareStep = capturePrepareStep(streamTextSpy);

    const transcript = stuckTranscript();
    expect(await prepareStep({ messages: transcript, stepNumber: 3 })).toBeUndefined();
    expect(persisted).toEqual([]);
    expect(stepTracker.autoThinkingEscalation.exhausted).toBe(true);
    // Three more failures would qualify again; the exhausted state stops the retry.
    const longer = [...transcript, ...stuckTranscript().slice(1)];
    expect(await prepareStep({ messages: longer, stepNumber: 6 })).toBeUndefined();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  test("startStream arms escalation only for an Auto-set thinking level, lands raises on the stream-end record, and reports live routing to the session", async () => {
    const raise: AutoModelRoutingEscalation = {
      step: 4,
      from: "low",
      to: "medium",
      reason: "3 consecutive steps with only failing tool calls",
    };
    const armed: Record<string, boolean> = {};
    const sessionSaw: Record<string, LiveTurnRouting[]> = {};
    let active: { workspaceId: string; holder: ActiveTurnThinkingOverride } | undefined;
    // The mocked stream stands in for prepareStep: it reports whether escalation was armed
    // for this stream, fires the provenance sink the way a recorded raise would, and then
    // applies a slider move through the holder when the case asks for one.
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: fakeStreamText(() =>
        createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            if (!active) throw new Error("Expected an active case");
            const tracker = (
              workspaceStreams.get(active.workspaceId) as {
                stepTracker: { autoThinkingEscalation?: AutoThinkingEscalationState };
              }
            ).stepTracker;
            armed[active.workspaceId] = tracker.autoThinkingEscalation != null;
            tracker.autoThinkingEscalation?.onEscalated([raise]);
            if (active.holder.manual) active.holder.onApplied?.("max");
            yield { type: "text-delta", text: "done" };
            yield { type: "finish", finishReason: "stop" };
          })()
        )
      ),
    });
    const workspaceStreams = engineInternals(streamManager).workspaceStreams;
    const streamEnds: Array<{
      metadata?: {
        thinkingLevel?: string;
        autoModelRouting?: { escalations?: unknown; thinkingLevel?: string; tierId?: string };
      };
    }> = [];
    onTurnEngineEvent(streamManager, "stream-end", (data) =>
      streamEnds.push(data as (typeof streamEnds)[number])
    );
    const routed = {
      status: "routed" as const,
      tierId: "hard",
      model: "openai:gpt-4.1-mini",
      requestedFallbackModel: "openai:gpt-4.1-mini",
    };
    const thinkingRouted = { ...routed, thinkingLevel: "low" as const };
    const cases: Array<{
      workspaceId: string;
      autoModelRouting: typeof routed | typeof thinkingRouted;
      holder: ActiveTurnThinkingOverride;
    }> = [
      { workspaceId: "auto-escalation-thinking", autoModelRouting: thinkingRouted, holder: {} },
      { workspaceId: "auto-escalation-model-only", autoModelRouting: routed, holder: {} },
      // The user moved the slider after the raise: Auto's claim (level and raises) is withdrawn.
      {
        workspaceId: "auto-escalation-manual",
        autoModelRouting: thinkingRouted,
        holder: { manual: true },
      },
    ];
    for (const testCase of cases) {
      active = testCase;
      sessionSaw[testCase.workspaceId] = [];
      testCase.holder.onLiveRoutingChanged = (live) => sessionSaw[testCase.workspaceId]?.push(live);
      const messageId = `${testCase.workspaceId}-msg`;
      await appendPartialAssistantForTests(testCase.workspaceId, messageId, 1);
      const result = await streamManager.startStream(
        testStartOptions({
          workspaceId: testCase.workspaceId,
          messageId,
          model: createTestLanguageModel(),
          tools: {},
          thinkingOverrideState: testCase.holder,
          initialMetadata: { autoModelRouting: testCase.autoModelRouting },
          providedRuntimeTempDir: "",
        })
      );
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected stream to start");
      await result.data.completion;
    }

    expect(armed).toEqual({
      "auto-escalation-thinking": true,
      "auto-escalation-model-only": false,
      "auto-escalation-manual": true,
    });
    expect(streamEnds).toHaveLength(3);
    expect(streamEnds[0]?.metadata?.autoModelRouting).toMatchObject({
      thinkingLevel: "low",
      escalations: [raise],
    });
    expect(streamEnds[1]?.metadata?.autoModelRouting?.escalations).toBeUndefined();
    const manual = streamEnds[2]?.metadata;
    expect(manual?.thinkingLevel).toBe("max");
    expect(manual?.autoModelRouting?.tierId).toBe("hard");
    expect(manual?.autoModelRouting?.thinkingLevel).toBeUndefined();
    expect(manual?.autoModelRouting?.escalations).toBeUndefined();
    // The session's live-routing sink saw the same record each change landed on.
    expect(sessionSaw["auto-escalation-thinking"]?.at(-1)?.autoModelRouting).toMatchObject({
      thinkingLevel: "low",
      escalations: [raise],
    });
    expect(sessionSaw["auto-escalation-model-only"]).toEqual([]);
    const manualLive = sessionSaw["auto-escalation-manual"]?.at(-1);
    expect(manualLive?.thinkingLevel).toBe("max");
    expect(manualLive?.autoModelRouting).not.toHaveProperty("thinkingLevel");
    expect(manualLive?.autoModelRouting).not.toHaveProperty("escalations");
  });
  test("buildStreamRequestConfig normalizes providerOptions to a stable mutable object only when a rebuild closure exists", () => {
    const streamManager = new StreamManager(historyService);
    const { buildRequestConfig, createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    const state: ActiveTurnThinkingOverride = {};
    const rebuild: RebuildProviderOptionsForThinkingLevel = () => null;

    // Without the closure, an absent providerOptions stays absent (no behavior change).
    const plainRequest = buildRequestConfig({
      model,
      modelString: KNOWN_MODELS.SONNET.id,
      messages,
      system: "system",
    });
    expect(plainRequest.providerOptions).toBeUndefined();

    // With the closure, undefined normalizes to a mutable object whose identity
    // is exactly what streamText() captures — otherwise in-place mutation at
    // prepareStep time would be unobservable to the SDK's per-step merge.
    const request = buildRequestConfig({
      model,
      modelString: KNOWN_MODELS.SONNET.id,
      messages,
      system: "system",
      // providerOptions intentionally absent
      thinkingOverrideState: state,
      rebuildProviderOptionsForThinkingLevel: rebuild,
    });
    expect(request.providerOptions).toEqual({});
    expect(request.thinkingOverrideState).toBe(state);
    expect(request.rebuildProviderOptionsForThinkingLevel).toBe(rebuild);

    createStreamResult(request, new AbortController());
    const streamTextArgs = streamTextSpy.mock.calls[0]?.[0];
    expect(streamTextArgs?.providerOptions).toBe(
      request.providerOptions as NonNullable<typeof streamTextArgs>["providerOptions"]
    );
  });

  test("model fallback folds the pending override into prepare() and rebinds holder + closure on the swapped request", async () => {
    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "fallback answer" };
          yield { type: "finish", finishReason: "stop" };
        })(),
        { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
      )
    );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: fakeStreamText(createStreamResult),
    });

    const workspaceId = "thinking-fallback-workspace";
    const messageId = "thinking-fallback-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = engineInternals(streamManager).processStreamWithCleanup;

    const fallbackLanguageModel = createTestLanguageModel("fallback-model");
    const fallbackRebuild: RebuildProviderOptionsForThinkingLevel = () => null;
    const prepare = mock((nextModelString: string, options?: ModelFallbackPrepareOptions) => {
      expect(options?.thinkingLevelOverride).toBe("high");
      return Promise.resolve(
        Ok({
          model: fallbackLanguageModel,
          modelString: nextModelString,
          messages: [],
          system: "fallback system",
          tools: undefined,
          thinkingLevel: "high",
          rebuildProviderOptionsForThinkingLevel: fallbackRebuild,
        })
      );
    });

    // Pending override that never got a next step on the refusing stream: the
    // fallback hop must not silently revert it.
    const sessionSaw: LiveTurnRouting[] = [];
    const holder: ActiveTurnThinkingOverride = {
      pending: "high",
      onLiveRoutingChanged: (live) => sessionSaw.push(live),
    };
    // Auto set "low"; the escalation ladder was seeded from it when the refused stream started
    // and the refused model's ceiling already retired it.
    const escalationState = createAutoThinkingEscalationState("low", [], () => undefined);
    markAutoThinkingEscalationExhausted(escalationState);
    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      stepTracker: { autoThinkingEscalation: escalationState },
      initialMetadata: {
        autoModelRouting: {
          status: "routed",
          tierId: "hard",
          model: KNOWN_MODELS.SONNET.id,
          requestedFallbackModel: KNOWN_MODELS.SONNET.id,
          thinkingLevel: "low",
        },
      },
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 10, outputTokens: 0, totalTokens: 10 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      runtime: LOCAL_TEST_RUNTIME,
      request: {
        model: createTestLanguageModel("refused-model"),
        messages: [],
        providerOptions: undefined,
        thinkingOverrideState: holder,
      },
      modelFallback: {
        options: { chain: [fallbackModel], prepare },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(prepare).toHaveBeenCalledTimes(1);
    // Pending was folded into the fallback baseline (consumed, kept as applied
    // for potential second hops).
    expect(holder.pending).toBeUndefined();
    expect(holder.applied).toBe("high");
    // The swapped request carries the SAME holder (the session setter keeps
    // working) and the fallback-bound rebuild closure.
    expect(createStreamResult).toHaveBeenCalledTimes(1);
    // The swap replaces streamInfo.request with the fallback request it streamed.
    const nextRequest = streamInfo.request as OverrideRequestForTests;
    expect(nextRequest?.thinkingOverrideState).toBe(holder);
    expect(nextRequest?.rebuildProviderOptionsForThinkingLevel).toBe(fallbackRebuild);
    // The session learns what the stream runs on now: the fallback model and the level the
    // fallback preparation clamped Auto's claim to.
    expect(sessionSaw.at(-1)).toEqual({
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
    // The next raise climbs from the level the fallback runs at, not the refused model's, and
    // the refused model's ceiling no longer retires it.
    expect(escalationState.level).toBe("high");
    expect(escalationState.exhausted).toBe(false);
  });
});
