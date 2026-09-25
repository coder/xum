import { describe, test, expect, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { StreamAbortEventSchema } from "@/common/orpc/schemas/stream";
import { Err } from "@/common/types/result";
import { StreamManager, type TurnEngineEvent } from "./streamManager";
import { SessionUsageService } from "./sessionUsageService";
import { createTestHistoryService } from "./testHistoryService";
import { countTokens } from "@/node/utils/main/tokenizer";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import {
  createStreamManagerForTests,
  engineInternals,
  onTurnEngineEvent,
} from "./streamManager.testHarness";
import {
  installStreamManagerTestHistory,
  historyService,
  appendPartialAssistantForTests,
  createStreamResultForTests,
  createStreamInfoForTests,
} from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

describe("StreamManager - TTFT metadata persistence", () => {
  const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });

  interface ToolModelUsageEventForTests {
    toolName: string;
    toolCallId?: string;
    timestamp?: number;
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

  function recordToolModelUsageForTests(
    streamManager: StreamManager,
    workspaceId: string,
    messageId: string,
    event: ToolModelUsageEventForTests
  ): void {
    const recordToolModelUsage = engineInternals(streamManager).recordToolModelUsage;
    expect(typeof recordToolModelUsage).toBe("function");
    if (typeof recordToolModelUsage !== "function") {
      throw new Error("Expected StreamManager.recordToolModelUsage to exist");
    }

    recordToolModelUsage.call(streamManager, workspaceId, messageId, event);
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

  async function finalizeStreamAndReadMessage(params: {
    workspaceId: string;
    messageId: string;
    historySequence: number;
    startTime: number;
    parts: unknown[];
    initialMetadata?: Record<string, unknown>;
    emitStartEvent?: boolean;
    onStreamStart?: (event: Record<string, unknown>) => void;
    onStreamEnd?: (event: { metadata?: Record<string, unknown> }) => void;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      reasoningTokens?: number;
    };
    model?: string;
    metadataModel?: string;
    streamManager?: StreamManager;
    beforeProcess?: (params: {
      streamManager: StreamManager;
      workspaceId: string;
      messageId: string;
    }) => Promise<void> | void;
  }) {
    const streamManager = params.streamManager ?? createStreamManagerForTests(historyService);
    // Suppress error events from bubbling up as uncaught exceptions during tests

    if (params.onStreamStart) {
      onTurnEngineEvent(streamManager, "stream-start", params.onStreamStart);
    }
    if (params.onStreamEnd) {
      onTurnEngineEvent(streamManager, "stream-end", params.onStreamEnd);
    }

    await appendPartialAssistantForTests(
      params.workspaceId,
      params.messageId,
      params.historySequence
    );

    const processStreamWithCleanup = engineInternals(streamManager).processStreamWithCleanup;
    const usage = params.usage ?? { inputTokens: 4, outputTokens: 6, totalTokens: 10 };
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          // Tests pre-populate parts but still need the provider's terminal proof of completion.
          await Promise.resolve();
          yield { type: "finish", finishReason: "stop" };
        })(),
        usage
      ),
      messageId: params.messageId,
      startTime: params.startTime,
      lastPartTimestamp: params.startTime,
      model: params.model ?? KNOWN_MODELS.SONNET.id,
      metadataModel: params.metadataModel ?? params.model ?? KNOWN_MODELS.SONNET.id,
      historySequence: params.historySequence,
      initialMetadata: params.initialMetadata,
      parts: params.parts,
      runtime,
    });
    engineInternals(streamManager).workspaceStreams.set(params.workspaceId, streamInfo);

    if (params.beforeProcess) {
      await params.beforeProcess({
        streamManager,
        workspaceId: params.workspaceId,
        messageId: params.messageId,
      });
    }

    if (params.emitStartEvent) {
      const emitStreamStart = engineInternals(streamManager).emitStreamStart;
      emitStreamStart.call(streamManager, params.workspaceId, streamInfo, params.historySequence);
    }

    await processStreamWithCleanup.call(
      streamManager,
      params.workspaceId,
      streamInfo,
      params.historySequence
    );

    const historyResult = await historyService.getHistoryFromLatestBoundary(params.workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(historyResult.error);
    }

    const updatedMessage = historyResult.data.find((message) => message.id === params.messageId);
    expect(updatedMessage).toBeDefined();
    if (!updatedMessage) {
      throw new Error(`Expected updated message ${params.messageId} in history`);
    }

    return updatedMessage;
  }

  test("persists ttftMs in final assistant metadata when first-token timing is available", async () => {
    const startTime = Date.now() - 1000;
    const updatedMessage = await finalizeStreamAndReadMessage({
      workspaceId: "ttft-present-workspace",
      messageId: "ttft-present-message",
      historySequence: 1,
      startTime,
      parts: [
        {
          type: "text",
          text: "hello",
          timestamp: startTime + 250,
        },
      ],
    });

    expect(updatedMessage.metadata?.ttftMs).toBe(250);
  });

  test("omits ttftMs in final assistant metadata when first-token timing is unavailable", async () => {
    const startTime = Date.now() - 1000;
    const updatedMessage = await finalizeStreamAndReadMessage({
      workspaceId: "ttft-missing-workspace",
      messageId: "ttft-missing-message",
      historySequence: 1,
      startTime,
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-1",
          toolName: "bash",
          state: "output-available",
          input: { script: "echo hi" },
          output: { ok: true },
          timestamp: startTime + 100,
        },
      ],
    });

    expect(updatedMessage.metadata?.ttftMs).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(updatedMessage.metadata ?? {}, "ttftMs")).toBe(
      false
    );
  });

  test("persists metadataModel alongside the raw model for analytics pricing", async () => {
    const updatedMessage = await finalizeStreamAndReadMessage({
      workspaceId: "metadata-model-workspace",
      messageId: "metadata-model-message",
      historySequence: 1,
      startTime: Date.now() - 1000,
      model: "openai:my-gpt4",
      metadataModel: "openai:gpt-4",
      parts: [
        {
          type: "text",
          text: "hello",
          timestamp: Date.now(),
        },
      ],
    });

    expect(updatedMessage.metadata?.model).toBe("openai:my-gpt4");
    expect(updatedMessage.metadata?.metadataModel).toBe("openai:gpt-4");
  });

  test("emits and persists routeProvider from initial stream metadata", async () => {
    const startTime = Date.now() - 1000;
    let streamStartEvent: Record<string, unknown> | undefined;
    let streamEndEvent: { metadata?: Record<string, unknown> } | undefined;

    const updatedMessage = await finalizeStreamAndReadMessage({
      workspaceId: "route-provider-workspace",
      messageId: "route-provider-message",
      historySequence: 1,
      startTime,
      initialMetadata: {
        routeProvider: "openrouter",
        routedThroughGateway: true,
      },
      emitStartEvent: true,
      onStreamStart: (event) => {
        streamStartEvent = event;
      },
      onStreamEnd: (event) => {
        streamEndEvent = event;
      },
      parts: [
        {
          type: "text",
          text: "hello",
          timestamp: startTime + 100,
        },
      ],
    });

    expect(streamStartEvent).toMatchObject({
      routeProvider: "openrouter",
      routedThroughGateway: true,
    });
    expect(streamEndEvent?.metadata).toMatchObject({
      routeProvider: "openrouter",
      routedThroughGateway: true,
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

    const updatedMessage = await finalizeStreamAndReadMessage({
      workspaceId: "tool-usage-persist-workspace",
      messageId: "tool-usage-persist-message",
      historySequence: 1,
      startTime,
      beforeProcess: ({ streamManager, workspaceId, messageId }) => {
        recordToolModelUsageForTests(streamManager, workspaceId, messageId, firstToolUsage);
        recordToolModelUsageForTests(streamManager, workspaceId, messageId, secondToolUsage);
      },
      parts: [
        {
          type: "text",
          text: "final response",
          timestamp: startTime + 200,
        },
      ],
    });

    expect(readToolModelUsages(updatedMessage)).toMatchObject([firstToolUsage, secondToolUsage]);
  });

  test("omits toolModelUsages when the assistant turn has no tool model usage", async () => {
    const startTime = Date.now() - 1000;
    const updatedMessage = await finalizeStreamAndReadMessage({
      workspaceId: "tool-usage-empty-workspace",
      messageId: "tool-usage-empty-message",
      historySequence: 1,
      startTime,
      parts: [
        {
          type: "text",
          text: "no tool usage here",
          timestamp: startTime + 150,
        },
      ],
    });

    expect(readToolModelUsages(updatedMessage)).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(updatedMessage.metadata ?? {}, "toolModelUsages")
    ).toBe(false);
  });

  test("scopes tool model usage accumulation to the active assistant turn", async () => {
    const workspaceId = "tool-usage-scope-workspace";
    const streamManager = createStreamManagerForTests(historyService);
    const firstStartTime = Date.now() - 2000;
    const firstMessage = await finalizeStreamAndReadMessage({
      workspaceId,
      messageId: "tool-usage-first-message",
      historySequence: 1,
      startTime: firstStartTime,
      streamManager,
      beforeProcess: ({ streamManager: activeStreamManager, workspaceId, messageId }) => {
        recordToolModelUsageForTests(
          activeStreamManager,
          workspaceId,
          messageId,
          createToolModelUsageEvent({
            toolName: "advisor",
            toolCallId: "tool-call-first",
            timestamp: firstStartTime + 25,
            model: "anthropic:claude-sonnet-4-20250514",
            usage: {
              inputTokens: 24,
              outputTokens: 6,
              totalTokens: 30,
            },
          })
        );
      },
      parts: [
        {
          type: "text",
          text: "first response",
          timestamp: firstStartTime + 100,
        },
      ],
    });

    expect(readToolModelUsages(firstMessage)).toMatchObject([
      {
        toolName: "advisor",
        toolCallId: "tool-call-first",
      },
    ]);

    const secondMessage = await finalizeStreamAndReadMessage({
      workspaceId,
      messageId: "tool-usage-second-message",
      historySequence: 2,
      startTime: firstStartTime + 500,
      streamManager,
      beforeProcess: ({ streamManager: activeStreamManager, workspaceId }) => {
        recordToolModelUsageForTests(
          activeStreamManager,
          workspaceId,
          "tool-usage-first-message",
          createToolModelUsageEvent({
            toolName: "advisor",
            toolCallId: "tool-call-stale",
            timestamp: firstStartTime + 525,
            model: "anthropic:claude-sonnet-4-20250514",
            usage: {
              inputTokens: 12,
              outputTokens: 3,
              totalTokens: 15,
            },
          })
        );
      },
      parts: [
        {
          type: "text",
          text: "second response",
          timestamp: firstStartTime + 700,
        },
      ],
    });

    expect(readToolModelUsages(secondMessage)).toBeUndefined();
  });

  describe("StreamManager - reasoning token backfill", () => {
    test("backfills reasoningTokens from concatenated reasoning text when provider reports undefined", async () => {
      const startTime = Date.now() - 1000;
      const reasoningSegments = ["Thinking through ", "tradeoffs"];
      const expectedReasoningTokens = await countTokens(
        KNOWN_MODELS.SONNET.id,
        reasoningSegments.join("")
      );

      const updatedMessage = await finalizeStreamAndReadMessage({
        workspaceId: "reasoning-backfill-workspace",
        messageId: "reasoning-backfill-message",
        historySequence: 1,
        startTime,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        parts: [
          {
            type: "reasoning",
            text: reasoningSegments[0],
            timestamp: startTime + 100,
          },
          {
            type: "reasoning",
            text: reasoningSegments[1],
            timestamp: startTime + 150,
          },
          {
            type: "text",
            text: "Final answer",
            timestamp: startTime + 200,
          },
        ],
      });

      expect(updatedMessage.metadata?.usage?.reasoningTokens).toBe(expectedReasoningTokens);
    });

    test("does not backfill refused-model reasoning under the fallback model", async () => {
      const startTime = Date.now() - 1000;
      const fallbackReasoning = "Fallback-only reasoning";
      const expectedReasoningTokens = await countTokens(KNOWN_MODELS.GPT.id, fallbackReasoning);

      const updatedMessage = await finalizeStreamAndReadMessage({
        workspaceId: "reasoning-fallback-boundary-workspace",
        messageId: "reasoning-fallback-boundary-message",
        historySequence: 1,
        startTime,
        model: KNOWN_MODELS.GPT.id,
        metadataModel: KNOWN_MODELS.GPT.id,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        parts: [
          {
            type: "reasoning",
            text: "Refused-model reasoning",
            timestamp: startTime + 100,
          },
          {
            type: "reasoning",
            text: fallbackReasoning,
            timestamp: startTime + 150,
          },
          {
            type: "text",
            text: "Final answer",
            timestamp: startTime + 200,
          },
        ],
        beforeProcess: ({ streamManager, workspaceId }) => {
          const streamInfo = engineInternals(streamManager).workspaceStreams.get(workspaceId);
          expect(streamInfo && typeof streamInfo === "object").toBe(true);
          if (!streamInfo || typeof streamInfo !== "object") {
            throw new Error("Expected stream info for reasoning fallback boundary test");
          }
          (streamInfo as { reasoningBackfillStartIndex?: number }).reasoningBackfillStartIndex = 1;
        },
      });

      expect(updatedMessage.metadata?.usage?.reasoningTokens).toBe(expectedReasoningTokens);
    });

    test("preserves provider-reported reasoningTokens when present", async () => {
      const startTime = Date.now() - 1000;
      const updatedMessage = await finalizeStreamAndReadMessage({
        workspaceId: "reasoning-provider-workspace",
        messageId: "reasoning-provider-message",
        historySequence: 1,
        startTime,
        usage: { inputTokens: 100, outputTokens: 250, totalTokens: 350, reasoningTokens: 200 },
        parts: [
          {
            type: "reasoning",
            text: "Model-supplied chain of thought",
            timestamp: startTime + 150,
          },
          {
            type: "text",
            text: "Summarized response",
            timestamp: startTime + 300,
          },
        ],
      });

      expect(updatedMessage.metadata?.usage?.reasoningTokens).toBe(200);
    });

    test("does not inject reasoningTokens when no reasoning deltas occurred", async () => {
      const startTime = Date.now() - 1000;
      const updatedMessage = await finalizeStreamAndReadMessage({
        workspaceId: "reasoning-none-workspace",
        messageId: "reasoning-none-message",
        historySequence: 1,
        startTime,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        parts: [
          {
            type: "text",
            text: "Only final response",
            timestamp: startTime + 200,
          },
        ],
      });

      expect(updatedMessage.metadata?.usage?.reasoningTokens).toBeUndefined();
    });
  });
});

