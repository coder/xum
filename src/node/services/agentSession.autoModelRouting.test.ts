import { afterEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "events";
import type { AIService, StreamMessageOptions } from "@/node/services/aiService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { CompactionMonitor } from "./compactionMonitor";
import type { Config } from "@/node/config";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type {
  AutoModelRouter,
  AutoModelRouterClassifyInput,
} from "@/node/services/autoModelRouter";
import type { AutoModelRoutingDecision } from "@/common/types/autoModelRouting";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { createMuxMessage } from "@/common/types/message";
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
    classifierModel: "jev-1.13.0",
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
    /** Models the budgeted-goal pricing gate refuses. */
    unpricedModels?: string[];
    /** When set, provider policy is enforced and refuses exactly these models. */
    policyDeniedModels?: string[];
  }) {
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    const config = {
      rootDir: "/tmp",
      sessionsDir: "/tmp",
      srcDir: "/tmp",
      loadConfigOrDefault: () => ({ autoModelRouting: { tiers: options.tiers ?? TIERS } }),
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
    const policyDenied = options.policyDeniedModels;
    const classify = mock<NonNullable<typeof options.classify>>(
      options.classify ?? (() => Promise.resolve(Ok(decision("hard"))))
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
      workspaceGoalService,
      policyService:
        policyDenied == null
          ? undefined
          : {
              isEnforced: () => true,
              isModelAllowed: (provider: string, modelId: string) =>
                !policyDenied.includes(`${provider}:${modelId}`),
            },
    });
    return { session, historyService, streamMessage, classify };
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

  it("runs the turn on the chosen tier's model and strips the flag from the retry snapshot", async () => {
    const { session, historyService, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
    });

    const result = await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoModelRouting: true,
    });
    expect(result.success).toBe(true);
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0]?.[0]).toMatchObject({
      prompt: "Refactor the scheduler",
      tiers: TIERS,
    });
    expect(streamMessage).toHaveBeenCalledTimes(1);
    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe(HARD_MODEL);
    expect(streamOptions?.thinkingLevel).toBe("high");
    expect(streamOptions?.autoModelRouting).toMatchObject({
      status: "routed",
      tierId: "hard",
      tierLabel: "Hard",
      model: HARD_MODEL,
      requestedFallbackModel: COMPOSER_MODEL,
      confidence: 0.9,
    });

    const row = await persistedUserRow(historyService);
    const retry = row.metadata?.retrySendOptions as Record<string, unknown> | undefined;
    expect(retry?.model).toBe(HARD_MODEL);
    expect(retry?.thinkingLevel).toBe("high");
    expect(retry).not.toHaveProperty("autoModelRouting");
    expect(retry).not.toHaveProperty("autoModelRoutingRecord");
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

  it("classifies when a model-less tier sets a thinking level and applies it to the composer model", async () => {
    const { session, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
      classify: () => Promise.resolve(Ok(decision("extreme"))),
      tiers: TIERS.map(({ model: _model, thinkingLevel: _level, ...tier }) =>
        tier.id === "extreme" ? { ...tier, thinkingLevel: "high" } : tier
      ),
    });

    await session.sendMessage("design it", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    const streamOptions = streamMessage.mock.calls[0]?.[0];
    expect(streamOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(streamOptions?.thinkingLevel).toBe("high");
    expect(streamOptions?.autoModelRouting).toMatchObject({
      status: "routed",
      tierId: "extreme",
      model: COMPOSER_MODEL,
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
      tiers: TIERS.map((tier) => (tier.id === "hard" ? { ...tier, model: "xai:grok-3" } : tier)),
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

  it("falls back when a PDF earlier in the conversation cannot be sent to the chosen tier's model", async () => {
    const { session, historyService, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
      tiers: TIERS.map((tier) => (tier.id === "hard" ? { ...tier, model: "xai:grok-3" } : tier)),
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
    (row.metadata as Record<string, unknown>).autoModelRouting = { model: 42, status: "routed" };
    expect((await historyService.appendToHistory("ws-auto-routing", row)).success).toBe(true);

    const result = await session.resumeStream({ model: COMPOSER_MODEL, agentId: "exec" });
    expect(result.success).toBe(true);
    await session.waitForIdle();

    const resumeOptions = streamMessage.mock.calls[0]?.[0];
    expect(resumeOptions?.modelString).toBe(COMPOSER_MODEL);
    expect(resumeOptions?.autoModelRouting).toBeUndefined();
  });

  it("carries the routing record on the on-send compaction follow-up instead of reclassifying", async () => {
    const { session, historyService, classify } = await createHarness({ experimentEnabled: true });
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

    const result = await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoModelRouting: true,
    });
    expect(result.success).toBe(true);
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    const history = await historyService.getHistoryFromLatestBoundary("ws-auto-routing");
    if (!history.success) throw new Error(history.error);
    const compactionRow = history.data.find(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    const muxMetadata = compactionRow?.metadata?.muxMetadata;
    const followUp =
      muxMetadata?.type === "compaction-request" ? muxMetadata.parsed.followUpContent : undefined;
    expect(followUp?.model).toBe(HARD_MODEL);
    expect(followUp?.autoModelRouting).toMatchObject({
      status: "routed",
      tierId: "hard",
      model: HARD_MODEL,
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
  });

  it("falls back when provider policy no longer allows the chosen tier's model", async () => {
    const { session, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
      policyDeniedModels: [HARD_MODEL],
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
    expect(streamOptions?.autoModelRouting?.reason).toContain("policy");
  });

  it("a manual resume under Auto continues on the routed model and keeps the record", async () => {
    const { session, streamMessage, classify } = await createHarness({
      experimentEnabled: true,
    });
    await session.sendMessage("Refactor the scheduler", {
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoModelRouting: true,
    });
    await session.waitForIdle();

    // The renderer resumes with the composer's current options; Auto is still selected.
    const resumed = await session.resumeStream({
      model: COMPOSER_MODEL,
      agentId: "exec",
      thinkingLevel: "low",
      autoModelRouting: true,
    });
    expect(resumed).toEqual(Ok({ started: true }));
    await session.waitForIdle();

    expect(classify).toHaveBeenCalledTimes(1);
    expect(streamMessage).toHaveBeenCalledTimes(2);
    const resumeOptions = streamMessage.mock.calls[1]?.[0];
    expect(resumeOptions?.modelString).toBe(HARD_MODEL);
    expect(resumeOptions?.thinkingLevel).toBe("high");
    expect(resumeOptions?.autoModelRouting).toMatchObject({ status: "routed", tierId: "hard" });
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
