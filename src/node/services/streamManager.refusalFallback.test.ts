import { describe, test, expect, mock } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { Ok } from "@/common/types/result";
import { StreamManager, type ModelFallbackPrepareOptions } from "./streamManager";
import type { SessionUsageService } from "./sessionUsageService";
import {
  createStreamManagerForTests,
  engineInternals,
  fakeStreamText,
} from "./streamManager.testHarness";
import {
  installStreamManagerTestHistory,
  historyService,
  createTestLanguageModel,
  appendPartialAssistantForTests,
  createStreamResultForTests,
  createStreamInfoForTests,
} from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

describe("StreamManager - refusal usage attribution", () => {
  test("terminal refusal records the raw Coder identity, not the name-canonical form", async () => {
    // Cross-typed instance {name: "openai", type: "anthropic"}: the refusal
    // path must hand the RAW coder string to usage recording so
    // normalizeUsageModelKey can resolve the instance type — the canonical
    // openai:<claude> form would attribute Anthropic tokens to OpenAI.
    const rawModel = "coder:openai/claude-opus-4-5";
    const providersConfig = {
      coder: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        discoveredProviders: [{ name: "openai", type: "anthropic" }],
      },
    };
    const recordedKeys: string[] = [];
    const sessionUsageService = {
      recordUsage: (_workspaceId: string, model: string) => {
        recordedKeys.push(model);
        return Promise.resolve();
      },
    } as unknown as SessionUsageService;

    const streamManager = new StreamManager(
      historyService,
      sessionUsageService,
      () => providersConfig
    );
    const tryFallback = engineInternals(streamManager).tryModelFallbackAfterRefusal;
    expect(typeof tryFallback).toBe("function");

    const streamInfo = {
      model: rawModel,
      metadataModel: "anthropic:claude-opus-4-5",
      cumulativeUsage: { inputTokens: 1200, outputTokens: 30, totalTokens: 1230 },
      cumulativeProviderMetadata: undefined,
      initialMetadata: undefined,
      stepStartIndices: [0],
      parts: [],
      toolModelUsages: [],
      // No fallback chain: the terminal-refusal recording path runs.
      modelFallback: undefined,
    };

    const outcome = await tryFallback.call(streamManager, "ws-refusal-raw", streamInfo, "refusal");
    expect(outcome.kind).toBe("terminal");
    // The ledger key resolved through instance metadata (type anthropic).
    expect(recordedKeys).toEqual(["anthropic:claude-opus-4-5"]);
  });

  test("zero-usage refused attempt still records a zero-usage hop entry without touching the session ledger", async () => {
    const recordUsage = mock((_workspaceId: string, _model: string, _usage: unknown) =>
      Promise.resolve(undefined)
    );
    const sessionUsageService = { recordUsage } as unknown as SessionUsageService;
    const streamManager = new StreamManager(historyService, sessionUsageService);
    const tryFallback = engineInternals(streamManager).tryModelFallbackAfterRefusal;
    expect(typeof tryFallback).toBe("function");

    const toolModelUsages: Array<{ toolName: string; model: string; usage: unknown }> = [];
    const streamInfo = {
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      // No billed usage anywhere: neither live-tracked nor via streamResult.
      cumulativeUsage: undefined,
      cumulativeProviderMetadata: undefined,
      streamResult: { usage: Promise.resolve(undefined), finalStep: Promise.resolve(undefined) },
      startTime: Date.now(),
      initialMetadata: undefined,
      stepStartIndices: [0],
      parts: [],
      toolModelUsages,
      abortController: { signal: { aborted: false } },
      softInterrupt: { pending: false },
      // Empty chain: the hop is recorded, then the chain exhausts terminally.
      modelFallback: {
        options: { chain: [], prepare: mock(() => Promise.reject(new Error("unused"))) },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    };

    const outcome = await tryFallback.call(
      streamManager,
      "ws-zero-usage-hop",
      streamInfo,
      "refusal"
    );
    expect(outcome.kind).toBe("terminal");

    // The refused attempt is durably recorded with explicit zero usage so
    // analytics counts it, while the session cost ledger stays untouched.
    expect(toolModelUsages).toHaveLength(1);
    expect(toolModelUsages[0]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: KNOWN_MODELS.SONNET.id,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  test("refused attempt entries persist the attribution key, not the raw gateway identity", async () => {
    // Sidecar refused_stream rows are keyed by recordHeadlessUsageLocked's
    // canonical model; a raw mux-gateway identity on committed hop rows would
    // split one model across two analytics buckets in the refusal queries.
    const recordUsage = mock((_workspaceId: string, _model: string, _usage: unknown) =>
      Promise.resolve(undefined)
    );
    const sessionUsageService = { recordUsage } as unknown as SessionUsageService;
    const streamManager = new StreamManager(historyService, sessionUsageService);
    const tryFallback = engineInternals(streamManager).tryModelFallbackAfterRefusal;
    expect(typeof tryFallback).toBe("function");

    const toolModelUsages: Array<{ toolName: string; model: string }> = [];
    const streamInfo = {
      model: "mux-gateway:anthropic/claude-opus-4-5",
      metadataModel: "anthropic:claude-opus-4-5",
      cumulativeUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      cumulativeProviderMetadata: { anthropic: {} },
      startTime: Date.now(),
      initialMetadata: undefined,
      stepStartIndices: [0],
      parts: [],
      toolModelUsages,
      abortController: { signal: { aborted: false } },
      softInterrupt: { pending: false },
      modelFallback: {
        options: { chain: [], prepare: mock(() => Promise.reject(new Error("unused"))) },
        requestedModel: "mux-gateway:anthropic/claude-opus-4-5",
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    };

    const outcome = await tryFallback.call(streamManager, "ws-gateway-hop", streamInfo, "refusal");
    expect(outcome.kind).toBe("terminal");
    expect(toolModelUsages).toHaveLength(1);
    expect(toolModelUsages[0]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: "anthropic:claude-opus-4-5",
    });
  });

  test("sidecar flatten labels refusal hops refused_stream and keeps the drop reason for other usage", async () => {
    const recordHeadlessUsage = mock(
      (
        _workspaceId: string,
        _model: string,
        _usage: unknown,
        _providerMetadata: unknown,
        _options: unknown
      ) => Promise.resolve(undefined)
    );
    const sessionUsageService = { recordHeadlessUsage } as unknown as SessionUsageService;
    const streamManager = new StreamManager(historyService, sessionUsageService);
    const recordDropped = engineInternals(streamManager).recordDroppedPartialUsageInSidecar;
    expect(typeof recordDropped).toBe("function");

    const streamInfo = {
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      toolModelUsages: [
        {
          toolName: "model_fallback_refusal",
          timestamp: 1,
          model: KNOWN_MODELS.SONNET.id,
          metadataModel: KNOWN_MODELS.SONNET.id,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
        {
          toolName: "task",
          timestamp: 2,
          model: KNOWN_MODELS.GPT.id,
          metadataModel: KNOWN_MODELS.GPT.id,
          usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 },
        },
      ],
    };
    const sourcesOf = () =>
      recordHeadlessUsage.mock.calls.map(
        (call) => (call[4] as { analyticsSource?: string }).analyticsSource
      );

    // Aborted turn with a prior refusal hop: the stream's own usage row keeps
    // the abort label (default streamUsageSource), the hop is still a refusal,
    // and unrelated tool usage keeps the drop reason.
    await recordDropped.call(
      streamManager,
      "ws-flatten-aborted",
      streamInfo,
      { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      undefined,
      "aborted_stream"
    );
    expect(sourcesOf()).toEqual(["aborted_stream", "refused_stream", "aborted_stream"]);

    // Terminal-refusal error turn: the stream's own usage row is explicitly
    // labeled refused_stream while non-refusal tool usage stays errored_stream.
    recordHeadlessUsage.mockClear();
    await recordDropped.call(
      streamManager,
      "ws-flatten-refused",
      streamInfo,
      { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      undefined,
      "errored_stream",
      "refused_stream"
    );
    expect(sourcesOf()).toEqual(["refused_stream", "refused_stream", "errored_stream"]);
  });

  test("ledger key uses the stream's pinned metadata identity when instance metadata is gone", async () => {
    // A catalog refresh can remove/retag the instance while the turn is
    // active: the LIVE config no longer resolves coder:prod/<claude>, so a
    // live re-resolution would key the ledger under the raw string while
    // createDisplayUsage priced with the pinned metadataModel — repricing
    // would then strip the row. The stream's record-time metadataModel must
    // key the ledger instead.
    const rawModel = "coder:prod/claude-opus-4-5";
    const recordedKeys: string[] = [];
    const sessionUsageService = {
      recordUsage: (_workspaceId: string, model: string) => {
        recordedKeys.push(model);
        return Promise.resolve();
      },
    } as unknown as SessionUsageService;

    // Live config has NO metadata for the instance (removed mid-turn).
    const streamManager = new StreamManager(historyService, sessionUsageService, () => ({}));
    const recordSessionUsage = engineInternals(streamManager).recordSessionUsage;
    expect(typeof recordSessionUsage).toBe("function");

    await recordSessionUsage.call(
      streamManager,
      "ws-pinned-metadata",
      rawModel,
      { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      undefined,
      "test",
      "warn",
      { metadataModel: "anthropic:claude-opus-4-5" }
    );
    expect(recordedKeys).toEqual(["anthropic:claude-opus-4-5"]);
  });

  test("message metadata preserves the raw Coder identity", () => {
    // WorkspaceStore live deltas and SessionUsageService history rebuilds
    // re-key usage from metadata.model via normalizeUsageModelKey, which
    // needs the raw identity to resolve the instance type — the canonical
    // openai:<claude> form would accumulate under a second, wrongly priced
    // key that diverges from the backend's ledger.
    const streamManager = new StreamManager(historyService);
    const buildPartial = engineInternals(streamManager).buildPartialAssistantMessage;
    expect(typeof buildPartial).toBe("function");

    const message = buildPartial.call(streamManager, {
      messageId: "msg-raw-coder",
      historySequence: 3,
      startTime: Date.now(),
      model: "coder:openai/claude-opus-4-5",
      metadataModel: "anthropic:claude-opus-4-5",
      initialMetadata: undefined,
      stepStartIndices: [0],
      parts: [],
      toolModelUsages: [],
    });
    expect(message.metadata?.model).toBe("coder:openai/claude-opus-4-5");
    // Non-Coder gateway strings still canonicalize for display.
    const canonicalMessage = buildPartial.call(streamManager, {
      messageId: "msg-canonical",
      historySequence: 4,
      startTime: Date.now(),
      model: "mux-gateway:anthropic/claude-opus-4-5",
      metadataModel: "anthropic:claude-opus-4-5",
      initialMetadata: undefined,
      stepStartIndices: [0],
      parts: [],
      toolModelUsages: [],
    });
    expect(canonicalMessage.metadata?.model).toBe("anthropic:claude-opus-4-5");
  });
});

describe("StreamManager - fallback construction callbacks", () => {
  const eligibleProvidersConfig: ProvidersConfigMap = {
    openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
  };

  // The fallback swap must evaluate the fallback's freshly-resolved route
  // (initialMetadataPatch.routeProvider), not the stale source metadata that
  // streamInfo.initialMetadata still holds when the swapped request is built.
  async function runRefusalFallbackForTests(options: {
    workspaceId: string;
    staleRouteProvider: string;
    initialMetadataPatch?: Record<string, unknown>;
    onStreamConstructed?: () => Promise<void>;
    failStreamConstruction?: boolean;
  }): Promise<Record<string, unknown>> {
    const createStreamResult = mock(() => {
      if (options.failStreamConstruction) {
        throw new Error("stream construction failed for tests");
      }
      return createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "fallback answer" };
          yield { type: "finish", finishReason: "stop" };
        })()
      );
    });
    const streamManager = createStreamManagerForTests(historyService, {
      getProvidersConfig: () => eligibleProvidersConfig,
      streamText: fakeStreamText(createStreamResult),
    });

    const messageId = `${options.workspaceId}-message`;
    const historySequence = 1;
    await appendPartialAssistantForTests(options.workspaceId, messageId, historySequence);
    const processStreamWithCleanup = engineInternals(streamManager).processStreamWithCleanup;

    const prepare = mock((nextModelString: string, _options?: ModelFallbackPrepareOptions) =>
      Promise.resolve(
        Ok({
          model: createTestLanguageModel("fallback-model"),
          modelString: nextModelString,
          messages: [],
          system: "You are a helpful assistant",
          tools: undefined,
          thinkingLevel: "off",
          ...(options.initialMetadataPatch
            ? { initialMetadataPatch: options.initialMetadataPatch }
            : {}),
          ...(options.onStreamConstructed
            ? { onStreamConstructed: options.onStreamConstructed }
            : {}),
        })
      )
    );

    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
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
      initialMetadata: { agentId: "plan", routeProvider: options.staleRouteProvider },
      request: { model: createTestLanguageModel(), messages: [], providerOptions: undefined },
      modelFallback: {
        options: { chain: ["openai:gpt-5.6-luna"], prepare },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    });

    await processStreamWithCleanup.call(
      streamManager,
      options.workspaceId,
      streamInfo,
      historySequence
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    return streamInfo.request as Record<string, unknown>;
  }

  test("onStreamConstructed fires after successful construction, never on failure", async () => {
    // Durable side effects hung on this callback (the superseding fallback
    // turn envelope) must describe a stream that exists: called exactly once
    // on success, not at all when createStreamResult throws.
    const onSuccess = mock(() => Promise.resolve());
    await runRefusalFallbackForTests({
      workspaceId: "fallback-envelope-success-workspace",
      staleRouteProvider: "openai",
      onStreamConstructed: onSuccess,
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);

    const onFailure = mock(() => Promise.resolve());
    await runRefusalFallbackForTests({
      workspaceId: "fallback-envelope-failure-workspace",
      staleRouteProvider: "openai",
      onStreamConstructed: onFailure,
      failStreamConstruction: true,
    });
    expect(onFailure).not.toHaveBeenCalled();
  });
});
