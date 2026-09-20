import { afterEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "events";
import type { AIService, StreamMessageOptions } from "@/node/services/aiService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { Config } from "@/node/config";
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
  }) {
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    const config = {
      rootDir: "/tmp",
      sessionsDir: "/tmp",
      srcDir: "/tmp",
      loadConfigOrDefault: () => ({ autoModelRouting: { tiers: TIERS } }),
    } as unknown as Config;

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
