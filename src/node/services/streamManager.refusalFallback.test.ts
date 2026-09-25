import { describe, test, expect, mock } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { Ok } from "@/common/types/result";
import type {
  ModelFallbackOptions,
  ModelFallbackPrepareOptions,
  StreamManager,
  TurnExecutionOptions,
} from "./streamManager";
import type { SessionUsageService } from "./sessionUsageService";
import { createStreamManagerForTests, fakeStreamText } from "./streamManager.testHarness";
import {
  installStreamManagerTestHistory,
  historyService,
  createTestLanguageModel,
  appendPartialAssistantForTests,
  createStreamResultForTests,
  testStartOptions,
} from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

/** A fullStream chunk, or a callback awaited at that point of the stream (mid-turn side effects). */
type ScriptedChunk = Record<string, unknown> | (() => unknown);

/** One provider attempt served by the injected streamText (the primary turn, then each fallback). */
interface ScriptedAttempt {
  chunks: ScriptedChunk[];
  /** streamResult usage/totalUsage for the attempt. */
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  providerMetadata?: Record<string, unknown>;
  /** Keep the stream open after the chunks until the turn's abort signal fires. */
  holdUntilAbort?: boolean;
}

const REFUSAL_FINISH = {
  type: "finish",
  finishReason: "content-filter",
  rawFinishReason: "refusal",
};
const STOP_FINISH = { type: "finish", finishReason: "stop" };

/** Serves scripted attempts in order; an Error entry makes that streamText call throw. */
function scriptedStreamText(attempts: Array<ScriptedAttempt | Error>) {
  const queue = [...attempts];
  return fakeStreamText((request) => {
    const attempt = queue.shift();
    if (attempt === undefined) throw new Error("unexpected extra streamText call");
    if (attempt instanceof Error) throw attempt;
    const signal = request.abortSignal!;
    return createStreamResultForTests(
      (async function* () {
        await Promise.resolve();
        for (const chunk of attempt.chunks) {
          if (typeof chunk === "function") await chunk();
          else yield chunk;
        }
        if (attempt.holdUntilAbort && !signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          );
        }
      })(),
      attempt.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      attempt.providerMetadata
    );
  });
}

/** Starts a public turn and waits for its terminal completion. */
async function runTurnForTests(
  streamManager: StreamManager,
  options: Partial<TurnExecutionOptions> & { workspaceId: string; modelString: string }
) {
  const messageId = `${options.workspaceId}-message`;
  await appendPartialAssistantForTests(options.workspaceId, messageId, 1);
  const result = await streamManager.startStream(
    testStartOptions({
      messageId,
      model: createTestLanguageModel(),
      providedRuntimeTempDir: "",
      ...options,
    })
  );
  if (!result.success) throw new Error(`Expected stream to start: ${JSON.stringify(result.error)}`);
  return { messageId, completion: await result.data.completion };
}

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
      streamText: scriptedStreamText([{ chunks: [REFUSAL_FINISH] }]),
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
    // canonical model; a raw mux-gateway identity on committed hop rows would
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
      modelString: "mux-gateway:anthropic/claude-opus-4-5",
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
        { chunks: [REFUSAL_FINISH] },
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
    ["mux-gateway:anthropic/claude-opus-4-5", "anthropic:claude-opus-4-5"],
  ])("message metadata for %s records model %s", async (modelString, expectedModel) => {
    const workspaceId = `ws-metadata-${expectedModel.replace(/[^a-z0-9]/gi, "-")}`;
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: scriptedStreamText([{ chunks: [REFUSAL_FINISH] }]),
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
        { chunks: [{ type: "text-delta", text: "fallback answer" }, STOP_FINISH] },
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
