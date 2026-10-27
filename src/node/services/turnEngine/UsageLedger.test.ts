import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { HEADLESS_USAGE_FILE_NAME } from "@/common/constants/paths";
import { MODEL_FALLBACK_REFUSAL_TOOL_NAME } from "@/common/types/message";
import type { Config } from "@/node/config";
import type { HistoryService } from "@/node/services/historyService";
import { log, type Logger } from "@/node/services/log";
import { SessionUsageService, type SessionUsageFile } from "@/node/services/sessionUsageService";
import { createTestHistoryService } from "@/node/services/testHistoryService";

import { UsageLedger, type UsageTurn } from "./UsageLedger";

const WORKSPACE_ID = "ledger-ws";
const MODEL = KNOWN_MODELS.SONNET.id;
const FALLBACK_MODEL = "openai:gpt-5.6-luna";
const STEP = { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 };
const TWO_STEPS = { inputTokens: 2_000, outputTokens: 200, totalTokens: 2_200 };

/** Input plus output tokens per model in a session-usage view. */
const tokensByModel = (usage: SessionUsageFile | undefined): Record<string, number> =>
  Object.fromEntries(
    Object.entries(usage?.byModel ?? {}).map(([model, entry]) => [
      model,
      entry.input.tokens + entry.output.tokens,
    ])
  );

const totalTokens = (usage: SessionUsageFile | undefined): number =>
  Object.values(tokensByModel(usage)).reduce((sum, tokens) => sum + tokens, 0);

