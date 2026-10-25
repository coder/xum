import { describe, test, expect, mock } from "bun:test";
import { tool, type ToolExecutionOptions } from "ai";
import { z } from "zod";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { Err, Ok } from "@/common/types/result";
import type { ThinkingLevel } from "@/common/types/thinking";
import {
  DEFAULT_MODEL_FALLBACKS,
  resolveModelFallbackChain,
} from "@/common/utils/ai/modelFallbacks";
import type {
  ModelFallbackOptions,
  ModelFallbackPrepareOptions,
  StreamManager,
} from "./streamManager";
import { attachLanguageModelCleanup } from "./languageModelCleanup";
import type { SessionUsageService } from "./sessionUsageService";
import {
  createStreamManagerForTests,
  fakeStreamText,
  onTurnEngineEvent,
} from "./streamManager.testHarness";
import {
  installStreamManagerTestHistory,
  historyService,
  createTestLanguageModel,
  REFUSAL_FINISH,
  STOP_FINISH,
  runTurnForTests,
  scriptedStreamText,
  type ScriptedAttempt,
} from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

/** These attempts bill nothing unless they say so. */
const NO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/** A one-hop chain whose fallback cannot start: the refused hop is recorded, then the turn fails. */
function unstartableFallback(): ModelFallbackOptions {
  return {
    chain: ["openai:gpt-5.6-luna"],
    prepare: () => Promise.reject(new Error("fallback unavailable")),
  };
}

function preparedFallback(
  overrides: { onStreamConstructed?: () => Promise<void> } = {}
): ModelFallbackOptions & { prepare: ReturnType<typeof mock> } {
  const prepare = mock((nextModelString: string, _options?: ModelFallbackPrepareOptions) =>
    Promise.resolve(
      Ok({
        model: createTestLanguageModel("fallback-model"),
        modelString: nextModelString,
        messages: [],
        system: "You are a helpful assistant",
        tools: undefined,
        thinkingLevel: "off" as const,
        ...overrides,
      })
    )
  );
  return { chain: ["openai:gpt-5.6-luna"], prepare };
}

function createUsageRecorder() {
  const recordUsage = mock((_workspaceId: string, _model: string, _usage: unknown) =>
    Promise.resolve(undefined)
  );
  const recordHeadlessUsage = mock(
    (
      _workspaceId: string,
      _model: string,
      _usage: unknown,
      _providerMetadata: unknown,
      _options: { analyticsSource?: string }
    ) => Promise.resolve(undefined)
  );
  return {
    recordUsage,
    recordHeadlessUsage,
    sessionUsageService: { recordUsage, recordHeadlessUsage } as unknown as SessionUsageService,
    ledgerKeys: () => recordUsage.mock.calls.map((call) => call[1]),
    sidecarRows: () =>
      recordHeadlessUsage.mock.calls.map((call) => ({
        model: call[1],
        usage: call[2],
        source: call[4].analyticsSource,
      })),
  };
}

