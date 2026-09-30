import { describe, test, expect, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { StreamAbortEventSchema } from "@/common/orpc/schemas/stream";
import { Err, Ok } from "@/common/types/result";
import { StreamManager, type TurnEngineEvent, type TurnExecutionOptions } from "./streamManager";
import { SessionUsageService } from "./sessionUsageService";
import { createTestHistoryService } from "./testHistoryService";
import type { HistoryService } from "./historyService";
import { countTokens } from "@/node/utils/main/tokenizer";
import { createStreamManagerForTests } from "./streamManager.testHarness";
import {
  installStreamManagerTestHistory,
  historyService,
  createTestLanguageModel,
  testStartOptions,
  REFUSAL_FINISH,
  STOP_FINISH,
  scriptedStreamText,
  type ScriptedAttempt,
  type ScriptedChunk,
} from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

function finishStep(
  usage: Record<string, number>,
  providerMetadata?: Record<string, unknown>
): Record<string, unknown> {
  return { type: "finish-step", usage, ...(providerMetadata ? { providerMetadata } : {}) };
}

/** Starts a public turn; callers await `completion` (or stop the stream first). */
async function startTurnForTests(
  streamManager: StreamManager,
  options: Partial<TurnExecutionOptions> & { workspaceId: string; messageId: string }
) {
  await appendPlaceholderTurnForTests(
    historyService,
    options.workspaceId,
    options.messageId,
    options.historySequence ?? 1
  );
  const result = await streamManager.startStream(
    testStartOptions({
      model: createTestLanguageModel(),
      modelString: KNOWN_MODELS.SONNET.id,
      providedRuntimeTempDir: "",
      ...options,
    })
  );
  if (!result.success) throw new Error(`Expected stream to start: ${JSON.stringify(result.error)}`);
  return result.data;
}

/**
 * Seeds the turn's placeholder assistant row in the SAME HistoryService the manager writes, so
 * stream end/abort update or delete that pre-seeded row (the suite helper always seeds the
 * module-global instance, which per-test histories never read).
 */
async function appendPlaceholderTurnForTests(
  history: HistoryService,
  workspaceId: string,
  messageId: string,
  historySequence: number
): Promise<void> {
  const appendResult = await history.appendToHistory(workspaceId, {
    id: messageId,
    role: "assistant",
    metadata: { historySequence, partial: true },
    parts: [],
  });
  if (!appendResult.success) throw new Error(appendResult.error);
}

async function readHistoryMessage(history: HistoryService, workspaceId: string, messageId: string) {
  const historyResult = await history.getHistoryFromLatestBoundary(workspaceId);
  if (!historyResult.success) throw new Error(historyResult.error);
  const message = historyResult.data.find((candidate) => candidate.id === messageId);
  if (!message) throw new Error(`Expected message ${messageId} in history`);
  return message;
}

async function readSidecarRecords(
  sessionsDir: string,
  workspaceId: string
): Promise<Array<Record<string, unknown>>> {
  const sidecarPath = path.join(sessionsDir, workspaceId, "headless-usage.jsonl");
  return (await fs.readFile(sidecarPath, "utf-8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The turn's only sidecar row: a duplicate write would double-count the spend. */
async function readSingleSidecarRecord(
  sessionsDir: string,
  workspaceId: string
): Promise<Record<string, unknown>> {
  const records = await readSidecarRecords(sessionsDir, workspaceId);
  expect(records).toHaveLength(1);
  return records[0];
}

describe("StreamManager - TTFT metadata persistence", () => {
  interface ToolModelUsageEventForTests {
    toolName: string;
    toolCallId?: string;
    timestamp: number;
    model: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
    };
    providerMetadata?: Record<string, unknown>;
    metadataModel?: string;
  }

  function readToolModelUsages(message: { metadata?: unknown }): unknown[] | undefined {
    const metadata = message.metadata;
    if (metadata == null || typeof metadata !== "object") {
      return undefined;
    }

    const toolModelUsages = (metadata as Record<string, unknown>).toolModelUsages;
    return Array.isArray(toolModelUsages) ? toolModelUsages : undefined;
  }

  function createToolModelUsageEvent(
    overrides: Partial<ToolModelUsageEventForTests> = {}
  ): ToolModelUsageEventForTests {
    return {
      toolName: overrides.toolName ?? "advisor",
      toolCallId: overrides.toolCallId ?? "tool-call-1",
      timestamp: overrides.timestamp ?? Date.now(),
      model: overrides.model ?? "anthropic:claude-sonnet-4-20250514",
      usage: overrides.usage ?? {
        inputTokens: 40,
        outputTokens: 12,
        totalTokens: 52,
      },
      providerMetadata: overrides.providerMetadata,
      ...(overrides.metadataModel != null ? { metadataModel: overrides.metadataModel } : {}),
    };
  }

  /** Runs one completed turn through startStream and returns its final history row. */
  async function completeTurnAndReadMessage(params: {
    workspaceId: string;
    messageId: string;
    historySequence?: number;
    chunks: ScriptedChunk[];
    usage?: Record<string, number>;
    streamManager?: StreamManager;
    events?: TurnEngineEvent[];
    options?: Partial<TurnExecutionOptions>;
    fallbackAttempts?: ScriptedAttempt[];
  }) {
    const streamManager =
      params.streamManager ??
      createStreamManagerForTests(historyService, {
        eventSink: (event) => {
          params.events?.push(event);
        },
        streamText: scriptedStreamText([
          {
            chunks: params.chunks,
            usage: params.usage ?? { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
          },
          ...(params.fallbackAttempts ?? []),
        ]),
      });
    const handle = await startTurnForTests(streamManager, {
      workspaceId: params.workspaceId,
      messageId: params.messageId,
      historySequence: params.historySequence ?? 1,
      ...params.options,
    });
    expect((await handle.completion).status).toBe("completed");
    return readHistoryMessage(historyService, params.workspaceId, params.messageId);
  }

  const text = (value: string) => ({ type: "text-delta", text: value });
  const reasoning = (value: string) => ({ type: "reasoning-delta", text: value });

  test("persists ttftMs in final assistant metadata when first-token timing is available", async () => {
    const firstTokenDelayMs = 30;
    const turnStartedAt = Date.now();
    const updatedMessage = await completeTurnAndReadMessage({
      workspaceId: "ttft-present-workspace",
      messageId: "ttft-present-message",
      chunks: [
        () => new Promise((resolve) => setTimeout(resolve, firstTokenDelayMs)),
        text("hello"),
        STOP_FINISH,
      ],
    });
    const turnDurationMs = Date.now() - turnStartedAt;

    // Measured from stream start to the first text part: at least the provider's
    // first-token delay, never longer than the whole turn.
    expect(updatedMessage.metadata?.ttftMs).toBeGreaterThanOrEqual(firstTokenDelayMs - 5);
    expect(updatedMessage.metadata?.ttftMs).toBeLessThanOrEqual(turnDurationMs);
  });

  test("omits ttftMs in final assistant metadata when first-token timing is unavailable", async () => {
    const updatedMessage = await completeTurnAndReadMessage({
      workspaceId: "ttft-missing-workspace",
      messageId: "ttft-missing-message",
      chunks: [
        { type: "tool-call", toolCallId: "tool-1", toolName: "bash", input: { script: "echo hi" } },
        { type: "tool-result", toolCallId: "tool-1", toolName: "bash", output: { ok: true } },
        STOP_FINISH,
      ],
    });

    expect(updatedMessage.parts).toMatchObject([
      { type: "dynamic-tool", toolCallId: "tool-1", state: "output-available" },
    ]);
    expect(updatedMessage.metadata?.ttftMs).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(updatedMessage.metadata ?? {}, "ttftMs")).toBe(
      false
    );
  });

  test("persists metadataModel alongside the raw model for analytics pricing", async () => {
    const providersConfigSnapshot: ProvidersConfigMap = {
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "my-gpt4", mappedToModel: "openai:gpt-4" }],
      },
    };
    const updatedMessage = await completeTurnAndReadMessage({
      workspaceId: "metadata-model-workspace",
      messageId: "metadata-model-message",
      chunks: [text("hello"), STOP_FINISH],
      options: { modelString: "openai:my-gpt4", providersConfigSnapshot },
    });

    expect(updatedMessage.metadata?.model).toBe("openai:my-gpt4");
    expect(updatedMessage.metadata?.metadataModel).toBe("openai:gpt-4");
  });

  test("emits and persists routeProvider from initial stream metadata", async () => {
    const events: TurnEngineEvent[] = [];
    const updatedMessage = await completeTurnAndReadMessage({
      workspaceId: "route-provider-workspace",
      messageId: "route-provider-message",
      events,
      chunks: [text("hello"), STOP_FINISH],
      options: {
        initialMetadata: {
          routeProvider: "openrouter",
          routedThroughGateway: true,
        },
      },
    });

    expect(events.find((event) => event.type === "stream-start")).toMatchObject({
      routeProvider: "openrouter",
      routedThroughGateway: true,
    });
    expect(events.find((event) => event.type === "stream-end")).toMatchObject({
      metadata: { routeProvider: "openrouter", routedThroughGateway: true },
    });
    expect(updatedMessage.metadata?.routeProvider).toBe("openrouter");
    expect(updatedMessage.metadata?.routedThroughGateway).toBe(true);
  });

  test("persists per-invocation tool model usages on the final assistant message", async () => {
    const startTime = Date.now() - 1000;
    const firstToolUsage = createToolModelUsageEvent({
      toolName: "advisor",
      toolCallId: "tool-call-1",
      timestamp: startTime + 50,
      model: "openai:gpt-4",
      usage: {
        inputTokens: 60,
        outputTokens: 18,
        totalTokens: 78,
      },
      providerMetadata: { openai: { reasoningTokens: 4 } },
    });
    const secondToolUsage = createToolModelUsageEvent({
      toolName: "advisor",
      toolCallId: "tool-call-2",
      timestamp: startTime + 90,
      model: "openai:gpt-4",
      usage: {
        inputTokens: 30,
        outputTokens: 9,
        totalTokens: 39,
      },
      providerMetadata: { anthropic: { cacheCreationInputTokens: 3 } },
    });

    const workspaceId = "tool-usage-persist-workspace";
    const messageId = "tool-usage-persist-message";
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: scriptedStreamText([
        {
          chunks: [
            () => streamManager.recordToolModelUsage(workspaceId, messageId, firstToolUsage),
            () => streamManager.recordToolModelUsage(workspaceId, messageId, secondToolUsage),
            text("final response"),
            STOP_FINISH,
          ],
        },
      ]),
    });
    const updatedMessage = await completeTurnAndReadMessage({
      workspaceId,
      messageId,
      streamManager,
      chunks: [],
    });

    expect(readToolModelUsages(updatedMessage)).toMatchObject([firstToolUsage, secondToolUsage]);
  });

  test("omits toolModelUsages when the assistant turn has no tool model usage", async () => {
    const updatedMessage = await completeTurnAndReadMessage({
      workspaceId: "tool-usage-empty-workspace",
      messageId: "tool-usage-empty-message",
      chunks: [text("no tool usage here"), STOP_FINISH],
    });

    expect(readToolModelUsages(updatedMessage)).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(updatedMessage.metadata ?? {}, "toolModelUsages")
    ).toBe(false);
  });

  test("scopes tool model usage accumulation to the active assistant turn", async () => {
    const workspaceId = "tool-usage-scope-workspace";
    const firstMessageId = "tool-usage-first-message";
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: scriptedStreamText([
        {
          chunks: [
            () =>
              streamManager.recordToolModelUsage(
                workspaceId,
                firstMessageId,
                createToolModelUsageEvent({
                  toolName: "advisor",
                  toolCallId: "tool-call-first",
                  usage: { inputTokens: 24, outputTokens: 6, totalTokens: 30 },
                })
              ),
            text("first response"),
            STOP_FINISH,
          ],
        },
        {
          chunks: [
            // A late report for the finished first turn must not leak into the second.
            () =>
              streamManager.recordToolModelUsage(
                workspaceId,
                firstMessageId,
                createToolModelUsageEvent({
                  toolName: "advisor",
                  toolCallId: "tool-call-stale",
                  usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
                })
              ),
            text("second response"),
            STOP_FINISH,
          ],
        },
      ]),
    });

    const firstMessage = await completeTurnAndReadMessage({
      workspaceId,
      messageId: firstMessageId,
      streamManager,
      chunks: [],
    });
    expect(readToolModelUsages(firstMessage)).toMatchObject([
      {
        toolName: "advisor",
        toolCallId: "tool-call-first",
      },
    ]);

    const secondMessage = await completeTurnAndReadMessage({
      workspaceId,
      messageId: "tool-usage-second-message",
      historySequence: 2,
      streamManager,
      chunks: [],
    });
    expect(readToolModelUsages(secondMessage)).toBeUndefined();
  });

  describe("StreamManager - reasoning token backfill", () => {
    test("backfills reasoningTokens from concatenated reasoning text when provider reports undefined", async () => {
      const reasoningSegments = ["Thinking through ", "tradeoffs"];
      const expectedReasoningTokens = await countTokens(
        KNOWN_MODELS.SONNET.id,
        reasoningSegments.join("")
      );

      const updatedMessage = await completeTurnAndReadMessage({
        workspaceId: "reasoning-backfill-workspace",
        messageId: "reasoning-backfill-message",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        chunks: [
          reasoning(reasoningSegments[0]),
          reasoning(reasoningSegments[1]),
          text("Final answer"),
          STOP_FINISH,
        ],
      });

      expect(updatedMessage.metadata?.usage?.reasoningTokens).toBe(expectedReasoningTokens);
    });

    test("does not backfill refused-model reasoning under the fallback model", async () => {
      const fallbackReasoning = "Fallback-only reasoning";
      const expectedReasoningTokens = await countTokens(KNOWN_MODELS.GPT.id, fallbackReasoning);

      // The refused model streamed reasoning before refusing; the fallback continues
      // from that partial output, so only the fallback's own reasoning is its usage.
      const updatedMessage = await completeTurnAndReadMessage({
        workspaceId: "reasoning-fallback-boundary-workspace",
        messageId: "reasoning-fallback-boundary-message",
        chunks: [reasoning("Refused-model reasoning"), REFUSAL_FINISH],
        fallbackAttempts: [
          {
            chunks: [reasoning(fallbackReasoning), text("Final answer"), STOP_FINISH],
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          },
        ],
        options: {
          modelFallback: {
            chain: [KNOWN_MODELS.GPT.id],
            prepare: (nextModelString) =>
              Promise.resolve(
                Ok({
                  model: createTestLanguageModel("fallback-model"),
                  modelString: nextModelString,
                  messages: [],
                  system: "system",
                  tools: undefined,
                })
              ),
          },
        },
      });

      expect(updatedMessage.metadata?.model).toBe(KNOWN_MODELS.GPT.id);
      expect(updatedMessage.metadata?.usage?.reasoningTokens).toBe(expectedReasoningTokens);
    });

    test("preserves provider-reported reasoningTokens when present", async () => {
      const updatedMessage = await completeTurnAndReadMessage({
        workspaceId: "reasoning-provider-workspace",
        messageId: "reasoning-provider-message",
        usage: { inputTokens: 100, outputTokens: 250, totalTokens: 350, reasoningTokens: 200 },
        chunks: [
          reasoning("Model-supplied chain of thought"),
          text("Summarized response"),
          STOP_FINISH,
        ],
      });

      expect(updatedMessage.metadata?.usage?.reasoningTokens).toBe(200);
    });

    test("does not inject reasoningTokens when no reasoning deltas occurred", async () => {
      const updatedMessage = await completeTurnAndReadMessage({
        workspaceId: "reasoning-none-workspace",
        messageId: "reasoning-none-message",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        chunks: [text("Only final response"), STOP_FINISH],
      });

      expect(updatedMessage.metadata?.usage?.reasoningTokens).toBeUndefined();
    });
  });
});