describe("UsageLedger", () => {
  let historyService: HistoryService;
  let config: Config;
  let cleanup: () => Promise<void>;
  let sessionUsage: SessionUsageService;
  let ledger: UsageLedger;
  /** What the ledger logged at warn or error. */
  let logged: unknown[];

  beforeEach(async () => {
    ({ historyService, config, cleanup } = await createTestHistoryService());
    sessionUsage = new SessionUsageService(config, historyService);
    logged = [];
    const workspaceLog: Logger = {
      ...log,
      warn: (message: unknown) => logged.push(message),
      error: (message: unknown) => logged.push(message),
    };
    ledger = new UsageLedger({
      sessionUsageService: sessionUsage,
      getProvidersConfig: () => null,
      workspaceLogger: () => workspaceLog,
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  const turn = (overrides: Partial<UsageTurn> = {}): UsageTurn => ({
    messageId: "msg-1",
    model: MODEL,
    metadataModel: MODEL,
    toolModelUsages: [],
    cumulativeUsage: { ...STEP },
    ...overrides,
  });

  const inFlightFiles = async (): Promise<string[]> => {
    try {
      return await fs.readdir(
        path.join(config.sessionsDir, WORKSPACE_ID, "session-usage.in-flight")
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };

  /**
   * What a Xum killed now and restarted would count: a copy of the session directory, so
   * the restarted service cannot fold this process's live in-flight files.
   */
  const afterRestart = async (): Promise<SessionUsageFile | undefined> => {
    const restarted = await createTestHistoryService();
    try {
      await fs.cp(
        path.join(config.sessionsDir, WORKSPACE_ID),
        path.join(restarted.config.sessionsDir, WORKSPACE_ID),
        { recursive: true }
      );
      const service = new SessionUsageService(restarted.config, restarted.historyService);
      return await service.getSessionUsage(WORKSPACE_ID);
    } finally {
      await restarted.cleanup();
    }
  };

  describe("in-flight usage and settle", () => {
    test("the settle of an attempt with in-flight writes counts it once and deletes its file", async () => {
      const attempt = turn();
      await ledger.recordInFlight(WORKSPACE_ID, attempt);
      attempt.cumulativeUsage = { ...TWO_STEPS };
      await ledger.recordInFlight(WORKSPACE_ID, attempt);
      // One file per attempt, holding its latest totals; only the live view adds it.
      expect(await inFlightFiles()).toHaveLength(1);
      expect(totalTokens(await sessionUsage.getSessionUsage(WORKSPACE_ID))).toBe(0);
      expect(
        totalTokens(await sessionUsage.getSessionUsage(WORKSPACE_ID, { includeLiveStreams: true }))
      ).toBe(2_200);
      expect(totalTokens(await afterRestart())).toBe(2_200);

      await ledger.settle(WORKSPACE_ID, attempt, TWO_STEPS, undefined, "settle failed", "warn");
      expect(attempt.inFlightUsageKey).toBeUndefined();
      expect(await inFlightFiles()).toEqual([]);
      expect(totalTokens(await sessionUsage.getSessionUsage(WORKSPACE_ID))).toBe(2_200);
      expect(totalTokens(await afterRestart())).toBe(2_200);
    });

    test("a failed final ledger write keeps the in-flight file, and the next read counts it once", async () => {
      const attempt = turn();
      await ledger.recordInFlight(WORKSPACE_ID, attempt);
      spyOn(sessionUsage, "recordUsage").mockRejectedValueOnce(new Error("ledger locked"));

      await ledger.settle(WORKSPACE_ID, attempt, STEP, undefined, "settle failed", "error");
      expect(logged).toEqual(["settle failed"]);
      expect(attempt.inFlightUsageKey).toBeUndefined();
      // Released, not live: this process now folds the file it kept.
      expect(totalTokens(await sessionUsage.getSessionUsage(WORKSPACE_ID))).toBe(1_100);
      expect(totalTokens(await sessionUsage.getSessionUsage(WORKSPACE_ID))).toBe(1_100);
      expect(totalTokens(await afterRestart())).toBe(1_100);
    });

    test("a discard, or a settle with no usage, drops the in-flight file without counting it", async () => {
      const discarded = turn();
      await ledger.recordInFlight(WORKSPACE_ID, discarded);
      await ledger.discardInFlight(WORKSPACE_ID, discarded);
      expect(discarded.inFlightUsageKey).toBeUndefined();

      const unpriced = turn({ messageId: "msg-2" });
      await ledger.recordInFlight(WORKSPACE_ID, unpriced);
      await ledger.settle(WORKSPACE_ID, unpriced, undefined, undefined, "settle failed", "warn");

      expect(await inFlightFiles()).toEqual([]);
      expect(
        totalTokens(await sessionUsage.getSessionUsage(WORKSPACE_ID, { includeLiveStreams: true }))
      ).toBe(0);
      expect(totalTokens(await afterRestart())).toBe(0);
    });

    test("each attempt of a fallback settles its own in-flight file under its own model", async () => {
      const attempt = turn();
      await ledger.recordInFlight(WORKSPACE_ID, attempt);
      await ledger.settle(WORKSPACE_ID, attempt, STEP, undefined, "settle failed", "warn", MODEL);

      // The fallback attempt reuses the turn: it must start a new in-flight file.
      await ledger.recordInFlight(WORKSPACE_ID, attempt);
      await ledger.settle(
        WORKSPACE_ID,
        attempt,
        STEP,
        undefined,
        "settle failed",
        "warn",
        FALLBACK_MODEL
      );

      expect(await inFlightFiles()).toEqual([]);
      const settled = tokensByModel(await afterRestart());
      expect(Object.values(settled)).toEqual([1_100, 1_100]);
      expect(totalTokens(await sessionUsage.getSessionUsage(WORKSPACE_ID))).toBe(2_200);
    });
  });

  describe("sidecar usage and refusals", () => {
    /** The sources of the headless-usage sidecar rows, in write order. */
    const sidecarSources = async (): Promise<string[]> => {
      const file = path.join(config.sessionsDir, WORKSPACE_ID, HEADLESS_USAGE_FILE_NAME);
      const text = await fs.readFile(file, "utf-8");
      return text
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { source: string }).source);
    };

    test("a dropped partial's usage reaches only the sidecar, with refused hops labeled as refusals", async () => {
      const dropped = turn({
        toolModelUsages: [
          { toolName: MODEL_FALLBACK_REFUSAL_TOOL_NAME, timestamp: 1, model: MODEL, usage: STEP },
          { toolName: "task", timestamp: 2, model: MODEL, usage: STEP },
        ],
      });
      await ledger.recordDroppedPartialUsage(
        WORKSPACE_ID,
        dropped,
        STEP,
        undefined,
        "aborted_stream"
      );
      await ledger.recordDroppedPartialUsage(
        WORKSPACE_ID,
        turn(),
        STEP,
        undefined,
        "errored_stream",
        "refused_stream"
      );

      expect(await sidecarSources()).toEqual([
        "aborted_stream",
        "refused_stream",
        "aborted_stream",
        "refused_stream",
      ]);
      // The session ledger already has (or never gets) this spend.
      expect(totalTokens(await sessionUsage.getSessionUsage(WORKSPACE_ID))).toBe(0);
    });

    test("across a fallback, the refused hop and the answering attempt are each counted once", async () => {
      const attempt = turn();
      await ledger.recordInFlight(WORKSPACE_ID, attempt);
      await ledger.recordRefusedAttempt(WORKSPACE_ID, attempt, MODEL, { usage: STEP });
      expect(attempt.toolModelUsages).toMatchObject([
        { toolName: MODEL_FALLBACK_REFUSAL_TOOL_NAME, usage: STEP },
      ]);

      await ledger.recordInFlight(WORKSPACE_ID, attempt);
      await ledger.settle(
        WORKSPACE_ID,
        attempt,
        STEP,
        undefined,
        "settle failed",
        "warn",
        FALLBACK_MODEL
      );

      expect(await inFlightFiles()).toEqual([]);
      expect(Object.values(tokensByModel(await afterRestart()))).toEqual([1_100, 1_100]);
    });

    test("a refusal that billed nothing still leaves an all-zero record, but no ledger row", async () => {
      const attempt = turn();
      await ledger.recordRefusedAttempt(WORKSPACE_ID, attempt, MODEL, {});
      await ledger.recordTerminalRefusal(WORKSPACE_ID, attempt, MODEL, {});

      const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      expect(attempt.toolModelUsages).toMatchObject([{ usage: zero }]);
      expect(attempt.terminalRefusalUsage).toEqual(zero);
      expect((await sessionUsage.getSessionUsage(WORKSPACE_ID))?.byModel ?? {}).toEqual({});
    });

    test("a terminal refusal keeps its usage for the error row and settles it once", async () => {
      const attempt = turn();
      await ledger.recordInFlight(WORKSPACE_ID, attempt);
      await ledger.recordTerminalRefusal(WORKSPACE_ID, attempt, MODEL, { usage: STEP });

      expect(attempt.terminalRefusalUsage).toEqual(STEP);
      expect(await inFlightFiles()).toEqual([]);
      expect(totalTokens(await afterRestart())).toBe(1_100);
    });
  });

  describe("usage state", () => {
    test("finished steps add up, and the last step is kept for the context display", () => {
      const attempt = turn(UsageLedger.initialState());
      const second = { inputTokens: 1_500, outputTokens: 50, totalTokens: 1_550 };
      ledger.recordStep(attempt, STEP, { anthropic: { cacheCreationInputTokens: 10 } });
      ledger.recordStep(attempt, second, undefined);

      expect(attempt.cumulativeUsage).toMatchObject({
        inputTokens: 2_500,
        outputTokens: 150,
        totalTokens: 2_650,
      });
      expect(attempt.lastStepUsage).toEqual(second);
      expect(attempt.lastStepProviderMetadata).toBeUndefined();
      expect(attempt.cumulativeProviderMetadata).toMatchObject({
        anthropic: { cacheCreationInputTokens: 10 },
      });
    });

    test("end usage is the live total after a preserved-usage restart or without an SDK total", () => {
      const attempt = turn({ cumulativeUsage: { ...TWO_STEPS } });
      const sdkTotal = { ...STEP };

      expect(ledger.endUsage(attempt, sdkTotal, false)).toBe(sdkTotal);
      expect(ledger.endUsage(attempt, sdkTotal, true)).toEqual(TWO_STEPS);
      expect(ledger.endUsage(attempt, undefined, false)).toEqual(TWO_STEPS);
      // No live total to fall back to: the SDK total stands.
      expect(ledger.endUsage(turn(UsageLedger.initialState()), sdkTotal, true)).toBe(sdkTotal);
    });

    test("end provider metadata is a copy of the live metadata only after a preserved-usage restart", () => {
      const metadata = { anthropic: { cacheCreationInputTokens: 10 } };
      const attempt = turn({ cumulativeProviderMetadata: metadata });

      expect(ledger.preservedEndProviderMetadata(attempt, false)).toBeUndefined();
      const preserved = ledger.preservedEndProviderMetadata(attempt, true);
      expect(preserved).toEqual(metadata);
      expect(preserved).not.toBe(metadata);
      expect(ledger.preservedEndProviderMetadata(turn(), true)).toBeUndefined();
    });

    test("a retry reset drops the attempt's in-flight usage and zeroes its totals", async () => {
      const attempt = turn(UsageLedger.initialState());
      ledger.recordStep(attempt, STEP, undefined);
      await ledger.recordInFlight(WORKSPACE_ID, attempt);
      await ledger.recordTerminalRefusal(WORKSPACE_ID, attempt, MODEL, {});

      await ledger.resetForRetry(WORKSPACE_ID, attempt);
      expect(await inFlightFiles()).toEqual([]);
      expect(totalTokens(await afterRestart())).toBe(0);
      expect(attempt).toMatchObject({
        cumulativeUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        cumulativeProviderMetadata: undefined,
        terminalRefusalUsage: undefined,
        lastStepUsage: undefined,
      });
    });

    test("a recorded tool-model usage is a copy the caller cannot change later", () => {
      const attempt = turn();
      const event = { toolName: "task", timestamp: 1, model: MODEL, usage: { ...STEP } };
      ledger.recordToolModelUsage(attempt, event);
      event.usage.inputTokens = 0;

      expect(attempt.toolModelUsages[0]?.usage).toEqual(STEP);
    });
  });
});