describe("StreamManager - refusal usage attribution", () => {
  test("terminal refusal records the raw Coder identity, not the name-canonical form", async () => {
    // Cross-typed instance {name: "openai", type: "anthropic"}: the refusal
    // path must hand the RAW coder string to usage recording so
    // normalizeUsageModelKey can resolve the instance type — the canonical
    // openai:<claude> form would attribute Anthropic tokens to OpenAI.
    const providersConfig: ProvidersConfigMap = {
      coder: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        discoveredProviders: [{ name: "openai", type: "anthropic" }],
      },
    };
    const usage = createUsageRecorder();
    const streamManager = createStreamManagerForTests(historyService, {
      sessionUsageService: usage.sessionUsageService,
      getProvidersConfig: () => providersConfig,
      streamText: scriptedStreamText([
        {
          chunks: [REFUSAL_FINISH],
          usage: { inputTokens: 1200, outputTokens: 30, totalTokens: 1230 },
        },
      ]),
    });

    // No fallback chain: the terminal-refusal recording path runs.
    const { completion } = await runTurnForTests(streamManager, {
      workspaceId: "ws-refusal-raw",
      modelString: "coder:openai/claude-opus-4-5",
    });
    expect(completion.status).toBe("failed");
    // The ledger key resolved through instance metadata (type anthropic).
    expect(usage.ledgerKeys()).toEqual(["anthropic:claude-opus-4-5"]);
  });

  test("zero-usage refused attempt still records a zero-usage hop entry without touching the session ledger", async () => {
    const usage = createUsageRecorder();
    const streamManager = createStreamManagerForTests(historyService, {
      sessionUsageService: usage.sessionUsageService,
      // No billed usage anywhere: neither live-tracked nor via streamResult.
      streamText: scriptedStreamText([{ chunks: [REFUSAL_FINISH], usage: NO_USAGE }]),
    });

    const { completion } = await runTurnForTests(streamManager, {
      workspaceId: "ws-zero-usage-hop",
      modelString: KNOWN_MODELS.SONNET.id,
      modelFallback: unstartableFallback(),
    });
    expect(completion.status).toBe("failed");

    // The refused attempt is durably recorded with explicit zero usage so
    // analytics counts it (as the dropped error turn's refused_stream sidecar
    // row), while the session cost ledger stays untouched.
    expect(usage.sidecarRows()).toEqual([
      {
        model: KNOWN_MODELS.SONNET.id,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        source: "refused_stream",
      },
    ]);
    expect(usage.recordUsage).not.toHaveBeenCalled();
  });

  test("refused attempt entries persist the attribution key, not the raw gateway identity", async () => {
    // Sidecar refused_stream rows are keyed by recordHeadlessUsageLocked's
    // canonical model; a raw gateway identity on committed hop rows would
    // split one model across two analytics buckets in the refusal queries.
    const usage = createUsageRecorder();
    const streamManager = createStreamManagerForTests(historyService, {
      sessionUsageService: usage.sessionUsageService,
      streamText: scriptedStreamText([
        {
          chunks: [REFUSAL_FINISH],
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          providerMetadata: { anthropic: {} },
        },
      ]),
    });

    const { completion } = await runTurnForTests(streamManager, {
      workspaceId: "ws-gateway-hop",
      modelString: "openrouter:anthropic/claude-opus-4-5",
      modelFallback: unstartableFallback(),
    });
    expect(completion.status).toBe("failed");
    expect(usage.sidecarRows()).toMatchObject([
      { model: "anthropic:claude-opus-4-5", source: "refused_stream" },
    ]);
  });

  test("sidecar flatten labels refusal hops refused_stream and keeps the drop reason for other usage", async () => {
    const taskUsage = {
      toolName: "task",
      timestamp: 2,
      model: KNOWN_MODELS.GPT.id,
      metadataModel: KNOWN_MODELS.GPT.id,
      usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 },
    };
    const stepUsage = {
      type: "finish-step",
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    };

    // Aborted (abandoned) fallback turn after a refusal hop: the stream's own
    // usage row keeps the abort label, the hop is still a refusal, and
    // unrelated tool usage keeps the drop reason.
    const aborted = createUsageRecorder();
    const abortedWorkspaceId = "ws-flatten-aborted";
    const toolUsageRecorded = Promise.withResolvers<void>();
    const abortedManager: StreamManager = createStreamManagerForTests(historyService, {
      sessionUsageService: aborted.sessionUsageService,
      streamText: scriptedStreamText([
        { chunks: [REFUSAL_FINISH], usage: NO_USAGE },
        {
          chunks: [
            stepUsage,
            () => {
              abortedManager.recordToolModelUsage(
                abortedWorkspaceId,
                `${abortedWorkspaceId}-message`,
                taskUsage
              );
              toolUsageRecorded.resolve();
            },
          ],
          usage: NO_USAGE,
          holdUntilAbort: true,
        },
      ]),
    });
    const abortedTurn = runTurnForTests(abortedManager, {
      workspaceId: abortedWorkspaceId,
      modelString: KNOWN_MODELS.SONNET.id,
      modelFallback: preparedFallback(),
    });
    await toolUsageRecorded.promise;
    await abortedManager.stopStream(abortedWorkspaceId, { abandonPartial: true });
    expect((await abortedTurn).completion.status).toBe("aborted");
    expect(aborted.sidecarRows().map((row) => row.source)).toEqual([
      "aborted_stream",
      "refused_stream",
      "aborted_stream",
    ]);

    // Terminal-refusal error turn: the stream's own usage row is explicitly
    // labeled refused_stream while non-refusal tool usage stays errored_stream.
    const refused = createUsageRecorder();
    const refusedWorkspaceId = "ws-flatten-refused";
    const refusedManager: StreamManager = createStreamManagerForTests(historyService, {
      sessionUsageService: refused.sessionUsageService,
      streamText: scriptedStreamText([
        {
          chunks: [
            () =>
              refusedManager.recordToolModelUsage(
                refusedWorkspaceId,
                `${refusedWorkspaceId}-message`,
                taskUsage
              ),
            REFUSAL_FINISH,
          ],
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        },
      ]),
    });
    const { completion } = await runTurnForTests(refusedManager, {
      workspaceId: refusedWorkspaceId,
      modelString: KNOWN_MODELS.SONNET.id,
    });
    expect(completion.status).toBe("failed");
    expect(refused.sidecarRows().map((row) => row.source)).toEqual([
      "refused_stream",
      "errored_stream",
    ]);
  });

  test("ledger key uses the stream's pinned metadata identity when instance metadata is gone", async () => {
    // A catalog refresh can remove/retag the instance while the turn is
    // active: the LIVE config no longer resolves coder:prod/<claude>, so a
    // live re-resolution would key the ledger under the raw string while
    // createDisplayUsage priced with the pinned metadataModel — repricing
    // would then strip the row. The stream's record-time metadataModel must
    // key the ledger instead.
    const pinnedSnapshot: ProvidersConfigMap = {
      coder: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        discoveredProviders: [{ name: "prod", type: "anthropic" }],
      },
    };
    const usage = createUsageRecorder();
    // Live config has NO metadata for the instance (removed mid-turn).
    const streamManager = createStreamManagerForTests(historyService, {
      sessionUsageService: usage.sessionUsageService,
      getProvidersConfig: () => ({}),
      streamText: scriptedStreamText([
        {
          chunks: [{ type: "text-delta", text: "done" }, STOP_FINISH],
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        },
      ]),
    });

    const { completion } = await runTurnForTests(streamManager, {
      workspaceId: "ws-pinned-metadata",
      modelString: "coder:prod/claude-opus-4-5",
      providersConfigSnapshot: pinnedSnapshot,
    });
    expect(completion.status).toBe("completed");
    expect(usage.ledgerKeys()).toEqual(["anthropic:claude-opus-4-5"]);
  });

  test.each([
    // WorkspaceStore live deltas and SessionUsageService history rebuilds
    // re-key usage from metadata.model via normalizeUsageModelKey, which
    // needs the raw identity to resolve the instance type — the canonical
    // openai:<claude> form would accumulate under a second, wrongly priced
    // key that diverges from the backend's ledger.
    ["coder:openai/claude-opus-4-5", "coder:openai/claude-opus-4-5"],
    // Non-Coder gateway strings still canonicalize for display.
    ["openrouter:anthropic/claude-opus-4-5", "anthropic:claude-opus-4-5"],
  ])("message metadata for %s records model %s", async (modelString, expectedModel) => {
    const workspaceId = `ws-metadata-${expectedModel.replace(/[^a-z0-9]/gi, "-")}`;
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: scriptedStreamText([{ chunks: [REFUSAL_FINISH], usage: NO_USAGE }]),
    });

    // The terminal refusal persists the partial assistant message built for the turn.
    const { completion } = await runTurnForTests(streamManager, { workspaceId, modelString });
    expect(completion.status).toBe("failed");
    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("model_refusal");
    expect(partial?.metadata?.model).toBe(expectedModel);
  });
});

