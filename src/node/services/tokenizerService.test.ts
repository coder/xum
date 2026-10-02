import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import { TokenizerService, type WorkspaceTokenStats } from "./tokenizerService";
import { HistoryService, mergeTranscriptPartial } from "./historyService";
import { SessionUsageService, type SessionUsageTokenStatsCacheV1 } from "./sessionUsageService";
import { createTestHistoryService } from "./testHistoryService";
import * as tokenizerUtils from "@/node/utils/main/tokenizer";
import * as statsUtils from "@/common/utils/tokens/tokenStatsCalculator";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import assert from "node:assert";
import { HISTORY_APPEND_PROVENANCE_FILE } from "./historyAppendProvenance";
import { CHAT_FILE_NAME } from "@/common/constants/paths";
import { sliceMessagesForProviderFromLatestContextBoundary } from "@/common/utils/messages/compactionBoundary";
import { isPlanReviewRecordMessage } from "@/common/utils/planReview/planReviewEnvelope";
import { getToolAvailabilityOptions } from "@/common/utils/tools/toolAvailability";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { AIService } from "./aiService";
import type { ProviderService } from "./providerService";
import { VERSION } from "@/version";
import * as historyScanner from "./historyScanner";
import type { PlanReviewRecord } from "@/common/utils/planReview/planReviewRecord";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
const GLOBAL_WORKSPACE_ID = "workspace-global";