describe("StreamManager - aborted stream usage persistence", () => {
  function createAbortStreamInfo(messageId: string): Record<string, unknown> {
    const usage = { inputTokens: 120, outputTokens: 30, totalTokens: 150 };
    return createStreamInfoForTests({
      messageId,
      parts: [{ type: "text", text: "partial output", timestamp: Date.now() }],
      cumulativeUsage: usage,
      cumulativeProviderMetadata: { anthropic: { cacheCreationInputTokens: 42 } },
      lastStepUsage: usage,
    });
  }

  test("stamps cumulative usage on the partial so committed history rows stay billable", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "abort-usage-workspace";
    const messageId = "abort-usage-message";
    await appendPartialAssistantForTests(workspaceId, messageId, 1);

    const cleanupAborted = engineInternals(streamManager).cleanupAbortedStream;
    await cleanupAborted.call(streamManager, workspaceId, createAbortStreamInfo(messageId), "user");

    expect(await historyService.readPartial(workspaceId)).toBeNull();
    const history = await historyService.getLastMessages(workspaceId, 10);
    if (!history.success) throw new Error(history.error);
    const partial = history.data.find((message) => message.id === messageId);
    expect(partial?.metadata?.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    });
    expect(partial?.metadata?.providerMetadata).toEqual({
      anthropic: { cacheCreationInputTokens: 42 },
    });
    expect(partial?.metadata?.contextUsage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    });
  });

  test("emits the effective fallback model and its pinned pricing identity with aborted usage", async () => {
    const streamManager = new StreamManager(historyService);
    const effectiveModel = "coder:acme/opus";
    const pinnedMetadataModel = "anthropic:claude-opus-4-1";
    const abort = Promise.withResolvers<unknown>();
    onTurnEngineEvent(streamManager, "stream-abort", (event) => abort.resolve(event));
    const cleanupAborted = engineInternals(streamManager).cleanupAbortedStream;
    await cleanupAborted.call(
      streamManager,
      "fallback-abort",
      {
        ...createAbortStreamInfo("fallback-message"),
        model: effectiveModel,
        metadataModel: pinnedMetadataModel,
      },
      "system"
    );
    const event = StreamAbortEventSchema.parse(await abort.promise);
    expect(event.metadata?.model).toBe(effectiveModel);
    expect(event.metadata?.metadataModel).toBe(pinnedMetadataModel);
    expect(event.metadata?.usage?.inputTokens).toBe(120);
  });

  test.each(["commit-err", "commit-throw", "delete-err", "delete-throw"] as const)(
    "abort settles once and retains recovery data on %s",
    async (failure) => {
      const workspaceId = `partial-finalize-${failure}`;
      const messageId = "partial-owner";
      const info = createAbortStreamInfo(messageId);
      await historyService.writePartial(workspaceId, {
        id: messageId,
        role: "assistant",
        parts: [{ type: "text", text: "recover me" }],
        metadata: { historySequence: 1 },
      });
      const events: TurnEngineEvent[] = [];
      const streamManager = new StreamManager(historyService, undefined, undefined, (event) => {
        events.push(event);
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
      const cleanupAborted = engineInternals(streamManager).cleanupAbortedStream;
      await cleanupAborted.call(streamManager, workspaceId, info, "user", abandon);
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
      const streamManager = new StreamManager(hs, sessionUsageService);
      const workspaceId = "abort-tool-only-workspace";

      const usage = { inputTokens: 500, outputTokens: 0, totalTokens: 500 };
      const streamInfo = createStreamInfoForTests({
        messageId: "abort-tool-only-message",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call-1",
            toolName: "bash",
            input: { script: "sleep 60" },
            state: "input-available",
            timestamp: Date.now(),
          },
        ],
        cumulativeUsage: usage,
        lastStepUsage: usage,
        // Tool-internal model call reported before the abort: stamped as
        // metadata.toolModelUsages on the partial, which is dropped too.
        toolModelUsages: [
          {
            toolName: "agent_report",
            model: KNOWN_MODELS.SONNET.id,
            usage: { inputTokens: 70, outputTokens: 7, totalTokens: 77 },
          },
        ],
      });

      const cleanupAborted = engineInternals(streamManager).cleanupAbortedStream;
      await cleanupAborted.call(streamManager, workspaceId, streamInfo, "user");

      const sidecarPath = path.join(
        path.join(config.sessionsDir, workspaceId),
        "headless-usage.jsonl"
      );
      const records = (await fs.readFile(sidecarPath, "utf-8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
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
      const streamManager = new StreamManager(hs, sessionUsageService);
      const workspaceId = "abort-commit-worthy-workspace";
      await appendPartialAssistantForTests(workspaceId, "abort-commit-worthy-message", 1);

      const cleanupAborted = engineInternals(streamManager).cleanupAbortedStream;
      await cleanupAborted.call(
        streamManager,
        workspaceId,
        createAbortStreamInfo("abort-commit-worthy-message"),
        "user"
      );

      const sidecarPath = path.join(
        path.join(config.sessionsDir, workspaceId),
        "headless-usage.jsonl"
      );
      expect(existsSync(sidecarPath)).toBe(false);
      const history = await hs.getLastMessages(workspaceId, 10);
      if (!history.success) throw new Error(history.error);
      expect(
        history.data.find((message) => message.id === "abort-commit-worthy-message")?.metadata
          ?.usage
      ).toBeDefined();
      expect(await hs.readPartial(workspaceId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("routes non-durable errored usage to the headless sidecar (commit would drop it)", async () => {
    // Provider/empty-output error before any commit-worthy output: the error
    // placeholder is deleted at commit time, so the billed usage must ride
    // the sidecar or the turn never reaches the events table.
    const { historyService: hs, config, cleanup } = await createTestHistoryService();
    try {
      const sessionUsageService = new SessionUsageService(config, hs);
      const streamManager = new StreamManager(hs, sessionUsageService);
      const workspaceId = "error-nondurable-workspace";

      const usage = { inputTokens: 900, outputTokens: 0, totalTokens: 900 };
      const streamInfo = createStreamInfoForTests({
        messageId: "error-nondurable-message",
        parts: [],
        cumulativeUsage: usage,
        lastStepUsage: usage,
      });

      const persistError = engineInternals(streamManager).persistStreamError;
      await persistError.call(streamManager, workspaceId, streamInfo, {
        messageId: "error-nondurable-message",
        error: "provider exploded",
        errorType: "empty_output",
      });

      const sidecarPath = path.join(
        path.join(config.sessionsDir, workspaceId),
        "headless-usage.jsonl"
      );
      const record = JSON.parse((await fs.readFile(sidecarPath, "utf-8")).trim()) as Record<
        string,
        unknown
      >;
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
      const streamManager = new StreamManager(hs, sessionUsageService);
      const workspaceId = "error-commit-worthy-workspace";

      const usage = { inputTokens: 900, outputTokens: 40, totalTokens: 940 };
      const streamInfo = createStreamInfoForTests({
        messageId: "error-commit-worthy-message",
        parts: [{ type: "text", text: "partial answer before failure", timestamp: Date.now() }],
        cumulativeUsage: usage,
        lastStepUsage: usage,
      });

      const persistError = engineInternals(streamManager).persistStreamError;
      await persistError.call(streamManager, workspaceId, streamInfo, {
        messageId: "error-commit-worthy-message",
        error: "stream truncated",
        errorType: "stream_truncated",
      });

      const sidecarPath = path.join(
        path.join(config.sessionsDir, workspaceId),
        "headless-usage.jsonl"
      );
      const record = JSON.parse((await fs.readFile(sidecarPath, "utf-8")).trim()) as Record<
        string,
        unknown
      >;
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
      const streamManager = new StreamManager(hs, sessionUsageService);
      const workspaceId = "abort-abandon-workspace";
      const messageId = "abort-abandon-message";

      const cleanupAborted = engineInternals(streamManager).cleanupAbortedStream;
      await cleanupAborted.call(
        streamManager,
        workspaceId,
        createAbortStreamInfo(messageId),
        "user",
        true
      );

      // Partial untouched (the abandon contract) …
      const partial = await hs.readPartial(workspaceId);
      expect(partial).toBeNull();
      // … but the billed usage still reaches analytics via the sidecar.
      const sidecarPath = path.join(
        path.join(config.sessionsDir, workspaceId),
        "headless-usage.jsonl"
      );
      const record = JSON.parse((await fs.readFile(sidecarPath, "utf-8")).trim()) as Record<
        string,
        unknown
      >;
      expect(record.source).toBe("aborted_stream");
      expect((record.usage as Record<string, unknown>).inputTokens).toBe(120);
    } finally {
      await cleanup();
    }
  });
});
