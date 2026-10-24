import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
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
});