describe("TokenizerService", () => {
  let sessionUsageService: SessionUsageService;
  let historyService: HistoryService;
  let sessionsDir: string;
  let cleanupHistory: () => Promise<void>;
  let service: TokenizerService;

  beforeEach(async () => {
    sessionUsageService = {
      setTokenStatsCache: () => Promise.resolve(),
      peekTokenStatsCache: () => Promise.resolve(undefined),
    } as unknown as SessionUsageService;
    const testHistory = await createTestHistoryService();
    historyService = testHistory.historyService;
    sessionsDir = testHistory.config.sessionsDir;
    cleanupHistory = testHistory.cleanup;
    service = new TokenizerService(
      sessionUsageService,
      { getWorkspaceMetadata: () => Promise.resolve({ success: false, error: "not found" }) },
      { getConfig: () => ({}) },
      historyService
    );
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  describe("calculateWorkspaceStats", () => {
    const WS = "ws";
    const mockResult = {
      consumers: [{ name: "User", tokens: 1, percentage: 100 }],
      totalTokens: 1,
      model: "gpt-4",
      tokenizerName: "cl100k",
      usageHistory: [],
    };
    // The RPC contract drops usageHistory (the cache never had it).
    const { usageHistory: _usageHistory, ...mockProjection } = mockResult;

    async function seedHistory(...messages: MuxMessage[]): Promise<void> {
      for (const message of messages) {
        const result = await historyService.appendToHistory(WS, message);
        expect(result.success).toBe(true);
      }
    }

    async function writePartial(message: MuxMessage): Promise<void> {
      const result = await historyService.writePartial(WS, message);
      expect(result.success).toBe(true);
    }

    /** Rows handed to the tokenizer, reduced to what the merge decides: which row, how much of it. */
    function tokenizedRows(statsSpy: { mock: { calls: unknown[][] } }): Array<{
      id: string;
      texts: string[];
    }> {
      const [messages] = statsSpy.mock.calls[0] as [MuxMessage[]];
      return messages.map((message) => ({
        id: message.id,
        texts: message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      }));
    }

    test("tokenizes the backend's own history without a caller-supplied message list", async () => {
      await seedHistory(
        createMuxMessage("msg1", "user", "Hello", { historySequence: 1 }),
        createMuxMessage("msg2", "assistant", "World", { historySequence: 2 })
      );
      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);
      try {
        const result = await service.calculateWorkspaceStats({ workspaceId: WS, model: "gpt-4" });
        expect(result).toEqual(mockProjection);
        expect(result).not.toHaveProperty("usageHistory");
        expect(tokenizedRows(statsSpy)).toEqual([
          { id: "msg1", texts: ["Hello"] },
          { id: "msg2", texts: ["World"] },
        ]);
        expect(statsSpy.mock.calls[0][1]).toBe("gpt-4");
      } finally {
        statsSpy.mockRestore();
      }
    });

    test("leaves plan-review records out of the counted context but not the cache identity", async () => {
      // A snapshot row carries the whole plan; it is persisted UI state, never sent to a model.
      const snapshot: PlanReviewRecord = {
        v: 1,
        kind: "snapshot",
        recordId: "rec_snap",
        snapshotId: "snap_1",
        planPath: "/plans/p.md",
        contentHash: "a".repeat(64),
        content: "# Plan\nstep one\n",
      };
      const feedback: PlanReviewRecord = {
        v: 1,
        kind: "feedback",
        recordId: "rec_fb",
        feedbackId: "fb_1",
        snapshotId: "snap_1",
        contentHash: "a".repeat(64),
        comments: [
          { threadId: "t1", anchor: { startLine: 2, endLine: 2 }, quote: "step one", body: "Why?" },
        ],
        replies: [],
      };
      await seedHistory(
        createMuxMessage("msg1", "user", "Plan it", { historySequence: 1 }),
        createMuxMessage("snap", "user", formatPlanReviewEnvelope(snapshot), {
          historySequence: 2,
          synthetic: true,
          muxMetadata: buildPlanReviewMetadata(snapshot),
        }),
        createMuxMessage("fb", "user", formatPlanReviewEnvelope(feedback), {
          historySequence: 3,
          muxMetadata: buildPlanReviewMetadata(feedback),
        })
      );
      const cached: unknown[] = [];
      sessionUsageService.setTokenStatsCache = (_workspaceId, cache) => {
        cached.push(cache);
        return Promise.resolve();
      };
      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);
      try {
        await service.calculateWorkspaceStats({ workspaceId: WS, model: "gpt-4" });
        // Authentic feedback is a real user message and still counts.
        expect(tokenizedRows(statsSpy).map((row) => row.id)).toEqual(["msg1", "fb"]);
        // Freshness is compared against the transcript, which still contains the record.
        expect(cached).toEqual([
          expect.objectContaining({ history: { messageCount: 3, maxHistorySequence: 3 } }),
        ]);
      } finally {
        statsSpy.mockRestore();
      }
    });

    test("substitutes the in-flight partial for its empty placeholder row", async () => {
      await seedHistory(
        createMuxMessage("msg1", "user", "Hello", { historySequence: 1 }),
        createMuxMessage("msg2", "assistant", "", { historySequence: 2 })
      );
      await writePartial(
        createMuxMessage("msg2", "assistant", "streamed so far", { historySequence: 2 })
      );
      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);
      try {
        await service.calculateWorkspaceStats({ workspaceId: WS, model: "gpt-4" });
        expect(tokenizedRows(statsSpy)).toEqual([
          { id: "msg1", texts: ["Hello"] },
          { id: "msg2", texts: ["streamed so far"] },
        ]);
      } finally {
        statsSpy.mockRestore();
      }
    });

    test("keeps a fuller committed history row over a stale partial for the same turn", async () => {
      // Unlocked reads: partial.json can be observed just before commitPartial while the
      // history read lands after the finalized row was appended.
      const committed = createMuxMessage("msg2", "assistant", "final text", { historySequence: 2 });
      committed.parts.push({ type: "text", text: "second part" });
      await seedHistory(
        createMuxMessage("msg1", "user", "Hello", { historySequence: 1 }),
        committed
      );
      await writePartial(createMuxMessage("msg2", "assistant", "final", { historySequence: 2 }));
      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);
      try {
        await service.calculateWorkspaceStats({ workspaceId: WS, model: "gpt-4" });
        expect(tokenizedRows(statsSpy)).toEqual([
          { id: "msg1", texts: ["Hello"] },
          { id: "msg2", texts: ["final text", "second part"] },
        ]);
      } finally {
        statsSpy.mockRestore();
      }
    });

    test("appends a partial that has no matching history row", async () => {
      await seedHistory(createMuxMessage("msg1", "user", "Hello", { historySequence: 1 }));
      await writePartial(createMuxMessage("msg2", "assistant", "streamed", { historySequence: 2 }));
      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);
      try {
        await service.calculateWorkspaceStats({ workspaceId: WS, model: "gpt-4" });
        expect(tokenizedRows(statsSpy)).toEqual([
          { id: "msg1", texts: ["Hello"] },
          { id: "msg2", texts: ["streamed"] },
        ]);
      } finally {
        statsSpy.mockRestore();
      }
    });

    test("rejects when partial.json is unreadable instead of undercounting the in-flight turn", async () => {
      await seedHistory(createMuxMessage("msg1", "user", "Hello", { historySequence: 1 }));
      // A directory at the partial path fails the real read with EISDIR: neither the
      // "missing" (ENOENT) nor the "malformed JSON" branch readPartial self-heals.
      await fs.mkdir(path.join(sessionsDir, WS, "partial.json"), { recursive: true });
      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);
      try {
        const error = await service
          .calculateWorkspaceStats({ workspaceId: WS, model: "gpt-4" })
          .then(
            () => null,
            (e: unknown) => e
          );
        expect(error).toBeInstanceOf(Error);
        expect((error as { code?: string }).code).toBe("EISDIR");
        expect(statsSpy).not.toHaveBeenCalled();
      } finally {
        statsSpy.mockRestore();
      }
    });

    test("treats a malformed partial.json as no in-flight turn under the strict read", async () => {
      await seedHistory(createMuxMessage("msg1", "user", "Hello", { historySequence: 1 }));
      const sessionDir = path.join(sessionsDir, WS);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(path.join(sessionDir, "partial.json"), "{ not json", "utf-8");
      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);
      try {
        const result = await service.calculateWorkspaceStats({ workspaceId: WS, model: "gpt-4" });
        expect(result).toEqual(mockProjection);
        expect(tokenizedRows(statsSpy)).toEqual([{ id: "msg1", texts: ["Hello"] }]);
      } finally {
        statsSpy.mockRestore();
      }
    });

    test("persists the cache of the most recently requested calculation, not the last to finish reading", async () => {
      await seedHistory(createMuxMessage("msg1", "user", "Hello", { historySequence: 1 }));
      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockImplementation((messages) =>
        Promise.resolve({
          ...mockResult,
          totalTokens: messages.length,
          consumers: [{ name: "User", tokens: messages.length, percentage: 100 }],
        })
      );
      const persistSpy = spyOn(sessionUsageService, "setTokenStatsCache").mockResolvedValue(
        undefined
      );
      // Real reads run immediately; only the hand-back of each result is held so the test
      // controls which request observes its transcript first and which finishes last.
      const releaseRead: Array<() => void> = [];
      // The history read starts only after the cache/receipt probes, so signal it explicitly.
      const readSettled = [0, 1].map(() => Promise.withResolvers<void>());
      let reads = 0;
      const realRead = historyService.getHistoryForTokenStats.bind(historyService);
      const readSpy = spyOn(historyService, "getHistoryForTokenStats").mockImplementation(
        (workspaceId) => {
          const read = realRead(workspaceId);
          const settled = readSettled[reads++];
          void read.then(() => settled.resolve());
          return read.then(
            (result) =>
              new Promise((resolve) => {
                releaseRead.push(() => resolve(result));
              })
          );
        }
      );
      try {
        const requestA = service.calculateWorkspaceStats({ workspaceId: WS, model: "gpt-4" });
        await readSettled[0].promise;
        await seedHistory(createMuxMessage("msg2", "assistant", "World", { historySequence: 2 }));
        const requestB = service.calculateWorkspaceStats({ workspaceId: WS, model: "gpt-4" });
        await readSettled[1].promise;
        expect(releaseRead).toHaveLength(2);

        // B (newer transcript) completes first; A (older transcript) completes afterwards.
        releaseRead[1]();
        await requestB;
        releaseRead[0]();
        await requestA;

        const persisted = persistSpy.mock.calls.map(([, cache]) => cache.history.messageCount);
        expect(persisted).toEqual([2]);
      } finally {
        statsSpy.mockRestore();
        persistSpy.mockRestore();
        readSpy.mockRestore();
      }
    });

    test("rejects when history cannot be read instead of tokenizing nothing", async () => {
      const readSpy = spyOn(historyService, "getHistoryForTokenStats").mockResolvedValueOnce(
        Err("disk exploded")
      );
      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);
      try {
        const error = await service
          .calculateWorkspaceStats({ workspaceId: WS, model: "gpt-4" })
          .then(
            () => null,
            (e: unknown) => e
          );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("disk exploded");
        expect(statsSpy).not.toHaveBeenCalled();
      } finally {
        statsSpy.mockRestore();
        readSpy.mockRestore();
      }
    });
  });

  describe("countTokens", () => {
    test("delegates to underlying function", async () => {
      const spy = spyOn(tokenizerUtils, "countTokens").mockResolvedValue(42);

      const result = await service.countTokens("gpt-4", "hello world");
      expect(result).toBe(42);
      expect(spy).toHaveBeenCalledWith("gpt-4", "hello world");
      spy.mockRestore();
    });

    test("throws on empty model", () => {
      expect(service.countTokens("", "text")).rejects.toThrow("requires model name");
    });

    test("throws on invalid text", () => {
      // @ts-expect-error testing runtime validation
      expect(service.countTokens("gpt-4", null)).rejects.toThrow("requires text");
    });
  });

  describe("countTokensBatch", () => {
    test("delegates to underlying function", async () => {
      const spy = spyOn(tokenizerUtils, "countTokensBatch").mockResolvedValue([10, 20]);

      const result = await service.countTokensBatch("gpt-4", ["a", "b"]);
      expect(result).toEqual([10, 20]);
      expect(spy).toHaveBeenCalledWith("gpt-4", ["a", "b"]);
      spy.mockRestore();
    });

    test("throws on non-array input", () => {
      // @ts-expect-error testing runtime validation
      expect(service.countTokensBatch("gpt-4", "not-array")).rejects.toThrow("requires an array");
    });
  });

  describe("calculateStats", () => {
    test("delegates to underlying function and persists token stats cache", async () => {
      const messages = [
        createMuxMessage("msg1", "user", "Hello", { historySequence: 1 }),
        createMuxMessage("msg2", "assistant", "World", { historySequence: 2 }),
      ];

      const mockResult = {
        consumers: [{ name: "User", tokens: 100, percentage: 100 }],
        totalTokens: 100,
        model: "gpt-4",
        tokenizerName: "cl100k",
        usageHistory: [],
      };
      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);
      const persistSpy = spyOn(sessionUsageService, "setTokenStatsCache").mockResolvedValue(
        undefined
      );
      const nowSpy = spyOn(Date, "now").mockReturnValue(1234);

      // try/finally: a leaked Date.now spy freezes time process-wide and breaks
      // downstream suites (e.g. WorkflowService crash-recovery retries).
      try {
        const result = await service.calculateStats("test-workspace", messages, "gpt-4");
        expect(result).toBe(mockResult);
        expect(statsSpy).toHaveBeenCalledWith(messages, "gpt-4", null, {
          enableAgentReport: false,
          enableReviewPane: true,
        });
        expect(persistSpy).toHaveBeenCalledWith(
          "test-workspace",
          expect.objectContaining({
            version: 1,
            computedAt: 1234,
            model: "gpt-4",
            tokenizerName: "cl100k",
            totalTokens: 100,
            consumers: mockResult.consumers,
            history: { messageCount: 2, maxHistorySequence: 2 },
          })
        );
      } finally {
        nowSpy.mockRestore();
        statsSpy.mockRestore();
        persistSpy.mockRestore();
      }
    });

    test("excludes a leading reset boundary from token stats", async () => {
      const resetBoundary = createMuxMessage("reset", "assistant", "", {
        historySequence: 2,
        contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
      });
      const messages = [
        resetBoundary,
        createMuxMessage("msg1", "user", "Hello", { historySequence: 3 }),
      ];
      const mockResult = {
        consumers: [{ name: "User", tokens: 1, percentage: 100 }],
        totalTokens: 1,
        model: "gpt-4",
        tokenizerName: "cl100k",
        usageHistory: [],
      };
      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);
      const persistSpy = spyOn(sessionUsageService, "setTokenStatsCache").mockResolvedValue(
        undefined
      );

      await service.calculateStats("test-workspace", messages, "gpt-4");

      expect(statsSpy).toHaveBeenCalledWith([messages[1]], "gpt-4", null, {
        enableAgentReport: false,
        enableReviewPane: true,
      });
      expect(persistSpy).toHaveBeenCalledWith(
        "test-workspace",
        expect.objectContaining({ history: { messageCount: 1, maxHistorySequence: 3 } })
      );

      statsSpy.mockRestore();
      persistSpy.mockRestore();
    });

    test("passes tool availability options to calculateTokenStats", async () => {
      const messages = [createMuxMessage("msg1", "user", "Hello")];
      const mockResult = {
        consumers: [{ name: "User", tokens: 1, percentage: 100 }],
        totalTokens: 1,
        model: "gpt-4",
        tokenizerName: "cl100k",
        usageHistory: [],
      };

      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);
      const persistSpy = spyOn(sessionUsageService, "setTokenStatsCache").mockResolvedValue(
        undefined
      );

      await service.calculateStats(GLOBAL_WORKSPACE_ID, messages, "gpt-4");
      await service.calculateStats("another-workspace", messages, "gpt-4");

      expect(statsSpy).toHaveBeenNthCalledWith(1, messages, "gpt-4", null, {
        enableAgentReport: false,
        enableReviewPane: true,
      });
      expect(statsSpy).toHaveBeenNthCalledWith(2, messages, "gpt-4", null, {
        enableAgentReport: false,
        enableReviewPane: true,
      });

      statsSpy.mockRestore();
      persistSpy.mockRestore();
    });

    test("passes enableAgentReport true when parentWorkspaceId is provided", async () => {
      const messages = [createMuxMessage("msg1", "user", "Hello")];
      const mockResult = {
        consumers: [{ name: "User", tokens: 1, percentage: 100 }],
        totalTokens: 1,
        model: "gpt-4",
        tokenizerName: "cl100k",
        usageHistory: [],
      };

      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);

      await service.calculateStats("child-workspace", messages, "gpt-4", null, "parent-workspace");

      expect(statsSpy).toHaveBeenCalledWith(messages, "gpt-4", null, {
        enableAgentReport: true,
        enableReviewPane: false,
      });

      statsSpy.mockRestore();
    });

    test("skips persisting stale token stats cache when calculations overlap", async () => {
      const messagesV1 = [
        createMuxMessage("msg1", "user", "Hello", { historySequence: 1 }),
        createMuxMessage("msg2", "assistant", "World", { historySequence: 2 }),
      ];

      const messagesV2 = [
        ...messagesV1,
        createMuxMessage("msg3", "assistant", "!!!", { historySequence: 3 }),
      ];

      const deferred = <T>() => {
        let resolve!: (value: T) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      };

      const statsV1 = {
        consumers: [{ name: "User", tokens: 1, percentage: 100 }],
        totalTokens: 1,
        model: "gpt-4",
        tokenizerName: "cl100k",
        usageHistory: [],
      };
      const statsV2 = {
        consumers: [{ name: "User", tokens: 2, percentage: 100 }],
        totalTokens: 2,
        model: "gpt-4",
        tokenizerName: "cl100k",
        usageHistory: [],
      };

      const d1 = deferred<typeof statsV1>();
      const d2 = deferred<typeof statsV2>();

      const statsSpy = spyOn(statsUtils, "calculateTokenStats")
        .mockImplementationOnce(() => d1.promise)
        .mockImplementationOnce(() => d2.promise);
      const persistSpy = spyOn(sessionUsageService, "setTokenStatsCache").mockResolvedValue(
        undefined
      );

      const p1 = service.calculateStats("test-workspace", messagesV1, "gpt-4");
      const p2 = service.calculateStats("test-workspace", messagesV2, "gpt-4");

      // Resolve second (newer) request first
      d2.resolve(statsV2);
      expect(await p2).toBe(statsV2);

      // Resolve first (older) request last
      d1.resolve(statsV1);
      expect(await p1).toBe(statsV1);

      // Only the newer request should persist the cache.
      expect(persistSpy).toHaveBeenCalledTimes(1);
      expect(persistSpy).toHaveBeenCalledWith(
        "test-workspace",
        expect.objectContaining({
          history: { messageCount: messagesV2.length, maxHistorySequence: 3 },
        })
      );

      statsSpy.mockRestore();
      persistSpy.mockRestore();
    });

    test("throws on invalid messages", () => {
      // @ts-expect-error testing runtime validation
      expect(service.calculateStats("test-workspace", null, "gpt-4")).rejects.toThrow(
        "requires an array"
      );
    });

    test("throws on empty workspaceId", () => {
      expect(service.calculateStats("", [], "gpt-4")).rejects.toThrow("requires workspaceId");
    });
  });
});