describe("StreamManager - fallback construction callbacks", () => {
  test("onStreamConstructed fires after successful construction, never on failure", async () => {
    // Durable side effects hung on this callback (the superseding fallback
    // turn envelope) must describe a stream that exists: called exactly once
    // on success, not at all when fallback stream construction throws.
    const eligibleProvidersConfig: ProvidersConfigMap = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };
    const refusedAttempt: ScriptedAttempt = {
      chunks: [REFUSAL_FINISH],
      usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
    };

    const onSuccess = mock(() => Promise.resolve());
    const success = preparedFallback({ onStreamConstructed: onSuccess });
    const successManager = createStreamManagerForTests(historyService, {
      getProvidersConfig: () => eligibleProvidersConfig,
      streamText: scriptedStreamText([
        refusedAttempt,
        { chunks: [{ type: "text-delta", text: "fallback answer" }, STOP_FINISH], usage: NO_USAGE },
      ]),
    });
    const succeeded = await runTurnForTests(successManager, {
      workspaceId: "fallback-envelope-success-workspace",
      modelString: KNOWN_MODELS.SONNET.id,
      modelFallback: success,
    });
    expect(succeeded.completion.status).toBe("completed");
    expect(success.prepare).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);

    const onFailure = mock(() => Promise.resolve());
    const failure = preparedFallback({ onStreamConstructed: onFailure });
    const failureManager = createStreamManagerForTests(historyService, {
      getProvidersConfig: () => eligibleProvidersConfig,
      streamText: scriptedStreamText([
        refusedAttempt,
        new Error("stream construction failed for tests"),
      ]),
    });
    const failed = await runTurnForTests(failureManager, {
      workspaceId: "fallback-envelope-failure-workspace",
      modelString: KNOWN_MODELS.SONNET.id,
      modelFallback: failure,
    });
    expect(failed.completion.status).toBe("failed");
    expect(failure.prepare).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe("StreamManager - fallback volatile-tail record (mechanism 10)", () => {
  test("a step-0 thinking rebuild on the fallback keeps its newer tail record", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6srL1S): the fallback stream may prepare its first step before
    // activation finishes. A thinking change consumed there rebuilds the request and records
    // its own tail plan, which the prepared baseline must not overwrite afterwards.
    const baseline = { text: "\n\n[Warning: A]", placement: "system" as const };
    const rebuiltTail = { text: "\n\n[Warning: B]", placement: "row" as const };
    let firstStep: unknown;
    const attempts: ScriptedAttempt[] = [
      { chunks: [REFUSAL_FINISH], usage: NO_USAGE },
      { chunks: [{ type: "text-delta", text: "fallback answer" }, STOP_FINISH], usage: NO_USAGE },
    ];
    const scripted = scriptedStreamText(attempts);
    let calls = 0;
    const streamText = fakeStreamText((request) => {
      // Like the AI SDK: the fallback (second call) starts preparing step 0 at construction.
      if (++calls === 2) {
        firstStep = request.prepareStep?.({
          messages: [{ role: "user", content: "hello" }],
          stepNumber: 0,
          steps: [],
        } as never);
      }
      return (scripted as unknown as (options: typeof request) => unknown)(request);
    });
    const holder: { pending?: "high" } = {};
    const prepare = mock((nextModelString: string) => {
      // The user changes the thinking level while the fallback is being prepared.
      holder.pending = "high";
      return Promise.resolve(
        Ok({
          model: createTestLanguageModel("fallback-model"),
          modelString: nextModelString,
          messages: [{ role: "user" as const, content: "hello" }],
          system: "You are a helpful assistant",
          tools: undefined,
          thinkingLevel: "low" as const,
          providerOptions: {},
          initialMetadataPatch: { volatileSystemTail: baseline },
          rebuildProviderOptionsForThinkingLevel: (level: ThinkingLevel) => ({
            providerOptions: {},
            effectiveLevel: level,
          }),
          rebuildFirstStepForThinkingLevel: () =>
            Promise.resolve({
              messages: [{ role: "user" as const, content: "hello" }],
              systemRecords: { volatileSystemTail: rebuiltTail },
            }),
          // Activation awaits this; the eager first step finishes meanwhile.
          onStreamConstructed: async () => {
            await Promise.resolve(firstStep);
          },
        })
      );
    });
    const workspaceId = "fallback-volatile-tail-workspace";
    const streamManager = createStreamManagerForTests(historyService, { streamText });
    const { completion } = await runTurnForTests(streamManager, {
      workspaceId,
      modelString: KNOWN_MODELS.SONNET.id,
      modelFallback: { chain: ["openai:gpt-5.6-luna"], prepare },
      thinkingOverrideState: holder,
    });
    expect(completion.status).toBe("completed");
    expect(firstStep).toBeDefined();
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    expect(history.data.at(-1)?.metadata?.volatileSystemTail).toEqual(rebuiltTail);
  });
});