describe("StreamManager - aborted stream usage persistence", () => {
  const ABORT_STEP_USAGE = { inputTokens: 120, outputTokens: 30, totalTokens: 150 };

  /**
   * Starts a turn whose provider streams `chunks` and then stays open until aborted;
   * resolves once every chunk was processed, so the caller can stop the stream.
   */
  async function startHeldTurnForTests(params: {
    workspaceId: string;
    messageId: string;
    /** The function form gets the manager, for chunk callbacks that report into the live turn. */
    chunks: ScriptedChunk[] | ((manager: () => StreamManager) => ScriptedChunk[]);
    history?: HistoryService;
    sessionUsageService?: SessionUsageService;
    getProvidersConfig?: () => ProvidersConfigMap | null;
    events?: TurnEngineEvent[];
    options?: Partial<TurnExecutionOptions>;
    fallbackAttempt?: ScriptedAttempt;
  }) {
    const history = params.history ?? historyService;
    const processed = Promise.withResolvers<void>();
    const heldChunks: ScriptedChunk[] = [
      ...(typeof params.chunks === "function" ? params.chunks(() => streamManager) : params.chunks),
      () => processed.resolve(),
    ];
    const streamManager = createStreamManagerForTests(history, {
      sessionUsageService: params.sessionUsageService,
      getProvidersConfig: params.getProvidersConfig,
      eventSink: (event) => {
        params.events?.push(event);
      },
      streamText: scriptedStreamText(
        params.fallbackAttempt
          ? [params.fallbackAttempt, { chunks: heldChunks, holdUntilAbort: true }]
          : [{ chunks: heldChunks, holdUntilAbort: true }]
      ),
    });
    await appendPlaceholderTurnForTests(history, params.workspaceId, params.messageId, 1);
    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId: params.workspaceId,
        messageId: params.messageId,
        model: createTestLanguageModel(),
        modelString: KNOWN_MODELS.SONNET.id,
        providedRuntimeTempDir: "",
        ...params.options,
      })
    );
    if (!result.success) throw new Error("Expected stream to start");
    await processed.promise;
    return { streamManager, completion: result.data.completion };
  }

  const partialText = { type: "text-delta", text: "partial output" };

  test("stamps cumulative usage on the partial so committed history rows stay billable", async () => {
    const workspaceId = "abort-usage-workspace";
    const messageId = "abort-usage-message";
    const { streamManager, completion } = await startHeldTurnForTests({
      workspaceId,
      messageId,
      chunks: [
        partialText,
        finishStep(ABORT_STEP_USAGE, { anthropic: { cacheCreationInputTokens: 42 } }),
      ],
    });

    await streamManager.stopStream(workspaceId, { abortReason: "user" });
    expect((await completion).status).toBe("aborted");

    expect(await historyService.readPartial(workspaceId)).toBeNull();
    const history = await historyService.getLastMessages(workspaceId, 10);
    if (!history.success) throw new Error(history.error);
    const partial = history.data.find((message) => message.id === messageId);
    expect(partial?.metadata?.usage).toMatchObject(ABORT_STEP_USAGE);
    expect(partial?.metadata?.providerMetadata).toEqual({
      anthropic: { cacheCreationInputTokens: 42 },
    });
    expect(partial?.metadata?.contextUsage).toMatchObject(ABORT_STEP_USAGE);
  });

  test("emits the effective fallback model and its pinned pricing identity with aborted usage", async () => {
    // The refused model swaps to a Coder fallback whose prepared request pinned its
    // providers snapshot; the live config no longer knows the instance.
    const effectiveModel = "coder:acme/claude-opus-4-1";
    const pinnedMetadataModel = "anthropic:claude-opus-4-1";
    const fallbackSnapshot: ProvidersConfigMap = {
      coder: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        discoveredProviders: [{ name: "acme", type: "anthropic" }],
      },
    };
    const events: TurnEngineEvent[] = [];
    const { streamManager, completion } = await startHeldTurnForTests({
      workspaceId: "fallback-abort",
      messageId: "fallback-message",
      events,
      getProvidersConfig: () => ({}),
      fallbackAttempt: { chunks: [REFUSAL_FINISH] },
      chunks: [partialText, finishStep(ABORT_STEP_USAGE)],
      options: {
        modelFallback: {
          chain: [effectiveModel],
          prepare: (nextModelString) =>
            Promise.resolve(
              Ok({
                model: createTestLanguageModel("fallback-model"),
                modelString: nextModelString,
                messages: [],
                system: "system",
                tools: undefined,
                providersConfig: fallbackSnapshot,
              })
            ),
        },
      },
    });

    await streamManager.stopStream("fallback-abort", { abortReason: "system" });
    expect((await completion).status).toBe("aborted");
    const event = StreamAbortEventSchema.parse(events.find((e) => e.type === "stream-abort"));
    expect(event.metadata?.model).toBe(effectiveModel);
    expect(event.metadata?.metadataModel).toBe(pinnedMetadataModel);
    expect(event.metadata?.usage?.inputTokens).toBe(120);
  });

  test.each(["commit-err", "commit-throw", "delete-err", "delete-throw"] as const)(
    "abort settles once and retains recovery data on %s",
    async (failure) => {
      const workspaceId = `partial-finalize-${failure}`;
      const messageId = "partial-owner";
      const events: TurnEngineEvent[] = [];
      const { streamManager, completion } = await startHeldTurnForTests({
        workspaceId,
        messageId,
        events,
        chunks: [{ type: "text-delta", text: "recover me" }, finishStep(ABORT_STEP_USAGE)],
      });
      const abandon = failure.startsWith("delete");
      if (abandon) {
        const deletion = spyOn(historyService, "deletePartialIfMessageIdMatches");
        if (failure.endsWith("throw"))
          deletion.mockRejectedValueOnce(new Error("disk unavailable"));
        else deletion.mockResolvedValueOnce(Err("disk unavailable"));
      } else {
        const commit = spyOn(historyService, "commitPartial");
        if (failure.endsWith("throw")) commit.mockRejectedValueOnce(new Error("disk unavailable"));
        else commit.mockResolvedValueOnce(Err("disk unavailable"));
      }
      await streamManager.stopStream(workspaceId, { abortReason: "user", abandonPartial: abandon });
      expect(await completion).toMatchObject({ status: "aborted", abortReason: "user" });
      expect(events.filter((event) => event.type === "stream-abort")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ abortReason: "user", messageId });
      expect(await historyService.readPartial(workspaceId)).not.toBeNull();
    }
  );

  test("identity-checked partial finalization preserves a replacement and empty startup cannot drop it", async () => {
    const workspaceId = "partial-identity";
    await historyService.writePartial(workspaceId, {
      id: "replacement",
      role: "assistant",
      parts: [{ type: "text", text: "replacement answer" }],
      metadata: { historySequence: 1 },
    });
    expect((await historyService.commitPartial(workspaceId, "old")).success).toBe(true);
    expect((await historyService.deletePartialIfMessageIdMatches(workspaceId, "old")).success).toBe(
      true
    );
    const streamManager = new StreamManager(historyService);
    await streamManager.stopStream(workspaceId, { abandonPartial: true });
    expect((await historyService.readPartial(workspaceId))?.id).toBe("replacement");
    expect((await historyService.commitPartial(workspaceId, "replacement")).success).toBe(true);
    expect(await historyService.readPartial(workspaceId)).toBeNull();
    const history = await historyService.getLastMessages(workspaceId, 10);
    if (!history.success) throw new Error(history.error);
    expect(history.data[0]?.id).toBe("replacement");
  });

  test("routes tool-only aborted usage to the headless sidecar (commit would drop it)", async () => {
    // Esc while a tool is still running: the partial's only part is an
    // input-available tool call, which commitPartial refuses to commit —
    // without the sidecar the billed usage would vanish with the partial.
    const { historyService: hs, config, cleanup } = await createTestHistoryService();
    try {
      const sessionUsageService = new SessionUsageService(config, hs);
      const workspaceId = "abort-tool-only-workspace";
      const messageId = "abort-tool-only-message";
      const { streamManager } = await startHeldTurnForTests({
        workspaceId,
        messageId,
        history: hs,
        sessionUsageService,
        chunks: (activeManager) => [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { script: "sleep 60" },
          },
          finishStep({ inputTokens: 500, outputTokens: 0, totalTokens: 500 }),
          // Tool-internal model call reported before the abort: stamped as
          // metadata.toolModelUsages on the partial, which is dropped too.
          () =>
            activeManager().recordToolModelUsage(workspaceId, messageId, {
              toolName: "agent_report",
              timestamp: Date.now(),
              model: KNOWN_MODELS.SONNET.id,
              usage: { inputTokens: 70, outputTokens: 7, totalTokens: 77 },
            }),
        ],
      });

      await streamManager.stopStream(workspaceId, { abortReason: "user" });

      const records = await readSidecarRecords(config.sessionsDir, workspaceId);
      // Parent stream usage AND the tool-internal model call each get a row.
      expect(records).toHaveLength(2);
      expect(records[0].source).toBe("aborted_stream");
      expect((records[0].usage as Record<string, unknown>).inputTokens).toBe(500);
      expect(records[1].source).toBe("aborted_stream");
      expect(records[1].model).toBe(KNOWN_MODELS.SONNET.id);
      expect((records[1].usage as Record<string, unknown>).inputTokens).toBe(70);
    } finally {
      await cleanup();
    }
  });

  test("does not write the sidecar when the aborted partial is commit-worthy", async () => {
    // Text parts commit with usage attached — a sidecar line here would
    // double-count the turn (chat row + headless row).
    const { historyService: hs, config, cleanup } = await createTestHistoryService();
    try {
      const sessionUsageService = new SessionUsageService(config, hs);
      const workspaceId = "abort-commit-worthy-workspace";
      const messageId = "abort-commit-worthy-message";
      const { streamManager } = await startHeldTurnForTests({
        workspaceId,
        messageId,
        history: hs,
        sessionUsageService,
        chunks: [partialText, finishStep(ABORT_STEP_USAGE)],
      });

      await streamManager.stopStream(workspaceId, { abortReason: "user" });

      const sidecarPath = path.join(config.sessionsDir, workspaceId, "headless-usage.jsonl");
      expect(existsSync(sidecarPath)).toBe(false);
      const history = await hs.getLastMessages(workspaceId, 10);
      if (!history.success) throw new Error(history.error);
      expect(
        history.data.find((message) => message.id === messageId)?.metadata?.usage
      ).toBeDefined();
      expect(await hs.readPartial(workspaceId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  /** Runs a turn whose provider fails mid-stream after billing one step. */
  async function runFailingTurnForTests(params: {
    history: HistoryService;
    sessionUsageService: SessionUsageService;
    workspaceId: string;
    messageId: string;
    chunks: ScriptedChunk[];
    error: string;
  }) {
    const streamManager = createStreamManagerForTests(params.history, {
      sessionUsageService: params.sessionUsageService,
      streamText: scriptedStreamText([
        {
          chunks: [
            ...params.chunks,
            () => {
              throw new Error(params.error);
            },
          ],
        },
      ]),
    });
    await appendPlaceholderTurnForTests(params.history, params.workspaceId, params.messageId, 1);
    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId: params.workspaceId,
        messageId: params.messageId,
        model: createTestLanguageModel(),
        modelString: KNOWN_MODELS.SONNET.id,
        providedRuntimeTempDir: "",
      })
    );
    if (!result.success) throw new Error("Expected stream to start");
    expect((await result.data.completion).status).toBe("failed");
  }

  test("routes non-durable errored usage to the headless sidecar (commit would drop it)", async () => {
    // Provider error before any commit-worthy output: the error placeholder is
    // deleted at commit time, so the billed usage must ride the sidecar or the
    // turn never reaches the events table.
    const { historyService: hs, config, cleanup } = await createTestHistoryService();
    try {
      const sessionUsageService = new SessionUsageService(config, hs);
      const workspaceId = "error-nondurable-workspace";
      await runFailingTurnForTests({
        history: hs,
        sessionUsageService,
        workspaceId,
        messageId: "error-nondurable-message",
        chunks: [finishStep({ inputTokens: 900, outputTokens: 0, totalTokens: 900 })],
        error: "provider exploded",
      });

      const record = await readSingleSidecarRecord(config.sessionsDir, workspaceId);
      expect(record.source).toBe("errored_stream");
      expect((record.usage as Record<string, unknown>).inputTokens).toBe(900);
    } finally {
      await cleanup();
    }
  });

  test("errored turns are sidecar-canonical even with commit-worthy parts", async () => {
    // Nothing commits the error partial at error time (AIService forwards
    // "error" without commitPartial), and a retry overwrites it — so usage
    // must ride the sidecar and stay OFF the partial, or the spend strands
    // until an unrelated send (and the eventual commit would double-count).
    const { historyService: hs, config, cleanup } = await createTestHistoryService();
    try {
      const sessionUsageService = new SessionUsageService(config, hs);
      const workspaceId = "error-commit-worthy-workspace";
      await runFailingTurnForTests({
        history: hs,
        sessionUsageService,
        workspaceId,
        messageId: "error-commit-worthy-message",
        chunks: [
          { type: "text-delta", text: "partial answer before failure" },
          finishStep({ inputTokens: 900, outputTokens: 40, totalTokens: 940 }),
        ],
        error: "stream truncated",
      });

      const record = await readSingleSidecarRecord(config.sessionsDir, workspaceId);
      expect(record.source).toBe("errored_stream");
      expect((record.usage as Record<string, unknown>).inputTokens).toBe(900);
      // The partial keeps its content for retry/resume but carries no usage.
      const partial = await hs.readPartial(workspaceId);
      expect(partial?.metadata?.usage).toBeUndefined();
      expect(partial?.parts).toMatchObject([{ type: "text" }]);
    } finally {
      await cleanup();
    }
  });

  test("abandoned aborts skip the partial but route usage to the headless sidecar", async () => {
    // Edit/discard of a streaming turn (abandonPartial=true): the partial and
    // its content are deliberately dropped, so the sidecar is the only route
    // for the billed tokens to reach the events table.
    const { historyService: hs, config, cleanup } = await createTestHistoryService();
    try {
      const sessionUsageService = new SessionUsageService(config, hs);
      const workspaceId = "abort-abandon-workspace";
      const { streamManager } = await startHeldTurnForTests({
        workspaceId,
        messageId: "abort-abandon-message",
        history: hs,
        sessionUsageService,
        chunks: [partialText, finishStep(ABORT_STEP_USAGE)],
      });

      await streamManager.stopStream(workspaceId, { abortReason: "user", abandonPartial: true });

      // Partial untouched (the abandon contract) …
      expect(await hs.readPartial(workspaceId)).toBeNull();
      // … but the billed usage still reaches analytics via the sidecar.
      const record = await readSingleSidecarRecord(config.sessionsDir, workspaceId);
      expect(record.source).toBe("aborted_stream");
      expect((record.usage as Record<string, unknown>).inputTokens).toBe(120);
    } finally {
      await cleanup();
    }
  });
});