describe("calculateWorkspaceStats persisted cache (real services)", () => {
  const WS = "cache-ws";
  const MODEL = "anthropic:claude-sonnet-5-5";
  const OTHER_MODEL = "openai:gpt-6-luna";
  const OTHER_CONFIG: ProvidersConfigMap = {
    anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
  };
  let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;
  let history: HistoryService;
  let usage: SessionUsageService;
  let tokenizer: TokenizerService;
  let parentWorkspaceId: string | undefined;
  let providersConfig: ProvidersConfigMap;
  let providers: Pick<ProviderService, "getConfig">;
  let readSpy: ReturnType<typeof spyOn<HistoryService, "getHistoryForTokenStats">>;
  let nextId = 0;

  async function setup(): Promise<void> {
    fixture = await createTestHistoryService();
    history = fixture.historyService;
    const projectPath = path.join(fixture.tempDir, "project");
    await fixture.config.addWorkspace(projectPath, {
      id: WS,
      name: "cache-branch",
      projectName: "project",
      projectPath,
      runtimeConfig: { type: "local" },
    });
    usage = new SessionUsageService(fixture.config, history);
    parentWorkspaceId = undefined;
    providersConfig = {};
    const metadata: Pick<AIService, "getWorkspaceMetadata"> = {
      getWorkspaceMetadata: () =>
        Promise.resolve(
          parentWorkspaceId === undefined
            ? Err("not found")
            : Ok({ parentWorkspaceId } as unknown as WorkspaceMetadata)
        ),
    };
    providers = { getConfig: () => providersConfig };
    tokenizer = new TokenizerService(usage, metadata, providers, history);
    // No mockImplementation: the real read runs, calls are only counted.
    readSpy = spyOn(history, "getHistoryForTokenStats");
  }

  beforeEach(setup);

  afterEach(async () => {
    readSpy.mockRestore();
    await fixture.cleanup();
  });

  const sessionFile = (name: string) => path.join(fixture.config.sessionsDir, WS, name);
  type CacheCounters = Pick<SessionUsageTokenStatsCacheV1, "consumers" | "totalTokens">;
  /** Corrupts the persisted counters in place, keeping its source (receipt + inputs). */
  async function editCacheCounters(edit: (cache: CacheCounters) => void): Promise<void> {
    const file = sessionFile("session-usage.json");
    const usageFile = JSON.parse(await fs.readFile(file, "utf-8")) as {
      tokenStatsCache: SessionUsageTokenStatsCacheV1;
    };
    assert(usageFile.tokenStatsCache.source && usageFile.tokenStatsCache.consumers.length > 0);
    edit(usageFile.tokenStatsCache);
    await fs.writeFile(file, JSON.stringify(usageFile));
  }
  const text = (label: string) => `${label} lorem ipsum ${nextId++} dolor sit amet`;
  /** Reads through the prototype so the spy only counts TokenizerService's reads. */
  async function rows(): Promise<MuxMessage[]> {
    const result = await HistoryService.prototype.getHistoryFromLatestBoundary.call(history, WS, 0);
    assert(result.success);
    return result.data;
  }

  /** Today's full recount with the cache bypassed, projected to the RPC contract. */
  async function reference(model: string): Promise<WorkspaceTokenStats> {
    const merged = mergeTranscriptPartial(await rows(), await history.readPartial(WS));
    const counted = sliceMessagesForProviderFromLatestContextBoundary(merged).filter(
      (message) => !isPlanReviewRecordMessage(message)
    );
    const { usageHistory: _usageHistory, ...stats } = await statsUtils.calculateTokenStats(
      counted,
      model,
      providersConfig,
      getToolAvailabilityOptions({ workspaceId: WS, parentWorkspaceId: parentWorkspaceId ?? null })
    );
    return stats;
  }

  /** One RPC call: its result, whether it read history, and that it equals the reference. */
  async function calculate(model = MODEL): Promise<{ result: WorkspaceTokenStats; read: boolean }> {
    const readsBefore = readSpy.mock.calls.length;
    const result = await tokenizer.calculateWorkspaceStats({ workspaceId: WS, model });
    const read = readSpy.mock.calls.length > readsBefore;
    expect(result).toEqual(await reference(model));
    expect(result).not.toHaveProperty("usageHistory");
    return { result, read };
  }

  async function append(role: "user" | "assistant", extra?: Partial<MuxMessage["metadata"]>) {
    const result = await history.appendToHistory(
      WS,
      createMuxMessage(`m${nextId}`, role, text(role), extra)
    );
    expect(result.success).toBe(true);
  }

  async function seed(): Promise<void> {
    for (let i = 0; i < 4; i++) await append(i % 2 === 0 ? "user" : "assistant");
  }

  async function writePartial(): Promise<void> {
    const last = (await rows()).at(-1)?.metadata?.historySequence ?? -1;
    const partial = createMuxMessage(`p${nextId}`, "assistant", text("streaming"), {
      historySequence: last + 1,
    });
    expect((await history.writePartial(WS, partial)).success).toBe(true);
  }

  /** Strict for the matrix; the random walk tolerates edits the service legitimately refuses. */
  async function update(
    pick: (all: MuxMessage[]) => MuxMessage | undefined,
    strict = true
  ): Promise<void> {
    const target = pick(await rows());
    if (!strict && !target) return;
    assert(target);
    const edited = { ...target, parts: [{ type: "text" as const, text: text("edited") }] };
    const result = await history.updateHistory(WS, edited);
    if (strict) expect(result.success).toBe(true);
  }

  /** Same-length in-place rewrite; retried until the kernel's coarse file clock ticks. */
  async function externalSameLengthEdit(strict = true): Promise<void> {
    const chatPath = sessionFile(CHAT_FILE_NAME);
    const before = await fs.stat(chatPath, { bigint: true }).catch(() => null);
    const original = before ? await fs.readFile(chatPath, "utf-8") : "";
    const at = original.indexOf("lorem");
    if (!strict && (!before || at < 0)) return;
    assert(before && at >= 0);
    const edited = `${original.slice(0, at)}L${original.slice(at + 1)}`;
    assert(edited.length === original.length && edited !== original);
    for (let attempt = 0; ; attempt++) {
      await fs.writeFile(chatPath, edited);
      const after = await fs.stat(chatPath, { bigint: true });
      expect(after.size).toBe(before.size);
      expect(after.ino).toBe(before.ino);
      if (after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) return;
      assert(attempt < 200, "file clock never advanced");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  test("serves an unchanged history from the cache without reading it", async () => {
    await seed();
    await writePartial();
    const first = await calculate();
    expect(first.read).toBe(true);
    expect((await usage.peekTokenStatsCache(WS))?.source).toBeDefined();
    const second = await calculate();
    expect(second.read).toBe(false);
    expect(second.result).toEqual(first.result);
  });

  /**
   * Overlapping requests: a model starts a request, a function first waits until every started
   * request has probed (so has decided whether to join) and then runs. History reads are held
   * until the end, so every pass is still in flight when the next request decides.
   */
  async function overlapping(
    steps: Array<string | (() => Promise<void>)>,
    firstRead?: HistoryService["getHistoryForTokenStats"]
  ): Promise<Array<PromiseSettledResult<WorkspaceTokenStats>>> {
    const realRead = HistoryService.prototype.getHistoryForTokenStats.bind(history);
    const release = Promise.withResolvers<void>();
    let reads = 0;
    readSpy.mockImplementation(async (workspaceId) => {
      await release.promise;
      return (reads++ === 0 && firstRead ? firstRead : realRead)(workspaceId);
    });
    // getConfig runs once per request, right before its synchronous join decision.
    let probed = 0;
    let wake = () => undefined as void;
    spyOn(providers, "getConfig").mockImplementation(() => {
      probed++;
      wake();
      return providersConfig;
    });
    const started: Array<Promise<WorkspaceTokenStats>> = [];
    const barrier = async () => {
      while (probed < started.length) await new Promise<void>((resolve) => (wake = resolve));
    };
    for (const step of steps) {
      if (typeof step === "string") {
        started.push(tokenizer.calculateWorkspaceStats({ workspaceId: WS, model: step }));
      } else {
        await barrier();
        await step();
      }
    }
    await barrier();
    release.resolve();
    return Promise.allSettled(started);
  }
  const fulfilled = (results: Array<PromiseSettledResult<WorkspaceTokenStats>>) =>
    results.map((result) => {
      assert(result.status === "fulfilled", String(result.status === "rejected" && result.reason));
      return result.value;
    });
  const sync = () => Promise.resolve();

  test("identical concurrent requests share one pass, its result and its cache write", async () => {
    await seed();
    await writePartial();
    const statsSpy = spyOn(statsUtils, "calculateTokenStats");
    try {
      const [first, second] = fulfilled(await overlapping([MODEL, sync, MODEL]));
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(statsSpy).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
      expect(first).toEqual(await reference(MODEL));
    } finally {
      statsSpy.mockRestore();
    }
    // The joiner held the newest claim; the shared pass persisted under it.
    expect((await usage.peekTokenStatsCache(WS))?.source?.historyReceipt).toBe(
      (await history.captureTokenStatsReceiptKey(WS))!
    );
    expect((await calculate()).read).toBe(false);
  });

  const noJoinCases: Array<{ name: string; steps: Array<string | (() => Promise<void>)> }> = [
    { name: "a different model", steps: [MODEL, OTHER_MODEL] },
    { name: "a different partial", steps: [MODEL, writePartial, MODEL] },
    { name: "a different history receipt", steps: [MODEL, () => append("user"), MODEL] },
  ];
  for (const testCase of noJoinCases) {
    test(`a request with ${testCase.name} runs its own pass`, async () => {
      await seed();
      const results = fulfilled(await overlapping(testCase.steps));
      expect(readSpy).toHaveBeenCalledTimes(2);
      expect(results.at(-1)).toEqual(await reference(String(testCase.steps.at(-1))));
      // The newest request owned the cache write.
      expect((await calculate(String(testCase.steps.at(-1)))).read).toBe(false);
    });
  }

  test("a joiner never takes the cache write from a newer request", async () => {
    await seed();
    // The joiner claims, then a newer request with other inputs claims before the join.
    const [first, joined, newer] = fulfilled(await overlapping([MODEL, sync, MODEL, OTHER_MODEL]));
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(joined).toBe(first);
    expect(newer).toEqual(await reference(OTHER_MODEL));
    expect((await usage.peekTokenStatsCache(WS))?.model).toBe(OTHER_MODEL);
  });

  test("a rejected shared pass rejects its joiners and a later request retries", async () => {
    await seed();
    const results = await overlapping([MODEL, sync, MODEL], () =>
      Promise.resolve(Err("disk exploded"))
    );
    expect(readSpy).toHaveBeenCalledTimes(1);
    for (const result of results) {
      assert(result.status === "rejected");
      expect(String(result.reason)).toContain("disk exploded");
    }
    expect(await usage.peekTokenStatsCache(WS)).toBeUndefined();
    expect((await calculate()).read).toBe(true);
    expect((await calculate()).read).toBe(false);
  });

  interface InvalidationCase {
    name: string;
    withPartial?: boolean;
    model?: string;
    change: () => Promise<void>;
    restore?: () => void;
  }
  const cases: InvalidationCase[] = [
    { name: "append", change: () => append("user") },
    { name: "updateHistory on the last row", change: () => update((all) => all.at(-1)) },
    { name: "updateHistory on a middle row", change: () => update((all) => all[1]) },
    {
      name: "deleteMessage",
      change: async () => {
        const target = (await rows())[1];
        expect((await history.deleteMessage(WS, target.id)).success).toBe(true);
      },
    },
    {
      name: "truncateAfterMessage",
      change: async () => {
        const target = (await rows())[1];
        expect((await history.truncateAfterMessage(WS, target.id)).success).toBe(true);
      },
    },
    {
      name: "a compaction boundary",
      change: () =>
        append("assistant", { compacted: "user", compactionBoundary: true, compactionEpoch: 1 }),
    },
    { name: "writePartial", change: writePartial },
    {
      name: "deletePartial",
      withPartial: true,
      change: async () => {
        expect((await history.deletePartial(WS)).success).toBe(true);
      },
    },
    {
      name: "commitPartial",
      withPartial: true,
      change: async () => {
        expect((await history.commitPartial(WS)).success).toBe(true);
      },
    },
    { name: "a model change", model: OTHER_MODEL, change: () => Promise.resolve() },
    {
      name: "a providers-config change",
      change: () => {
        providersConfig = OTHER_CONFIG;
        return Promise.resolve();
      },
    },
    {
      name: "a parent change",
      change: () => {
        parentWorkspaceId = "parent-ws";
        return Promise.resolve();
      },
    },
    (() => {
      const original = VERSION.git_describe;
      return {
        name: "an app version change",
        change: () => {
          VERSION.git_describe = `${original}-next`;
          return Promise.resolve();
        },
        restore: () => {
          VERSION.git_describe = original;
        },
      };
    })(),
    (() => {
      // Git-less builds keep git_describe "unknown" and set only the commit.
      const original = VERSION.git_commit;
      return {
        name: "a commit-only version change",
        change: () => {
          VERSION.git_commit = `${original}-next`;
          return Promise.resolve();
        },
        restore: () => {
          VERSION.git_commit = original;
        },
      };
    })(),
    (() => {
      const original = process.env.XUM_FORCE_REAL_TOKENIZER;
      return {
        name: "an approx-tokenizer flag flip",
        change: () => {
          process.env.XUM_FORCE_REAL_TOKENIZER = "1";
          return Promise.resolve();
        },
        restore: () => {
          if (original === undefined) delete process.env.XUM_FORCE_REAL_TOKENIZER;
          else process.env.XUM_FORCE_REAL_TOKENIZER = original;
        },
      };
    })(),
    { name: "an external same-length chat.jsonl write", change: () => externalSameLengthEdit() },
    { name: "a deleted receipt", change: () => fs.rm(sessionFile(HISTORY_APPEND_PROVENANCE_FILE)) },
    {
      name: "a corrupted receipt",
      change: () => fs.writeFile(sessionFile(HISTORY_APPEND_PROVENANCE_FILE), "{ corrupt"),
    },
    // The receipt still matches, but the counters break the write-path invariants.
    ...[
      {
        name: "a negative consumer count",
        edit: (c: CacheCounters) => (c.consumers[0].tokens = -1),
      },
      { name: "a totalTokens mismatch", edit: (c: CacheCounters) => (c.totalTokens += 1) },
    ].map(({ name, edit }) => ({ name, change: () => editCacheCounters(edit) })),
  ];
  for (const testCase of cases) {
    test(`recounts after ${testCase.name}`, async () => {
      await seed();
      if (testCase.withPartial) await writePartial();
      expect((await calculate()).read).toBe(true);
      // Primed: the unchanged state is a hit, so the recount below is the change's doing.
      expect((await calculate()).read).toBe(false);
      await testCase.change();
      try {
        expect((await calculate(testCase.model)).read).toBe(true);
      } finally {
        testCase.restore?.();
      }
    });
  }

  test("certifies a count only with the receipt of the rows it counted", async () => {
    await seed();
    const realRead = HistoryService.prototype.getHistoryForTokenStats.bind(history);
    readSpy.mockImplementationOnce(async (workspaceId) => {
      // A cooperating writer lands between the hit probe's receipt capture and the read.
      await append("user");
      return realRead(workspaceId);
    });
    expect((await calculate()).read).toBe(true);
    // The read saw the append, so its source is the post-append receipt, not the probe's.
    expect((await usage.peekTokenStatsCache(WS))?.source?.historyReceipt).toBe(
      (await history.captureTokenStatsReceiptKey(WS))!
    );
    expect((await calculate()).read).toBe(false);
  });

  test("an append parked inside the scan is recounted, never certified stale", async () => {
    await seed();
    const realScan = historyScanner.readProviderHistoryFromSnapshot;
    const scanSpy = spyOn(historyScanner, "readProviderHistoryFromSnapshot");
    try {
      scanSpy.mockImplementationOnce(async (snapshot) => {
        const rows = await realScan(snapshot);
        await append("user");
        return rows;
      });
      // The stale first scan is retried once; the result is the post-append state.
      expect((await calculate()).read).toBe(true);
      expect(scanSpy).toHaveBeenCalledTimes(2);
      expect((await usage.peekTokenStatsCache(WS))?.source?.historyReceipt).toBe(
        (await history.captureTokenStatsReceiptKey(WS))!
      );
      expect((await calculate()).read).toBe(false);

      // Racing both attempts rejects without persisting anything new.
      await append("user");
      const before = await usage.peekTokenStatsCache(WS);
      scanSpy.mockImplementation(async (snapshot) => {
        const rows = await realScan(snapshot);
        await append("user");
        return rows;
      });
      const calls = scanSpy.mock.calls.length;
      const error = await tokenizer.calculateWorkspaceStats({ workspaceId: WS, model: MODEL }).then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(Error);
      expect(scanSpy.mock.calls.length - calls).toBe(2);
      expect(await usage.peekTokenStatsCache(WS)).toEqual(before);
    } finally {
      scanSpy.mockRestore();
    }
    expect((await calculate()).read).toBe(true);
  });

  test("randomized differential: every result equals a full recount", async () => {
    let hits = 0;
    let model = MODEL;
    const ops: Array<(random: () => number) => Promise<void>> = [
      () => append("user"),
      () => append("assistant"),
      () => update((all) => all.at(-1), false),
      (random) => update((all) => all[Math.floor(random() * all.length)], false),
      async (random) => {
        const all = await rows();
        if (all.length > 1)
          await history.deleteMessage(WS, all[Math.floor(random() * all.length)].id);
      },
      async (random) => {
        const all = await rows();
        if (all.length > 1)
          await history.truncateAfterMessage(WS, all[Math.floor(random() * all.length)].id);
      },
      () =>
        append("assistant", {
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: nextId,
        }),
      writePartial,
      async () => void (await history.deletePartial(WS)),
      async () => void (await history.commitPartial(WS)),
      () => {
        model = model === MODEL ? OTHER_MODEL : MODEL;
        return Promise.resolve();
      },
      () => {
        providersConfig = providersConfig === OTHER_CONFIG ? {} : OTHER_CONFIG;
        return Promise.resolve();
      },
      () => {
        parentWorkspaceId = parentWorkspaceId === undefined ? "parent-ws" : undefined;
        return Promise.resolve();
      },
      () => externalSameLengthEdit(false),
      () => fs.rm(sessionFile(HISTORY_APPEND_PROVENANCE_FILE), { force: true }),
      () => fs.writeFile(sessionFile(HISTORY_APPEND_PROVENANCE_FILE), "{ corrupt"),
    ];
    for (let seed = 1; seed <= 30; seed++) {
      readSpy.mockRestore();
      await fixture.cleanup();
      await setup();
      model = MODEL;
      await append("user");
      const random = mulberry32(seed);
      for (let step = 0; step < 25; step++) {
        if (random() < 0.4) {
          if (!(await calculate(model)).read) hits++;
        } else {
          await ops[Math.floor(random() * ops.length)](random);
        }
      }
      if (!(await calculate(model)).read) hits++;
    }
    // Not vacuous: unchanged stretches were actually served from the cache.
    expect(hits).toBeGreaterThan(0);
  }, 300_000);
});

/** Small deterministic PRNG so a failing seed replays exactly. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