describe("StreamManager - default refusal fallback chains", () => {
  test("an error after a fallback swap names the fallback model", async () => {
    // AgentSession plans the compaction context_exceeded retry from this model: the fallback's
    // window was the one too small, not the refused model's.
    const { prepare, chain } = preparedFallback();
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: scriptedStreamText([
        { chunks: [REFUSAL_FINISH], usage: NO_USAGE },
        { chunks: [{ type: "error", error: new Error("prompt is too long") }], usage: NO_USAGE },
      ]),
    });
    const { completion } = await runTurnForTests(streamManager, {
      workspaceId: "ws-fallback-error-model",
      modelString: KNOWN_MODELS.SONNET.id,
      modelFallback: { chain, prepare },
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(completion.status).toBe("failed");
    expect(completion.status === "failed" ? completion.streamError.model : null).toBe(chain[0]);
  });

  test("a refused Sonnet 5.5 turn recovers on Sonnet 5 through the shipped default chain", async () => {
    // Anthropic's own server-side cyber fallback for Sonnet 5.5 retries on
    // Sonnet 5 (#5087); the shipped client-side chain mirrors it.
    const sonnet55 = "anthropic:claude-sonnet-5-5";
    const sonnet5 = "anthropic:claude-sonnet-5";
    const chain = resolveModelFallbackChain(DEFAULT_MODEL_FALLBACKS, sonnet55);
    expect(chain).toEqual([sonnet5]);

    const { prepare } = preparedFallback();
    const streamManager = createStreamManagerForTests(historyService, {
      getProvidersConfig: () => ({
        anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
      }),
      streamText: scriptedStreamText([
        { chunks: [REFUSAL_FINISH], usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 } },
        { chunks: [{ type: "text-delta", text: "fallback answer" }, STOP_FINISH], usage: NO_USAGE },
      ]),
    });

    const { completion } = await runTurnForTests(streamManager, {
      workspaceId: "ws-sonnet-5-5-default-fallback",
      modelString: sonnet55,
      modelFallback: { chain, prepare },
    });
    expect(completion.status).toBe("completed");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toBe(sonnet5);
  });
});

