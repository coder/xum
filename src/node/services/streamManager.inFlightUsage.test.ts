/**
 * Running streams write each finished step to their own in-flight usage file
 * (SessionUsageService), so a Xum restart mid-turn keeps the turn's finished steps and every
 * settle counts the turn once. Real StreamManager, SessionUsageService and HistoryService.
 */
import { describe, test, expect, spyOn, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { Ok } from "@/common/types/result";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { getTotalCost, sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import type { ModelFallbackOptions } from "./streamManager";
import { SessionUsageService, type SessionUsageFile } from "./sessionUsageService";
import { createStreamManagerForTests } from "./streamManager.testHarness";
import { createTestHistoryService } from "./testHistoryService";
import { countTokens } from "@/node/utils/main/tokenizer";
import {
  installStreamManagerTestHistory,
  historyService,
  historyConfig,
  createTestLanguageModel,
  REFUSAL_FINISH,
  STOP_FINISH,
  runTurnForTests,
  scriptedStreamText,
} from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

const MODEL = KNOWN_MODELS.SONNET.id;
const FALLBACK_MODEL = "openai:gpt-5.6-luna";
const STEP = { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 };

const finishStep = (usage: Record<string, number>) => ({ type: "finish-step", usage });
const text = (value: string) => ({ type: "text-delta", text: value });

function totals(ledger: SessionUsageFile | undefined) {
  const total = sumUsageHistory(Object.values(ledger?.byModel ?? {}));
  return {
    tokens: total ? total.input.tokens + total.output.tokens + total.cached.tokens : 0,
    cost: getTotalCost(total) ?? 0,
  };
}

function tokensByModel(ledger: SessionUsageFile | undefined): Record<string, number> {
  return Object.fromEntries(
    Object.entries(ledger?.byModel ?? {}).map(([model, usage]) => [
      model,
      usage.input.tokens + usage.output.tokens,
    ])
  );
}

function pricedCost(usage: Record<string, number>, model = MODEL): number {
  const display = createDisplayUsage(usage, model);
  if (!display) throw new Error("expected priced usage");
  return getTotalCost(display) ?? NaN;
}

async function inFlightFiles(sessionsDir: string, workspaceId: string): Promise<string[]> {
  try {
    return await fs.readdir(path.join(sessionsDir, workspaceId, "session-usage.in-flight"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const snapshotCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of snapshotCleanups.splice(0)) await cleanup();
});

/**
 * Copies the workspace's session directory as it is right now into a fresh Xum home and
 * returns a SessionUsageService on it: exactly what a Xum killed at this point restarts with.
 */
async function restartFromSnapshot(workspaceId: string): Promise<() => SessionUsageService> {
  const restarted = await createTestHistoryService();
  snapshotCleanups.push(restarted.cleanup);
  await fs.cp(
    path.join(historyConfig.sessionsDir, workspaceId),
    path.join(restarted.config.sessionsDir, workspaceId),
    { recursive: true }
  );
  return () => new SessionUsageService(restarted.config, restarted.historyService);
}

function preparedFallback(): ModelFallbackOptions {
  return {
    chain: [FALLBACK_MODEL],
    prepare: (nextModelString: string) =>
      Promise.resolve(
        Ok({
          model: createTestLanguageModel("fallback-model"),
          modelString: nextModelString,
          messages: [],
          system: "You are a helpful assistant",
          tools: undefined,
          thinkingLevel: "off" as const,
        })
      ),
  };
}

describe("StreamManager - in-flight session usage", () => {
  test("a Xum restart mid-turn keeps the turn's finished steps, and the settle counts it once", async () => {
    const workspaceId = "in-flight-restart";
    const sessionUsageService = new SessionUsageService(historyConfig, historyService);
    let restarted: (() => SessionUsageService) | undefined;
    let defaultView: SessionUsageFile | undefined;
    let liveView: SessionUsageFile | undefined;
    const streamManager = createStreamManagerForTests(historyService, {
      sessionUsageService,
      streamText: scriptedStreamText([
        {
          chunks: [
            text("working"),
            finishStep(STEP),
            finishStep(STEP),
            async () => {
              restarted = await restartFromSnapshot(workspaceId);
              defaultView = await sessionUsageService.getSessionUsage(workspaceId);
              liveView = await sessionUsageService.getSessionUsage(workspaceId, {
                includeLiveStreams: true,
              });
            },
            finishStep(STEP),
            STOP_FINISH,
          ],
          usage: { inputTokens: 3_000, outputTokens: 300, totalTokens: 3_300 },
        },
      ]),
    });

    const { completion } = await runTurnForTests(streamManager, {
      workspaceId,
      modelString: MODEL,
    });
    expect(completion.status).toBe("completed");

    const twoSteps = { inputTokens: 2_000, outputTokens: 200, totalTokens: 2_200 };
    // Killed after two finished steps: the restarted Xum counts both.
    const afterRestart = totals(await restarted!().getSessionUsage(workspaceId));
    expect(afterRestart.tokens).toBe(2_200);
    expect(afterRestart.cost).toBeCloseTo(pricedCost(twoSteps), 12);
    // While the turn ran, the Costs tab view left it out (it adds the live stream itself).
    expect(totals(defaultView).tokens).toBe(0);
    expect(totals(liveView).tokens).toBe(2_200);

    // The settled turn is in the ledger once and its in-flight file is gone.
    expect(totals(await sessionUsageService.getSessionUsage(workspaceId)).tokens).toBe(3_300);
    expect(await inFlightFiles(historyConfig.sessionsDir, workspaceId)).toEqual([]);
    const afterSettleRestart = new SessionUsageService(historyConfig, historyService);
    expect(totals(await afterSettleRestart.getSessionUsage(workspaceId)).tokens).toBe(3_300);
  });

  test("an aborted turn settles once and leaves no in-flight file", async () => {
    const workspaceId = "in-flight-abort";
    const sessionUsageService = new SessionUsageService(historyConfig, historyService);
    const processed = Promise.withResolvers<void>();
    const streamManager = createStreamManagerForTests(historyService, {
      sessionUsageService,
      streamText: scriptedStreamText([
        {
          chunks: [text("partial"), finishStep(STEP), finishStep(STEP), () => processed.resolve()],
          holdUntilAbort: true,
        },
      ]),
    });
    const turn = runTurnForTests(streamManager, { workspaceId, modelString: MODEL });
    await processed.promise;
    expect(await inFlightFiles(historyConfig.sessionsDir, workspaceId)).toHaveLength(1);

    await streamManager.stopStream(workspaceId, { abortReason: "user" });
    expect((await turn).completion.status).toBe("aborted");

    expect(totals(await sessionUsageService.getSessionUsage(workspaceId)).tokens).toBe(2_200);
    expect(await inFlightFiles(historyConfig.sessionsDir, workspaceId)).toEqual([]);
    const restarted = new SessionUsageService(historyConfig, historyService);
    expect(totals(await restarted.getSessionUsage(workspaceId)).tokens).toBe(2_200);
  });

  test("an errored turn settles once and leaves no in-flight file", async () => {
    const workspaceId = "in-flight-error";
    const sessionUsageService = new SessionUsageService(historyConfig, historyService);
    const streamManager = createStreamManagerForTests(historyService, {
      sessionUsageService,
      streamText: scriptedStreamText([
        {
          chunks: [
            text("partial answer before failure"),
            finishStep({ inputTokens: 900, outputTokens: 40, totalTokens: 940 }),
            () => Promise.reject(new Error("stream truncated")),
          ],
        },
      ]),
    });
    const { completion } = await runTurnForTests(streamManager, {
      workspaceId,
      modelString: MODEL,
    });
    expect(completion.status).toBe("failed");

    expect(totals(await sessionUsageService.getSessionUsage(workspaceId)).tokens).toBe(940);
    expect(await inFlightFiles(historyConfig.sessionsDir, workspaceId)).toEqual([]);
  });

  test("an errored turn counts reasoning tokens that the provider did not report", async () => {
    const workspaceId = "in-flight-error-reasoning";
    const reasoning = "Thinking about the answer before the stream fails";
    const sessionUsageService = new SessionUsageService(historyConfig, historyService);
    const streamManager = createStreamManagerForTests(historyService, {
      sessionUsageService,
      streamText: scriptedStreamText([
        {
          chunks: [
            { type: "reasoning-delta", text: reasoning },
            finishStep({ inputTokens: 900, outputTokens: 40, totalTokens: 940 }),
            () => Promise.reject(new Error("stream truncated")),
          ],
        },
      ]),
    });
    const { completion } = await runTurnForTests(streamManager, {
      workspaceId,
      modelString: MODEL,
    });
    expect(completion.status).toBe("failed");

    const ledger = await sessionUsageService.getSessionUsage(workspaceId);
    const total = sumUsageHistory(Object.values(ledger?.byModel ?? {}));
    expect(total?.reasoning.tokens).toBe(await countTokens(MODEL, reasoning));
  });

  for (const ledgerBefore of ["an existing ledger", "no ledger (rebuilt from history)"]) {
    test(`a failed final ledger write keeps the finished steps, counted once: ${ledgerBefore}`, async () => {
      const workspaceId = "in-flight-write-failure";
      const sessionUsageService = new SessionUsageService(historyConfig, historyService);
      const seeded = ledgerBefore === "an existing ledger";
      if (seeded) {
        const earlier = createDisplayUsage(
          { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
          MODEL
        );
        await sessionUsageService.recordUsage(workspaceId, MODEL, earlier!);
      }
      spyOn(sessionUsageService, "recordUsage").mockRejectedValueOnce(new Error("disk full"));
      const streamManager = createStreamManagerForTests(historyService, {
        sessionUsageService,
        streamText: scriptedStreamText([
          { chunks: [text("working"), finishStep(STEP), STOP_FINISH], usage: STEP },
        ]),
      });
      const { completion } = await runTurnForTests(streamManager, {
        workspaceId,
        modelString: MODEL,
      });
      expect(completion.status).toBe("completed");

      // The in-flight file is the only durable record of the step: nothing discarded it.
      expect(await inFlightFiles(historyConfig.sessionsDir, workspaceId)).toHaveLength(1);
      // Without a ledger, the rebuild counts the saved message, so the file must not add to it.
      const expected = 1_100 + (seeded ? 10 : 0);
      expect(totals(await sessionUsageService.getSessionUsage(workspaceId)).tokens).toBe(expected);
      expect(totals(await sessionUsageService.getSessionUsage(workspaceId)).tokens).toBe(expected);
      expect(await inFlightFiles(historyConfig.sessionsDir, workspaceId)).toEqual([]);
    });
  }

  test("a refused attempt and its fallback count once each, also across a restart mid-fallback", async () => {
    const workspaceId = "in-flight-refusal-fallback";
    const sessionUsageService = new SessionUsageService(historyConfig, historyService);
    let restarted: (() => SessionUsageService) | undefined;
    const streamManager = createStreamManagerForTests(historyService, {
      sessionUsageService,
      streamText: scriptedStreamText([
        {
          chunks: [
            finishStep({ inputTokens: 500, outputTokens: 0, totalTokens: 500 }),
            REFUSAL_FINISH,
          ],
          usage: { inputTokens: 500, outputTokens: 0, totalTokens: 500 },
        },
        {
          chunks: [
            finishStep({ inputTokens: 300, outputTokens: 20, totalTokens: 320 }),
            async () => {
              restarted = await restartFromSnapshot(workspaceId);
            },
            text("done"),
            finishStep({ inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
            STOP_FINISH,
          ],
          usage: { inputTokens: 400, outputTokens: 30, totalTokens: 430 },
        },
      ]),
    });

    const { completion } = await runTurnForTests(streamManager, {
      workspaceId,
      modelString: MODEL,
      modelFallback: preparedFallback(),
    });
    expect(completion.status).toBe("completed");

    // Killed after the fallback's first step: the refused attempt was already settled, and
    // the fallback's finished step comes back from its in-flight file.
    expect(tokensByModel(await restarted!().getSessionUsage(workspaceId))).toEqual({
      [MODEL]: 500,
      [FALLBACK_MODEL]: 320,
    });
    expect(tokensByModel(await sessionUsageService.getSessionUsage(workspaceId))).toEqual({
      [MODEL]: 500,
      [FALLBACK_MODEL]: 430,
    });
    expect(await inFlightFiles(historyConfig.sessionsDir, workspaceId)).toEqual([]);
  });
});
