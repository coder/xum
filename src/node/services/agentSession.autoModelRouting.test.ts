import { afterEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "events";
import type { AIService, StreamMessageOptions } from "@/node/services/aiService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { Config } from "@/node/config";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type {
  AutoModelRouter,
  AutoModelRouterClassifyInput,
} from "@/node/services/autoModelRouter";
import type { AutoModelRoutingDecision } from "@/common/types/autoModelRouting";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { Err, Ok, type Result } from "@/common/types/result";
import { createTestHistoryService } from "./testHistoryService";
import {
  createStartedTurnHandle,
  createStreamLifecycleMocks,
  createTestAgentSession,
} from "./agentSession.testHarness";

const COMPOSER_MODEL = "anthropic:claude-3-5-sonnet-latest";
const HARD_MODEL = "openai:gpt-5.5";

const TIERS = [
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
    tiers?: typeof TIERS;
    /** Models the budgeted-goal pricing gate refuses. */
    unpricedModels?: string[];
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
      isExperimentEnabled: mock(
        (id: ExperimentId) => id === EXPERIMENT_IDS.AUTO_MODEL_ROUTING && options.experimentEnabled
      ),
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    }) as unknown as AIService;
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
