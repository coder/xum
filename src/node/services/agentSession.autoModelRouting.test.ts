import { afterEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "events";
import type { AIService, StreamMessageOptions } from "@/node/services/aiService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { CompactionMonitor } from "./compactionMonitor";
import type { Config } from "@/node/config";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type {
  AutoModelRouter,
  AutoModelRouterClassifyInput,
} from "@/node/services/autoModelRouter";
import type { AutoModelRoutingDecision } from "@/common/types/autoModelRouting";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL } from "@/constants/autoModelRouting";
import { createMuxMessage } from "@/common/types/message";
import { formatSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import { Err, Ok, type Result } from "@/common/types/result";
import { createTestHistoryService } from "./testHistoryService";
import {
  createStartedTurnHandle,
  createStreamLifecycleMocks,
  createTestAgentSession,
} from "./agentSession.testHarness";

const COMPOSER_MODEL = "anthropic:claude-3-5-sonnet-latest";
const HARD_MODEL = "openai:gpt-5.5";

interface TierInput {
  id: string;
  label: string;
  description: string;
  model?: string;
  thinkingLevel?: string;
}

const TIERS: TierInput[] = [
  { id: "easy", label: "Easy", description: "Trivial", model: "anthropic:claude-3-5-haiku-latest" },
  { id: "hard", label: "Hard", description: "Complex", model: HARD_MODEL, thinkingLevel: "high" },
  { id: "extreme", label: "Extreme", description: "Architecture" },
];

function decision(tierId: string): AutoModelRoutingDecision {
  return {
    tierId,
    confidence: 0.9,
    probabilities: { easy: 0.05, hard: 0.9, extreme: 0.05 },
    evaluationModel: DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
  };
}

describe("AgentSession.sendMessage (auto model routing)", () => {
  let historyCleanup: (() => Promise<void>) | undefined;

  async function createHarness(options: {
    experimentEnabled: boolean;
    classify?: (
      input: AutoModelRouterClassifyInput
    ) => Promise<Result<AutoModelRoutingDecision, string>>;
    tiers?: TierInput[];
    /** Saved evaluation model; absent means the normalized default. */
    evaluationModel?: string;
    /** Models the budgeted-goal pricing gate refuses. */
    unpricedModels?: string[];
  }) {
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    const config = {
      rootDir: "/tmp",
      sessionsDir: "/tmp",
      srcDir: "/tmp",
      loadConfigOrDefault: () => ({
        autoModelRouting: {
          tiers: options.tiers ?? TIERS,
          ...(options.evaluationModel ? { evaluationModel: options.evaluationModel } : {}),
        },
      }),
    } as unknown as Config;
    // Goal service stub: only the pricing gate has behavior; every other method the
    // send path touches is a no-op resolving to undefined (no goal exists here).
    const unpriced = new Set(options.unpricedModels ?? []);
    const workspaceGoalService =
      options.unpricedModels == null
        ? undefined
        : (new Proxy(
            {
              assertPricedModelForBudgetedGoal: (_workspaceId: string, model: string | undefined) =>
                Promise.resolve(
                  model != null && unpriced.has(model)
                    ? Err({ type: "unknown" as const, raw: "unpriced" })
                    : Ok(undefined)
                ),
            } as Record<PropertyKey, unknown>,
            { get: (target, prop) => target[prop] ?? (() => Promise.resolve(undefined)) }
          ) as unknown as WorkspaceGoalService);

    const streamMessage = mock((opts: StreamMessageOptions) =>
      Promise.resolve(Ok(createStartedTurnHandle(opts.abortSignal!)))
    );
    const aiService = Object.assign(new EventEmitter(), {
      ...createStreamLifecycleMocks(),
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      getProvidersConfig: mock(() => ({})),
      isExperimentEnabled: mock(
        (id: ExperimentId) => id === EXPERIMENT_IDS.AUTO_MODEL_ROUTING && options.experimentEnabled
      ),
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    }) as unknown as AIService;
    const classify = mock<NonNullable<typeof options.classify>>(
      options.classify ?? (() => Promise.resolve(Ok(decision("hard"))))
    );
    const recordHeadlessUsage = mock(
      (
        _workspaceId: string,
        _modelString: string,
        _usage: AutoModelRoutingDecision["usage"],
        _providerMetadata?: Record<string, unknown>,
        _options?: { analyticsSource?: string }
      ) => Promise.resolve(undefined)
    );

    const session = createTestAgentSession({
      workspaceId: "ws-auto-routing",
      config,
      historyService,
      aiService,
      initStateManager: new EventEmitter() as unknown as InitStateManager,
      backgroundProcessManager: {
        cleanup: mock((_workspaceId: string) => Promise.resolve()),
        setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
          void _queued;
        }),
      } as unknown as BackgroundProcessManager,
      autoModelRouter: { classify } satisfies Pick<AutoModelRouter, "classify">,
      sessionUsageService: { recordHeadlessUsage } as unknown as Pick<
        SessionUsageService,
        "recordHeadlessUsage"
      >,
      workspaceGoalService,
    });
    return { session, historyService, streamMessage, classify, recordHeadlessUsage };
  }

  afterEach(async () => {
    await historyCleanup?.();
  });

  async function persistedUserRow(
    historyService: Awaited<ReturnType<typeof createTestHistoryService>>["historyService"]
  ) {
    const history = await historyService.getHistoryFromLatestBoundary("ws-auto-routing");
    if (!history.success) throw new Error(history.error);
    const row = history.data.find((message) => message.role === "user");
    if (!row) throw new Error("user row missing");
    return row;
  }

  /** The follow-up stored on the persisted compaction-request row. */
  async function persistedCompactionFollowUp(
    historyService: Awaited<ReturnType<typeof createTestHistoryService>>["historyService"]
  ) {
    const history = await historyService.getHistoryFromLatestBoundary("ws-auto-routing");
    if (!history.success) throw new Error(history.error);
    const muxMetadata = history.data.find(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    )?.metadata?.muxMetadata;
    return muxMetadata?.type === "compaction-request"
      ? muxMetadata.parsed.followUpContent
      : undefined;
  }

  /** Make the next send hit the on-send compaction threshold. */
  function forceOnSendCompaction(session: Awaited<ReturnType<typeof createHarness>>["session"]) {
    const internals = session as unknown as {
      contextController: { compactionMonitor: CompactionMonitor };
    };
    internals.contextController.compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 99,
        thresholdPercentage: 85,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;
  }

  const UNSUPPORTED_IMAGE = {
    type: "file" as const,
    url: "data:image/png;base64,iVBORw0KGgo=",
    mediaType: "image/png",
  };
  /** Tiers whose hard model is catalogued without vision or PDF support. */
  const TIERS_WITH_GROK = TIERS.map((tier) =>
    tier.id === "hard" ? { ...tier, model: "xai:grok-3" } : tier
  );

  it("runs the turn on the chosen tier's model and strips the flag from the retry snapshot", async () => {
    const { session, historyService, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
    });

    const result = await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "medium",
      autoModelRouting: true,
    });
    expect(result.success).toBe(true);
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0]?.[0]).toMatchObject({
      prompt: "Refactor the scheduler",
      tiers: TIERS,
      evaluationModel: DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
    });
    expect(streamMessage).toHaveBeenCalledTimes(1);
    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe(HARD_MODEL);
    // Only the model dimension was Auto: the tier's "high" stays out of it.
    expect(streamOptions?.thinkingLevel).toBe("medium");
    expect(streamOptions?.autoModelRouting).toMatchObject({
      status: "routed",
      tierId: "hard",
      tierLabel: "Hard",
      model: HARD_MODEL,
      requestedFallbackModel: COMPOSER_MODEL,
      confidence: 0.9,
    });
    expect(streamOptions?.autoModelRouting).not.toHaveProperty("thinkingLevel");

    const row = await persistedUserRow(historyService);
    const retry = row.metadata?.retrySendOptions as Record<string, unknown> | undefined;
    expect(retry?.model).toBe(HARD_MODEL);
    expect(retry?.thinkingLevel).toBe("medium");
    expect(retry).not.toHaveProperty("autoModelRouting");
    expect(retry).not.toHaveProperty("autoThinkingLevel");
    expect(retry).not.toHaveProperty("autoModelRoutingRecord");
  });

  it("applies both the tier's model and thinking level when both composer dimensions are Auto", async () => {
    const { session, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
      evaluationModel: "openai:gpt-5-nano",
    });

    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoModelRouting: true,
      autoThinkingLevel: true,
    });
    await session.waitForIdle();

    // The saved evaluation model reaches the evaluator unchanged.
    expect(classify.mock.calls[0]?.[0]?.evaluationModel).toBe("openai:gpt-5-nano");
    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe(HARD_MODEL);
    expect(streamOptions?.thinkingLevel).toBe("high");
    expect(streamOptions?.autoModelRouting).toMatchObject({
      status: "routed",
      tierId: "hard",
      model: HARD_MODEL,
      thinkingLevel: "high",
    });
  });

  it("keeps the composer model when the classifier fails and records the reason", async () => {
    const { session, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
      classify: () => Promise.resolve(Err("Classifier returned HTTP 429")),
    });

    const result = await session.sendMessage("hello", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoModelRouting: true,
    });
    expect(result.success).toBe(true);
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(streamOptions?.thinkingLevel).toBe("low");
    expect(streamOptions?.autoModelRouting).toMatchObject({
      status: "fallback",
      model: COMPOSER_MODEL,
      reason: "Classifier returned HTTP 429",
    });
  });

  it("keeps the composer model when the chosen tier has no mapped model", async () => {
    const { session, streamMessage } = await createHarness({
      experimentEnabled: true,
      classify: () => Promise.resolve(Ok(decision("extreme"))),
    });

    await session.sendMessage("design it", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(streamOptions?.autoModelRouting).toMatchObject({
      status: "unmapped-tier",
      tierId: "extreme",
      model: COMPOSER_MODEL,
    });
  });

  it("never calls the classifier when the experiment is disabled", async () => {
    const { session, streamMessage, classify } = await createHarness({
      experimentEnabled: false,
    });

    await session.sendMessage("hello", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    expect(classify).not.toHaveBeenCalled();
    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(streamOptions?.autoModelRouting).toBeUndefined();
  });

  it("never classifies synthetic or agent-initiated turns that carry the flag", async () => {
    const { session, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
    });

    await session.sendMessage(
      "continue",
      { model: COMPOSER_MODEL, agentId: "exec", autoModelRouting: true },
      { synthetic: true, agentInitiated: true }
    );
    await session.waitForIdle();

    expect(classify).not.toHaveBeenCalled();
    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(streamOptions?.autoModelRouting).toBeUndefined();
  });

  it("skips the classifier entirely when no tier has a model mapped", async () => {
    const { session, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
      tiers: TIERS.map(({ model: _model, thinkingLevel: _level, ...tier }) => tier),
    });

    await session.sendMessage("hello", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    expect(classify).not.toHaveBeenCalled();
    expect(streamMessage.mock.calls[0]?.[0]?.autoModelRouting).toMatchObject({
      status: "fallback",
      model: COMPOSER_MODEL,
    });
  });

  it("thinking-only Auto applies the tier's thinking level and keeps the composer model", async () => {
    const { session, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
      classify: () => Promise.resolve(Ok(decision("hard"))),
    });

    await session.sendMessage("design it", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoThinkingLevel: true,
    });
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    const streamOptions = streamMessage.mock.calls[0]?.[0];
    // The hard tier maps a model too, but the composer kept its model concrete.
    expect(streamOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(streamOptions?.thinkingLevel).toBe("high");
    expect(streamOptions?.autoModelRouting).toMatchObject({
      status: "routed",
      tierId: "hard",
      model: COMPOSER_MODEL,
      thinkingLevel: "high",
    });
  });

  it("thinking-only Auto skips the evaluator when no tier has a thinking level mapped", async () => {
    const { session, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
      tiers: TIERS.map(({ thinkingLevel: _level, ...tier }) => tier),
    });

    await session.sendMessage("hello", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoThinkingLevel: true,
    });
    await session.waitForIdle();

    expect(classify).not.toHaveBeenCalled();
    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(streamOptions?.thinkingLevel).toBe("low");
    expect(streamOptions?.autoModelRouting).toMatchObject({ status: "fallback" });
  });

  it("thinking-only Auto treats a tier without a thinking level as unmapped", async () => {
    const { session, streamMessage } = await createHarness({
      experimentEnabled: true,
      classify: () => Promise.resolve(Ok(decision("easy"))),
    });

    await session.sendMessage("rename it", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoThinkingLevel: true,
    });
    await session.waitForIdle();

    const streamOptions = streamMessage.mock.calls[0]?.[0];
    // The easy tier maps a model but no thinking level; model Auto was off.
    expect(streamOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(streamOptions?.thinkingLevel).toBe("low");
    expect(streamOptions?.autoModelRouting).toMatchObject({
      status: "unmapped-tier",
      tierId: "easy",
    });
  });

  it("skips the classifier for an attachment-only send and keeps the composer model", async () => {
    const { session, streamMessage, classify } = await createHarness({ experimentEnabled: true });

    const result = await session.sendMessage("", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
      fileParts: [{ url: "data:image/png;base64,iVBORw0KGgo=", mediaType: "image/png" }],
    });
    expect(result.success).toBe(true);
    await session.waitForIdle();

    expect(classify).not.toHaveBeenCalled();
    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(streamOptions?.autoModelRouting).toMatchObject({
      status: "fallback",
      model: COMPOSER_MODEL,
      reason: "Attachment-only send has no prompt text to classify",
    });
  });

  it("falls back when a PDF attachment cannot be sent to the chosen tier's model", async () => {
    const { session, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
      // xai:grok-3 is catalogued without PDF support; the composer model has no catalog entry.
      tiers: TIERS_WITH_GROK,
    });

    const result = await session.sendMessage("Summarize this", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
      fileParts: [
        { url: "data:application/pdf;base64,JVBERi0xLjQK", mediaType: "application/pdf" },
      ],
    });
    expect(result.success).toBe(true);
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(streamOptions?.autoModelRouting).toMatchObject({
      status: "fallback",
      tierId: "hard",
      model: COMPOSER_MODEL,
      reason: "Model xai:grok-3 does not support PDF input.",
    });
  });

  it("falls back when an image cannot be sent to the chosen tier's model", async () => {
    const { session, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
      // xai:grok-3 is catalogued without vision; the composer model has no catalog entry.
      tiers: TIERS_WITH_GROK,
    });

    const result = await session.sendMessage("What is in this screenshot?", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
      fileParts: [{ url: "data:image/png;base64,iVBORw0KGgo=", mediaType: "image/png" }],
    });
    expect(result.success).toBe(true);
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(streamOptions?.autoModelRouting).toMatchObject({
      status: "fallback",
      tierId: "hard",
      model: COMPOSER_MODEL,
      reason: "Model xai:grok-3 does not support image input.",
    });
  });

  it("falls back when a PDF earlier in the conversation cannot be sent to the chosen tier's model", async () => {
    const { session, historyService, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
      tiers: TIERS_WITH_GROK,
    });
    const earlier = createMuxMessage("earlier-pdf", "user", "Read this", undefined, [
      {
        type: "file",
        url: "data:application/pdf;base64,JVBERi0xLjQK",
        mediaType: "application/pdf",
      },
    ]);
    expect((await historyService.appendToHistory("ws-auto-routing", earlier)).success).toBe(true);

    // Text-only turn, but the request still carries the earlier PDF.
    await session.sendMessage("Now summarize it", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(streamOptions?.autoModelRouting).toMatchObject({
      status: "fallback",
      tierId: "hard",
      reason: "Model xai:grok-3 does not support PDF input.",
    });
  });

  it("ignores attachments on display-only rows the provider request never carries", async () => {
    const { session, historyService, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
      tiers: TIERS_WITH_GROK,
    });
    // Rejected by the context-budget gate: kept in history for the UI, excluded from requests.
    const rejected = createMuxMessage(
      "rejected-image",
      "user",
      "Look at this",
      { timestamp: Date.now() - 1_000, contextBudgetRejected: true },
      [UNSUPPORTED_IMAGE]
    );
    expect((await historyService.appendToHistory("ws-auto-routing", rejected)).success).toBe(true);

    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe("xai:grok-3");
    expect(streamOptions?.autoModelRouting?.status).toBe("routed");
  });

  it("never sends prompts from before the latest context boundary to the classifier", async () => {
    const { session, historyService, classify } = await createHarness({ experimentEnabled: true });
    const workspaceId = "ws-auto-routing";
    expect(
      (
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage("user-before-boundary", "user", "pre-boundary secret prompt", {
            timestamp: Date.now() - 4_000,
          })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage("assistant-boundary", "assistant", "compacted summary", {
            timestamp: Date.now() - 2_000,
            compacted: "user",
            compactionBoundary: true,
            compactionEpoch: 1,
          })
        )
      ).success
    ).toBe(true);

    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0]?.[0]?.recentUserMessages ?? []).not.toContain(
      "pre-boundary secret prompt"
    );
  });

  it("treats a corrupted persisted routing record as absent on resume", async () => {
    const { session, historyService, streamMessage } = await createHarness({
      experimentEnabled: true,
    });
    const row = createMuxMessage("user-corrupt-record", "user", "Refactor the scheduler", {
      timestamp: Date.now() - 1_000,
    });
    // Every field is a string, so a model-only guard would accept it; the status is bogus.
    (row.metadata as Record<string, unknown>).autoModelRouting = {
      requestedFallbackModel: COMPOSER_MODEL,
      model: HARD_MODEL,
      status: "bogus",
    };
    expect((await historyService.appendToHistory("ws-auto-routing", row)).success).toBe(true);

    const result = await session.resumeStream({
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    expect(result.success).toBe(true);
    await session.waitForIdle();

    const resumeOptions = streamMessage.mock.calls[0]?.[0];
    expect(resumeOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(resumeOptions?.autoModelRouting).toBeUndefined();
  });

  it("a manual resume under thinking Auto continues on the routed thinking level and keeps the record", async () => {
    const { session, streamMessage, classify } = await createHarness({ experimentEnabled: true });
    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoThinkingLevel: true,
    });
    await session.waitForIdle();

    const resumed = await session.resumeStream({
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoThinkingLevel: true,
    });
    expect(resumed).toEqual(Ok({ started: true }));
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    const resumeOptions = streamMessage.mock.calls[1]?.[0];
    expect(resumeOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(resumeOptions?.thinkingLevel).toBe("high");
    expect(resumeOptions?.autoModelRouting).toMatchObject({
      status: "routed",
      tierId: "hard",
      thinkingLevel: "high",
    });
  });

  it("carries the routing record on the on-send compaction follow-up instead of reclassifying", async () => {
    const { session, historyService, classify } = await createHarness({ experimentEnabled: true });
    forceOnSendCompaction(session);

    const result = await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoModelRouting: true,
    });
    expect(result.success).toBe(true);
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    const followUp = await persistedCompactionFollowUp(historyService);
    expect(followUp?.model).toBe(HARD_MODEL);
    expect(followUp?.autoModelRouting).toMatchObject({
      status: "routed",
      tierId: "hard",
      model: HARD_MODEL,
    });
  });

  it("keeps the routed model on the on-send follow-up when only pre-compaction attachments block it", async () => {
    const { session, historyService, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
      tiers: TIERS_WITH_GROK,
    });
    forceOnSendCompaction(session);
    const earlier = createMuxMessage("earlier-image", "user", "Look at this", undefined, [
      UNSUPPORTED_IMAGE,
    ]);
    expect((await historyService.appendToHistory("ws-auto-routing", earlier)).success).toBe(true);

    const result = await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    expect(result.success).toBe(true);
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    // The compaction turn still has the image in context, so it must not inherit the tier model.
    expect(streamMessage.mock.calls[0]?.[0]?.modelString).not.toBe("xai:grok-3");
    // The follow-up runs after the boundary folds the image away: it carries the routed decision.
    const followUp = await persistedCompactionFollowUp(historyService);
    expect(followUp?.model).toBe("xai:grok-3");
    expect(followUp?.autoModelRouting).toMatchObject({
      status: "routed",
      tierId: "hard",
      model: "xai:grok-3",
    });
  });

  it("re-gates a dispatched compaction follow-up against attachments that survived the boundary", async () => {
    const { session, historyService, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
    });
    const summary = createMuxMessage("summary", "assistant", "compacted summary", {
      timestamp: Date.now() - 2_000,
      compactionBoundary: true,
      compacted: "user",
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp: {
          text: "Now describe the screenshot",
          model: "xai:grok-3",
          agentId: "exec",
          autoModelRouting: {
            requestedFallbackModel: COMPOSER_MODEL,
            model: "xai:grok-3",
            status: "routed",
            tierId: "hard",
            tierLabel: "Hard",
          },
        },
      },
    });
    // A keep-recent tail copy carried the screenshot past the boundary.
    const tailCopy = createMuxMessage(
      "tail-image",
      "user",
      "Look at this",
      { timestamp: Date.now() - 1_000, rlmPreservedTailCopy: true },
      [UNSUPPORTED_IMAGE]
    );
    expect((await historyService.appendToHistory("ws-auto-routing", summary)).success).toBe(true);
    expect((await historyService.appendToHistory("ws-auto-routing", tailCopy)).success).toBe(true);

    expect(await session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(true);
    await session.waitForIdle();

    expect(classify).not.toHaveBeenCalled();
    const options = streamMessage.mock.calls[0]?.[0];
    expect(options?.modelString).toBe(COMPOSER_MODEL);
    expect(options?.autoModelRouting).toMatchObject({
      status: "fallback",
      tierId: "hard",
      model: COMPOSER_MODEL,
      reason: "Model xai:grok-3 does not support image input.",
    });
  });

  it("falls back when a budgeted goal cannot price the chosen tier's model", async () => {
    const { session, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
      unpricedModels: [HARD_MODEL],
    });

    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(streamOptions?.thinkingLevel).toBe("low");
    expect(streamOptions?.autoModelRouting).toMatchObject({
      status: "fallback",
      tierId: "hard",
      model: COMPOSER_MODEL,
    });
    expect(streamOptions?.autoModelRouting).not.toHaveProperty("thinkingLevel");
  });

  it("a pricing fallback reverts only the model and keeps the tier's thinking level", async () => {
    const { session, streamMessage } = await createHarness({
      experimentEnabled: true,
      unpricedModels: [HARD_MODEL],
    });

    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoModelRouting: true,
      autoThinkingLevel: true,
    });
    await session.waitForIdle();

    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(streamOptions?.thinkingLevel).toBe("high");
    expect(streamOptions?.autoModelRouting).toMatchObject({
      status: "fallback",
      tierId: "hard",
      model: COMPOSER_MODEL,
      thinkingLevel: "high",
    });
  });

  it("a manual resume under Auto continues on the routed model and keeps the record", async () => {
    const { session, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
    });
    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "medium",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    // The renderer resumes with the composer's current options; Auto is still selected.
    const resumed = await session.resumeStream({
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "medium",
      autoModelRouting: true,
    });
    expect(resumed).toEqual(Ok({ started: true }));
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    expect(streamMessage).toHaveBeenCalledTimes(2);
    const resumeOptions = streamMessage.mock.calls[1]?.[0];
    expect(resumeOptions?.modelString).toBe(HARD_MODEL);
    expect(resumeOptions?.thinkingLevel).toBe("medium");
    expect(resumeOptions?.autoModelRouting).toMatchObject({ status: "routed", tierId: "hard" });
  });

  it("a resume under Auto ignores a completed subagent report row appended after the turn", async () => {
    const { session, historyService, streamMessage } = await createHarness({
      experimentEnabled: true,
    });
    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    await session.waitForIdle();
    const report = createMuxMessage(
      "subagent-report",
      "user",
      formatSubagentReportEnvelope({
        taskId: "task-1",
        agentType: "explore",
        status: "completed",
        title: "Findings",
        reportMarkdown: "done",
      }),
      { timestamp: Date.now(), synthetic: true, uiVisible: true }
    );
    expect((await historyService.appendToHistory("ws-auto-routing", report)).success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    // The resume request is the routed turn (report rows are not retry targets), so the
    // routing lookup must skip the report row the same way.
    const internals = session as unknown as {
      applyAutoRoutedResume(options: {
        model: string;
        agentId: string;
        autoModelRouting?: boolean;
      }): Promise<{ model: string; autoModelRoutingRecord?: { status: string; tierId?: string } }>;
    };
    const resumeOptions = await internals.applyAutoRoutedResume({
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    expect(resumeOptions.model).toBe(HARD_MODEL);
    expect(resumeOptions.autoModelRoutingRecord).toMatchObject({
      status: "routed",
      tierId: "hard",
    });
  });

  it("a resume under Auto finds the routed turn behind more than twenty non-retry rows", async () => {
    const { session, historyService, streamMessage } = await createHarness({
      experimentEnabled: true,
    });
    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    await session.waitForIdle();
    for (let index = 0; index < 25; index += 1) {
      const report = createMuxMessage(
        `subagent-report-${index}`,
        "user",
        formatSubagentReportEnvelope({
          taskId: `task-${index}`,
          agentType: "explore",
          status: "completed",
          title: "Findings",
          reportMarkdown: "done",
        }),
        { timestamp: Date.now(), synthetic: true, uiVisible: true }
      );
      expect((await historyService.appendToHistory("ws-auto-routing", report)).success).toBe(true);
    }
    expect(streamMessage).toHaveBeenCalledTimes(1);

    const internals = session as unknown as {
      applyAutoRoutedResume(options: {
        model: string;
        agentId: string;
        autoModelRouting?: boolean;
      }): Promise<{ model: string; autoModelRoutingRecord?: { status: string; tierId?: string } }>;
    };
    const resumeOptions = await internals.applyAutoRoutedResume({
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    expect(resumeOptions.model).toBe(HARD_MODEL);
    expect(resumeOptions.autoModelRoutingRecord).toMatchObject({
      status: "routed",
      tierId: "hard",
    });
  });

  it("bills the evaluator's usage to the workspace even when the verdict falls back", async () => {
    const usage = { inputTokens: 40, outputTokens: 3, totalTokens: 43 };
    const providerMetadata = { openai: { cachedPromptTokens: 0 } };
    const { session, recordHeadlessUsage } = await createHarness({
      experimentEnabled: true,
      evaluationModel: "openai:gpt-5-nano",
      // "extreme" maps nothing, so the turn falls back after paying for the verdict.
      classify: () =>
        Promise.resolve(
          Ok({
            ...decision("extreme"),
            evaluationModel: "openai:gpt-5-nano",
            usage,
            providerMetadata,
          })
        ),
    });
    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    expect(recordHeadlessUsage).toHaveBeenCalledTimes(1);
    expect(recordHeadlessUsage).toHaveBeenCalledWith(
      "ws-auto-routing",
      "openai:gpt-5-nano",
      usage,
      providerMetadata,
      { analyticsSource: "auto_model_routing" }
    );
  });

  it("a resume with only thinking Auto keeps a newly picked concrete model", async () => {
    const { session, streamMessage } = await createHarness({ experimentEnabled: true });
    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoModelRouting: true,
      autoThinkingLevel: true,
    });
    await session.waitForIdle();

    // The user left model Auto and picked a concrete model before continuing.
    await session.resumeStream({
      model: "anthropic:claude-3-5-haiku-latest",
      agentId: "exec",
      thinkingLevel: "low",
      autoThinkingLevel: true,
    });
    await session.waitForIdle();

    const resumeOptions = streamMessage.mock.calls[1]?.[0];
    expect(resumeOptions?.modelString).toBe("anthropic:claude-3-5-haiku-latest");
    expect(resumeOptions?.thinkingLevel).toBe("high");
    // The record names the routed model, which this resume no longer runs on.
    expect(resumeOptions?.autoModelRouting).toBeUndefined();
  });

  it("a resume with only model Auto keeps a newly picked concrete thinking level", async () => {
    const { session, streamMessage } = await createHarness({ experimentEnabled: true });
    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoModelRouting: true,
      autoThinkingLevel: true,
    });
    await session.waitForIdle();

    // The user left thinking Auto and picked a level below the routed "high".
    await session.resumeStream({
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "medium",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    const resumeOptions = streamMessage.mock.calls[1]?.[0];
    expect(resumeOptions?.modelString).toBe(HARD_MODEL);
    expect(resumeOptions?.thinkingLevel).toBe("medium");
    expect(resumeOptions?.autoModelRouting).toMatchObject({ status: "routed", tierId: "hard" });
    // The record's thinking level says "Auto set it"; this resume ran on the user's pick.
    expect(resumeOptions?.autoModelRouting?.thinkingLevel).toBeUndefined();
  });

  it("skips the paid evaluation when a budgeted goal cannot price the evaluator", async () => {
    const { session, historyService, classify } = await createHarness({
      experimentEnabled: true,
      evaluationModel: "openai:gpt-5-nano",
      unpricedModels: ["openai:gpt-5-nano"],
    });
    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    expect(classify).not.toHaveBeenCalled();
    const row = await persistedUserRow(historyService);
    expect(row.metadata?.autoModelRouting).toMatchObject({
      status: "fallback",
      model: COMPOSER_MODEL,
      reason: "openai:gpt-5-nano has no pricing data for the budgeted goal",
    });
  });

  it("keeps display-only rows (rejected prompts, workflow triggers) out of the evaluator context", async () => {
    const { session, historyService, classify } = await createHarness({ experimentEnabled: true });
    for (const [id, text, metadata] of [
      ["user-kept", "kept earlier prompt", {}],
      ["user-rejected", "rejected oversized prompt", { contextBudgetRejected: true }],
      [
        "user-workflow",
        "/workflow display-only trigger",
        {
          muxMetadata: {
            type: "workflow-trigger-display",
            runId: "wfr_1",
            rawCommand: "/workflow",
          },
        },
      ],
    ] as const) {
      expect(
        (
          await historyService.appendToHistory(
            "ws-auto-routing",
            createMuxMessage(id, "user", text, { timestamp: Date.now() - 1_000, ...metadata })
          )
        ).success
      ).toBe(true);
    }

    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    const recent = classify.mock.calls[0]?.[0]?.recentUserMessages ?? [];
    expect(recent).toContain("kept earlier prompt");
    expect(recent).not.toContain("rejected oversized prompt");
    expect(recent).not.toContain("/workflow display-only trigger");
  });

  it("drops a malformed routing record from a recovered compaction follow-up", async () => {
    const { session, historyService, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
    });
    // A hand-edited summary: the follow-up is fine, its provenance record is not.
    const summary = createMuxMessage("summary", "assistant", "compacted summary", {
      timestamp: Date.now() - 1_000,
      compactionBoundary: true,
      compacted: "user",
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp: { text: "continue after compaction", model: HARD_MODEL, agentId: "exec" },
      },
    });
    (
      summary.metadata!.muxMetadata as unknown as { pendingFollowUp: Record<string, unknown> }
    ).pendingFollowUp.autoModelRouting = { status: "routed", model: HARD_MODEL };
    expect((await historyService.appendToHistory("ws-auto-routing", summary)).success).toBe(true);

    expect(await session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(true);
    await session.waitForIdle();

    expect(classify).not.toHaveBeenCalled();
    const options = streamMessage.mock.calls[0]?.[0];
    expect(options?.modelString).toBe(HARD_MODEL);
    expect(options?.autoModelRouting).toBeUndefined();
  });

  it("a resume after leaving Auto uses the explicit model and drops the record", async () => {
    const { session, streamMessage } = await createHarness({ experimentEnabled: true });
    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    await session.resumeStream({ model: COMPOSER_MODEL, agentId: "exec" });
    await session.waitForIdle();

    const resumeOptions = streamMessage.mock.calls[1]?.[0];
    expect(resumeOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(resumeOptions?.autoModelRouting).toBeUndefined();
  });

  it("a resume that names the routed model itself keeps the record", async () => {
    const { session, streamMessage } = await createHarness({ experimentEnabled: true });
    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    // Startup retries replay retrySendOptions, which already hold the routed model.
    await session.resumeStream({ model: HARD_MODEL, agentId: "exec", thinkingLevel: "high" });
    await session.waitForIdle();

    const resumeOptions = streamMessage.mock.calls[1]?.[0];
    expect(resumeOptions?.modelString).toBe(HARD_MODEL);
    expect(resumeOptions?.autoModelRouting).toMatchObject({ status: "routed", tierId: "hard" });
  });

  it("a resume on the direct twin of a Coder-routed tier model drops the record", async () => {
    const coderRouted = "coder:openai/gpt-5.5";
    const { session, streamMessage } = await createHarness({
      experimentEnabled: true,
      tiers: [TIERS[0], { ...TIERS[1], model: coderRouted }, TIERS[2]],
    });
    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      autoModelRouting: true,
    });
    await session.waitForIdle();
    expect(streamMessage.mock.calls[0]?.[0]?.modelString).toBe(coderRouted);

    // Same canonical model, different route: the badge must not claim the Coder run.
    await session.resumeStream({ model: HARD_MODEL, agentId: "exec" });
    await session.waitForIdle();

    const resumeOptions = streamMessage.mock.calls[1]?.[0];
    expect(resumeOptions?.modelString).toBe(HARD_MODEL);
    expect(resumeOptions?.autoModelRouting).toBeUndefined();
  });

  it("classifies the user follow-up of a /compact request once and stores it on the follow-up", async () => {
    const { session, historyService, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
    });
    const compactionModel = "anthropic:claude-3-5-haiku-latest";

    const result = await session.sendMessage("/compact\nRefactor the scheduler", {
      model: compactionModel,
      agentId: "compact",
      thinkingLevel: "low",
      autoModelRouting: true,
      autoThinkingLevel: true,
      muxMetadata: {
        type: "compaction-request",
        rawCommand: "/compact\nRefactor the scheduler",
        commandPrefix: "/compact",
        parsed: {
          model: compactionModel,
          followUpContent: {
            text: "Refactor the scheduler",
            model: COMPOSER_MODEL,
            agentId: "exec",
            thinkingLevel: "low",
          },
        },
      },
    });
    expect(result.success).toBe(true);
    await session.waitForIdle();

    // The compaction turn itself runs unrouted; only the follow-up is classified.
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0]?.[0]?.prompt).toBe("Refactor the scheduler");
    const compactionStream = streamMessage.mock.calls[0]?.[0];
    expect(compactionStream?.modelString).toBe(compactionModel);
    expect(compactionStream?.autoModelRouting).toBeUndefined();

    const row = await persistedUserRow(historyService);
    const muxMetadata = row.metadata?.muxMetadata;
    const followUp =
      muxMetadata?.type === "compaction-request" ? muxMetadata.parsed.followUpContent : undefined;
    expect(followUp?.model).toBe(HARD_MODEL);
    expect(followUp?.thinkingLevel).toBe("high");
    expect(followUp?.autoModelRouting).toMatchObject({
      status: "routed",
      tierId: "hard",
      model: HARD_MODEL,
      requestedFallbackModel: COMPOSER_MODEL,
    });
  });

  it("keeps a fallback record on an attachment-only /compact follow-up", async () => {
    const { session, historyService, classify } = await createHarness({ experimentEnabled: true });
    const compactionModel = "anthropic:claude-3-5-haiku-latest";

    const result = await session.sendMessage("/compact", {
      model: compactionModel,
      agentId: "compact",
      autoModelRouting: true,
      muxMetadata: {
        type: "compaction-request",
        rawCommand: "/compact",
        commandPrefix: "/compact",
        parsed: {
          model: compactionModel,
          followUpContent: {
            text: "",
            model: COMPOSER_MODEL,
            agentId: "exec",
            fileParts: [{ url: "data:image/png;base64,iVBORw0KGgo=", mediaType: "image/png" }],
          },
        },
      },
    });
    expect(result.success).toBe(true);
    await session.waitForIdle();

    expect(classify).not.toHaveBeenCalled();
    const row = await persistedUserRow(historyService);
    const muxMetadata = row.metadata?.muxMetadata;
    const followUp =
      muxMetadata?.type === "compaction-request" ? muxMetadata.parsed.followUpContent : undefined;
    expect(followUp?.model).toBe(COMPOSER_MODEL);
    expect(followUp?.autoModelRouting).toMatchObject({
      status: "fallback",
      model: COMPOSER_MODEL,
      requestedFallbackModel: COMPOSER_MODEL,
    });
  });

  it("classifies a review-only /compact follow-up on the text the redispatch sends", async () => {
    const { session, historyService, classify } = await createHarness({ experimentEnabled: true });
    const compactionModel = "anthropic:claude-3-5-haiku-latest";

    const result = await session.sendMessage("/compact", {
      model: compactionModel,
      agentId: "compact",
      autoModelRouting: true,
      muxMetadata: {
        type: "compaction-request",
        rawCommand: "/compact",
        commandPrefix: "/compact",
        parsed: {
          model: compactionModel,
          followUpContent: {
            text: "",
            model: COMPOSER_MODEL,
            agentId: "exec",
            reviews: [
              {
                filePath: "src/scheduler.ts",
                lineRange: "+4-9",
                selectedCode: "setTimeout(tick, 0)",
                userNote: "Rework the scheduler loop",
              },
            ],
          },
        },
      },
    });
    expect(result.success).toBe(true);
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0]?.[0]?.prompt).toContain("Rework the scheduler loop");
    const row = await persistedUserRow(historyService);
    const muxMetadata = row.metadata?.muxMetadata;
    const followUp =
      muxMetadata?.type === "compaction-request" ? muxMetadata.parsed.followUpContent : undefined;
    expect(followUp?.model).toBe(HARD_MODEL);
    expect(followUp?.autoModelRouting).toMatchObject({ status: "routed", tierId: "hard" });
  });

  it("routes a /compact follow-up past attachments the compaction is about to fold away", async () => {
    const { session, historyService, classify } = await createHarness({
      experimentEnabled: true,
      tiers: TIERS_WITH_GROK,
    });
    const earlier = createMuxMessage("earlier-image", "user", "Look at this", undefined, [
      UNSUPPORTED_IMAGE,
    ]);
    expect((await historyService.appendToHistory("ws-auto-routing", earlier)).success).toBe(true);
    const compactionModel = "anthropic:claude-3-5-haiku-latest";

    const result = await session.sendMessage("/compact\nRefactor the scheduler", {
      model: compactionModel,
      agentId: "compact",
      autoModelRouting: true,
      muxMetadata: {
        type: "compaction-request",
        rawCommand: "/compact\nRefactor the scheduler",
        commandPrefix: "/compact",
        parsed: {
          model: compactionModel,
          followUpContent: {
            text: "Refactor the scheduler",
            model: COMPOSER_MODEL,
            agentId: "exec",
          },
        },
      },
    });
    expect(result.success).toBe(true);
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    const followUp = await persistedCompactionFollowUp(historyService);
    expect(followUp?.model).toBe("xai:grok-3");
    expect(followUp?.autoModelRouting).toMatchObject({ status: "routed", tierId: "hard" });
  });

  it("never calls the classifier when the flag is absent", async () => {
    const { session, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
    });

    await session.sendMessage("hello", { model: COMPOSER_MODEL, agentId: "exec" });
    await session.waitForIdle();

    expect(classify).not.toHaveBeenCalled();
    expect(streamMessage.mock.calls[0]?.[0]?.autoModelRouting).toBeUndefined();
  });
});
