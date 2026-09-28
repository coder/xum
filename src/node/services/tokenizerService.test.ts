import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import { TokenizerService } from "./tokenizerService";
import type { HistoryService } from "./historyService";
import type { SessionUsageService } from "./sessionUsageService";
import { createTestHistoryService } from "./testHistoryService";
import * as tokenizerUtils from "@/node/utils/main/tokenizer";
import * as statsUtils from "@/common/utils/tokens/tokenStatsCalculator";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Err } from "@/common/types/result";
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
        expect(result).toBe(mockResult);
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
        expect(result).toBe(mockResult);
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
      const readSettled: Array<Promise<void>> = [];
      const realRead = historyService.getHistoryFromLatestBoundary.bind(historyService);
      const readSpy = spyOn(historyService, "getHistoryFromLatestBoundary").mockImplementation(
        (workspaceId, skip) => {
          const read = realRead(workspaceId, skip);
          readSettled.push(read.then(() => undefined));
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
        await readSettled[0];
        await seedHistory(createMuxMessage("msg2", "assistant", "World", { historySequence: 2 }));
        const requestB = service.calculateWorkspaceStats({ workspaceId: WS, model: "gpt-4" });
        await readSettled[1];
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
      const readSpy = spyOn(historyService, "getHistoryFromLatestBoundary").mockResolvedValueOnce(
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