describe("StreamManager - fallback swap edges", () => {
  const refused: ScriptedAttempt = { chunks: [REFUSAL_FINISH], usage: NO_USAGE };
  const answered: ScriptedAttempt = {
    chunks: [{ type: "text-delta", text: "fallback answer" }, STOP_FINISH],
    usage: NO_USAGE,
  };

  test("a chain that ends on a refusal keeps every refused model on the error row", async () => {
    const { chain, prepare } = preparedFallback();
    const workspaceId = "fallback-edges-terminal-record";
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: scriptedStreamText([refused, refused]),
    });
    const { completion } = await runTurnForTests(streamManager, {
      workspaceId,
      modelFallback: { chain, prepare },
    });
    expect(completion.status).toBe("failed");
    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.modelFallback).toEqual({
      requestedModel: KNOWN_MODELS.SONNET.id,
      refusedModels: [KNOWN_MODELS.SONNET.id, chain[0]],
    });
  });

  test("a swap after a refusal without output clears the refused attempt's partial", async () => {
    // A crash while the fallback starts must not recover the refused model's row.
    const { chain, prepare } = preparedFallback();
    const workspaceId = "fallback-edges-partial-reset";
    let partialAtFallbackStart: Awaited<ReturnType<typeof historyService.readPartial>> | undefined;
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: scriptedStreamText([
        refused,
        {
          chunks: [
            async () => {
              partialAtFallbackStart = await historyService.readPartial(workspaceId);
            },
            ...answered.chunks,
          ],
          usage: NO_USAGE,
        },
      ]),
    });
    const { completion } = await runTurnForTests(streamManager, {
      workspaceId,
      modelFallback: { chain, prepare },
    });
    expect(completion.status).toBe("completed");
    expect(partialAtFallbackStart).toBeNull();
  });

  test("an interrupt while prepare() runs ends the turn as aborted, not as a refusal", async () => {
    const workspaceId = "fallback-edges-abort-in-prepare";
    let stopping: Promise<unknown> | undefined;
    const streamManager: StreamManager = createStreamManagerForTests(historyService, {
      streamText: scriptedStreamText([refused]),
    });
    // The user interrupts while the fallback is being prepared, and prepare() then throws.
    // The caller's signal aborts the provider request at once; stopStream settles the turn.
    const controller = new AbortController();
    const prepare = mock(() => {
      controller.abort();
      stopping = streamManager.stopStream(workspaceId);
      return Promise.reject(new Error("prepare interrupted"));
    });
    const errors: unknown[] = [];
    onTurnEngineEvent(streamManager, "error", (data) => errors.push(data));
    const { completion } = await runTurnForTests(streamManager, {
      workspaceId,
      abortSignal: controller.signal,
      modelFallback: { chain: [KNOWN_MODELS.GPT.id], prepare },
    });
    await stopping;
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(completion.status).toBe("aborted");
    expect(errors).toEqual([]);
  });

  test("a context-budget Err from prepare() fails the turn on the budget, not as a refusal", async () => {
    const fallbackModel = KNOWN_MODELS.GPT.id;
    const prepare = mock(() =>
      Promise.resolve(
        Err({
          type: "context_budget_exceeded" as const,
          model: fallbackModel,
          estimate: 64000,
          hardCeiling: 55808,
        })
      )
    );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: scriptedStreamText([refused]),
    });
    const { completion } = await runTurnForTests(streamManager, {
      workspaceId: "fallback-edges-budget",
      modelFallback: { chain: [fallbackModel], prepare },
    });
    // The fallback's oversized request is a budget stop, which the session can roll over from.
    expect(completion).toMatchObject({
      status: "failed",
      streamError: {
        errorType: "context_budget_blocked",
        contextBudgetExceeded: { model: fallbackModel, estimate: 64000, hardCeiling: 55808 },
      },
    });
  });

  test("the fallback request keeps the turn's maxOutputTokens", async () => {
    const scripted = scriptedStreamText([refused, answered]);
    const maxOutputTokens: unknown[] = [];
    const streamText = fakeStreamText((request) => {
      maxOutputTokens.push(request.maxOutputTokens);
      return (scripted as unknown as (options: typeof request) => unknown)(request);
    });
    const { chain, prepare } = preparedFallback();
    const streamManager = createStreamManagerForTests(historyService, { streamText });
    const { completion } = await runTurnForTests(streamManager, {
      workspaceId: "fallback-edges-max-output",
      maxOutputTokens: 1234,
      modelFallback: { chain, prepare },
    });
    expect(completion.status).toBe("completed");
    expect(maxOutputTokens).toEqual([1234, 1234]);
  });

  test("a fallback stream that fails to start releases the fallback model", async () => {
    const cleanup = mock(() => undefined);
    const fallbackModel = createTestLanguageModel("fallback-model");
    attachLanguageModelCleanup(fallbackModel, cleanup);
    const prepare = mock((modelString: string) =>
      Promise.resolve(
        Ok({
          model: fallbackModel,
          modelString,
          messages: [],
          system: "system",
          tools: undefined,
        })
      )
    );
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: scriptedStreamText([refused, new Error("fallback stream failed to start")]),
    });
    const { completion } = await runTurnForTests(streamManager, {
      workspaceId: "fallback-edges-start-cleanup",
      modelFallback: { chain: [KNOWN_MODELS.GPT.id], prepare },
    });
    expect(completion.status).toBe("failed");
    // The prepared model never became the stream's request model, so only the swap can release it.
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test("a receipt strip of the fallback's messages moves the receipt to the fallback's first step", async () => {
    // A thinking-replay receipt is in force (here from the caller's metadata), so the swap strips
    // the prepared messages' Anthropic thinking. The fallback's first step is row step 2.
    const workspaceId = "fallback-edges-replay-point";
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: scriptedStreamText([
        {
          chunks: [
            { type: "start-step" },
            { type: "text-delta", text: "step one" },
            { type: "finish-step", usage: NO_USAGE },
            { type: "start-step" },
            { type: "text-delta", text: "step two" },
            REFUSAL_FINISH,
          ],
          usage: NO_USAGE,
        },
        {
          chunks: [
            { type: "start-step" },
            { type: "text-delta", text: "fallback answer" },
            { type: "finish-step", usage: NO_USAGE },
            STOP_FINISH,
          ],
          usage: NO_USAGE,
        },
      ]),
    });
    const { messageId, completion } = await runTurnForTests(streamManager, {
      workspaceId,
      model: createTestLanguageModel("claude-opus-5-5", "anthropic.messages"),
      modelString: "anthropic:claude-opus-5-5",
      initialMetadata: { anthropicThinkingReplay: "off", anthropicThinkingReplayFromStep: 0 },
      modelFallback: {
        chain: ["anthropic:claude-sonnet-5"],
        prepare: (modelString) =>
          Promise.resolve(
            Ok({
              model: createTestLanguageModel("claude-sonnet-5", "anthropic.messages"),
              modelString,
              messages: [
                { role: "user", content: "hello" },
                {
                  role: "assistant",
                  content: [
                    {
                      type: "reasoning",
                      text: "signed thinking",
                      providerOptions: { anthropic: { signature: "sig" } },
                    },
                    { type: "text", text: "step one" },
                  ],
                },
              ],
              system: "system",
              tools: undefined,
            })
          ),
      },
    });
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    const row = history.data.find((message) => message.id === messageId);
    expect(completion.status).toBe("completed");
    expect(row?.metadata?.stepStartPartIndices).toEqual([0, 1, 2]);
    expect(row?.metadata?.anthropicThinkingReplay).toBe("off");
    expect(row?.metadata?.anthropicThinkingReplayFromStep).toBe(2);
  });

  test("the swap points the live token tracker at the fallback model", async () => {
    const setModel = mock((_model: string, _metadataModel?: string) => Promise.resolve());
    const { chain, prepare } = preparedFallback();
    const streamManager = createStreamManagerForTests(historyService, {
      tokenTracker: { setModel, countTokens: () => Promise.resolve(0) },
      streamText: scriptedStreamText([refused, answered]),
    });
    const { completion } = await runTurnForTests(streamManager, {
      workspaceId: "fallback-edges-token-tracker",
      modelFallback: { chain, prepare },
    });
    expect(completion.status).toBe("completed");
    expect(setModel.mock.calls.at(-1)?.[0]).toBe(chain[0]);
  });

  test("a tool the fallback stream runs reports its execution start", async () => {
    const workspaceId = "fallback-edges-tool-execution-start";
    let fallbackRequest: { tools?: Record<string, unknown>; abortSignal?: AbortSignal } = {};
    let calls = 0;
    const scripted = scriptedStreamText([
      refused,
      {
        chunks: [
          { type: "tool-call", toolCallId: "call-1", toolName: "probe", input: {} },
          // The SDK runs the tool through the request's wrapped execute().
          async () => {
            const probe = fallbackRequest.tools?.probe as {
              execute: (input: unknown, options: ToolExecutionOptions<unknown>) => Promise<unknown>;
            };
            await probe.execute(
              {},
              {
                toolCallId: "call-1",
                messages: [],
                context: undefined,
                abortSignal: fallbackRequest.abortSignal,
              }
            );
          },
          { type: "tool-result", toolCallId: "call-1", toolName: "probe", input: {}, output: "ok" },
          STOP_FINISH,
        ],
        usage: NO_USAGE,
      },
    ]);
    const streamText = fakeStreamText((request) => {
      if (++calls === 2) fallbackRequest = request;
      return (scripted as unknown as (options: typeof request) => unknown)(request);
    });
    const prepare = mock((modelString: string) =>
      Promise.resolve(
        Ok({
          model: createTestLanguageModel("fallback-model"),
          modelString,
          messages: [],
          system: "system",
          tools: { probe: tool({ inputSchema: z.object({}), execute: () => "ok" }) },
        })
      )
    );
    const streamManager = createStreamManagerForTests(historyService, { streamText });
    const starts: unknown[] = [];
    onTurnEngineEvent(streamManager, "tool-call-execution-start", (data) => starts.push(data));
    const { completion } = await runTurnForTests(streamManager, {
      workspaceId,
      modelFallback: { chain: [KNOWN_MODELS.GPT.id], prepare },
    });
    expect(completion.status).toBe("completed");
    expect(starts).toMatchObject([{ toolCallId: "call-1" }]);
  });

  test("a refused hop without live provider metadata records the steps' metadata", async () => {
    const usage = createUsageRecorder();
    const stepMetadata = { anthropic: { cacheCreationInputTokens: 7 } };
    const streamManager = createStreamManagerForTests(historyService, {
      sessionUsageService: usage.sessionUsageService,
      streamText: scriptedStreamText([
        {
          chunks: [REFUSAL_FINISH],
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          steps: [
            {
              usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
              providerMetadata: stepMetadata,
            },
          ],
        },
      ]),
    });
    const { completion } = await runTurnForTests(streamManager, {
      workspaceId: "fallback-edges-step-metadata",
      modelFallback: unstartableFallback(),
    });
    expect(completion.status).toBe("failed");
    // No finish-step metadata reached the stream, so the snapshot reads the result's steps.
    expect(usage.recordHeadlessUsage.mock.calls.map((call) => call[3])).toEqual([stepMetadata]);
  });
});
