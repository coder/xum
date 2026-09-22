import { describe, test, expect, beforeEach, mock, afterEach, spyOn } from "bun:test";
import { IdleCompactionService } from "./idleCompactionService";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { ProjectConfig, ProjectsConfig } from "@/common/types/project";
import { createMuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
import { createTestHistoryService } from "./testHistoryService";
import { waitForCondition } from "./testDispatchHelpers";

/** Hidden plan-review record row (resolve/reopen appended while idle): user role, never a prompt. */
function planReviewRecordRow(id: string, timestamp: number) {
  const record = {
    v: 1 as const,
    kind: "resolve" as const,
    recordId: `rec_${id}`,
    threadId: "thr_1",
  };
  return createMuxMessage(id, "user", formatPlanReviewEnvelope(record), {
    timestamp,
    synthetic: true,
    muxMetadata: buildPlanReviewMetadata(record),
  });
}

describe("IdleCompactionService", () => {
  // Mock services
  let mockConfig: Config;
  let historyService: HistoryService;
  let mockExtensionMetadata: ExtensionMetadataService;
  let executeIdleCompactionMock: ReturnType<typeof mock<(workspaceId: string) => Promise<void>>>;
  let loadConfigMock: ReturnType<typeof mock<() => ProjectsConfig>>;
  let service: IdleCompactionService;
  let cleanup: () => Promise<void>;

  // Test data
  const testWorkspaceId = "test-workspace-id";
  const testProjectPath = "/test/project";
  const now = Date.now();
  const oneHourMs = 60 * 60 * 1000;

  beforeEach(async () => {
    // Create mock config
    loadConfigMock = mock(
      (): ProjectsConfig => ({
        projects: new Map<string, ProjectConfig>([
          [
            testProjectPath,
            {
              workspaces: [{ id: testWorkspaceId, path: "/test/path", name: "test" }],
              idleCompactionHours: 24,
            },
          ],
        ]),
      })
    );
    mockConfig = { loadConfigOrDefault: loadConfigMock } as unknown as Config;

    // Create real history service and seed default idle messages (25 hours ago)
    ({ historyService, cleanup } = await createTestHistoryService());
    const idleTimestamp = now - 25 * oneHourMs;
    await historyService.appendToHistory(
      testWorkspaceId,
      createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp })
    );
    await historyService.appendToHistory(
      testWorkspaceId,
      createMuxMessage("2", "assistant", "Hi there!", { timestamp: idleTimestamp })
    );

    // Create mock extension metadata service
    mockExtensionMetadata = {
      getSnapshot: mock(() =>
        Promise.resolve({
          recency: now - 25 * oneHourMs, // 25 hours ago
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
        })
      ),
    } as unknown as ExtensionMetadataService;

    executeIdleCompactionMock = mock(async () => {
      // noop mock
    });

    service = new IdleCompactionService(
      mockConfig,
      historyService,
      mockExtensionMetadata,
      executeIdleCompactionMock
    );
  });

  afterEach(async () => {
    service.stop();
    await cleanup();
  });

  describe("start/stop on the default runner", () => {
    // Default-runner smoke (cadence itself is covered on virtual time in
    // idleCompactionService.testClock.test.ts): with no runner injected the
    // checker sleeps on Effect's default clock, so nothing may run this early
    // in INITIAL_CHECK_DELAY_MS, and stop() must close the scope synchronously.
    test("start() arms the checker on the real clock without an early sweep", async () => {
      service.start();

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(loadConfigMock).not.toHaveBeenCalled();
      expect(executeIdleCompactionMock).not.toHaveBeenCalled();
      service.stop();
    });
  });

  describe("checkEligibility", () => {
    const threshold24h = 24 * oneHourMs;

    test.each([
      { archivedAt: "2026-01-02T00:00:00.000Z", unarchivedAt: undefined, archived: true },
      {
        archivedAt: "2026-01-02T00:00:00.000Z",
        unarchivedAt: "2026-01-01T00:00:00.000Z",
        archived: true,
      },
      {
        archivedAt: "2026-01-02T00:00:00.000Z",
        unarchivedAt: "2026-01-03T00:00:00.000Z",
        archived: false,
      },
    ])(
      "checks archive state before reading history: %j",
      async ({ archivedAt, unarchivedAt, archived }) => {
        const config = loadConfigMock();
        const workspace = config.projects.get(testProjectPath)?.workspaces[0];
        if (!workspace) throw new Error("Missing fixture workspace");
        workspace.archivedAt = archivedAt;
        workspace.unarchivedAt = unarchivedAt;
        loadConfigMock.mockReturnValue(config);
        const historySpy = spyOn(historyService, "getLastMessages");

        const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);

        expect(result.eligible).toBe(!archived);
        expect(historySpy).toHaveBeenCalledTimes(archived ? 0 : 1);
      }
    );

    test("returns eligible for idle workspace with messages", async () => {
      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(true);
    });

    test("returns ineligible when workspace is currently streaming", async () => {
      // Idle messages already seeded in beforeEach; workspace is streaming
      const idleTimestamp = now - 25 * oneHourMs;
      (mockExtensionMetadata.getSnapshot as ReturnType<typeof mock>).mockResolvedValueOnce({
        recency: idleTimestamp,
        streaming: true, // Currently streaming
        lastModel: null,
        lastThinkingLevel: null,
      });

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("currently_streaming");
    });

    test("returns ineligible when workspace has no messages", async () => {
      spyOn(historyService, "getLastMessages").mockResolvedValueOnce(Ok([]));

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("no_messages");
    });

    test("returns ineligible when last message is already compacted", async () => {
      const idleTimestamp = now - 25 * oneHourMs;
      spyOn(historyService, "getLastMessages").mockResolvedValueOnce(
        Ok([
          createMuxMessage("1", "assistant", "Summary", {
            compacted: true,
            timestamp: idleTimestamp,
          }),
        ])
      );

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("already_compacted");
    });

    test("returns ineligible when not idle long enough", async () => {
      // Messages with recent timestamps (only 1 hour ago)
      const recentTimestamp = now - oneHourMs;
      spyOn(historyService, "getLastMessages").mockResolvedValueOnce(
        Ok([
          createMuxMessage("1", "user", "Hello", { timestamp: recentTimestamp }),
          createMuxMessage("2", "assistant", "Hi!", { timestamp: recentTimestamp }),
        ])
      );

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("not_idle_enough");
    });

    test("returns ineligible when last message is from user (awaiting response)", async () => {
      const idleTimestamp = now - 25 * oneHourMs;
      spyOn(historyService, "getLastMessages").mockResolvedValueOnce(
        Ok([
          createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp }),
          createMuxMessage("2", "assistant", "Hi!", { timestamp: idleTimestamp }),
          createMuxMessage("3", "user", "Another question?", { timestamp: idleTimestamp }), // Last message is user
        ])
      );

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("awaiting_response");
    });

    test("ignores hidden plan-review record rows when judging an unanswered tail", async () => {
      // A resolve/reopen appended while idle sits after the assistant's answer; it is not a
      // prompt awaiting a response, so background compaction must stay eligible.
      const idleTimestamp = now - 25 * oneHourMs;
      spyOn(historyService, "getLastMessages").mockResolvedValueOnce(
        Ok([
          createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp }),
          createMuxMessage("2", "assistant", "Hi!", { timestamp: idleTimestamp }),
          planReviewRecordRow("3", idleTimestamp),
          planReviewRecordRow("4", idleTimestamp),
        ])
      );
      expect(await service.checkEligibility(testWorkspaceId, threshold24h, now)).toEqual({
        eligible: true,
      });

      // A real unanswered prompt followed by hidden rows keeps its protection.
      spyOn(historyService, "getLastMessages").mockResolvedValueOnce(
        Ok([
          createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp }),
          createMuxMessage("2", "assistant", "Hi!", { timestamp: idleTimestamp }),
          createMuxMessage("3", "user", "Another question?", { timestamp: idleTimestamp }),
          planReviewRecordRow("4", idleTimestamp),
        ])
      );
      expect(await service.checkEligibility(testWorkspaceId, threshold24h, now)).toEqual({
        eligible: false,
        reason: "awaiting_response",
      });
    });

    test("looks past a tail window made only of hidden record rows", async () => {
      // More hidden rows than the bounded tail read: the window alone cannot tell whether the
      // last real row is an answered turn or a pending prompt, so the check must consult the
      // history since the latest boundary rather than guess either way.
      const idleTimestamp = now - 25 * oneHourMs;
      const hiddenWindow = Array.from({ length: 50 }, (_, i) =>
        planReviewRecordRow(`h${i}`, idleTimestamp)
      );
      spyOn(historyService, "getLastMessages").mockResolvedValue(Ok(hiddenWindow));
      const fullSpy = spyOn(historyService, "getHistoryFromLatestBoundary").mockResolvedValueOnce(
        Ok([
          createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp }),
          createMuxMessage("2", "assistant", "Hi!", { timestamp: idleTimestamp }),
          ...hiddenWindow,
        ])
      );
      expect(await service.checkEligibility(testWorkspaceId, threshold24h, now)).toEqual({
        eligible: true,
      });
      fullSpy.mockResolvedValueOnce(
        Ok([
          createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp }),
          createMuxMessage("2", "assistant", "Hi!", { timestamp: idleTimestamp }),
          createMuxMessage("3", "user", "Pending", { timestamp: idleTimestamp }),
          ...hiddenWindow,
        ])
      );
      expect(await service.checkEligibility(testWorkspaceId, threshold24h, now)).toEqual({
        eligible: false,
        reason: "awaiting_response",
      });
      expect(fullSpy).toHaveBeenCalledTimes(2);
    });

    test("returns ineligible when messages have no timestamps", async () => {
      // Messages without timestamps - can't determine recency
      spyOn(historyService, "getLastMessages").mockResolvedValueOnce(
        Ok([createMuxMessage("1", "user", "Hello"), createMuxMessage("2", "assistant", "Hi!")])
      );

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("no_recency_data");
    });
  });

  describe("checkAllWorkspaces", () => {
    test("does not check archived workspaces during the periodic sweep", async () => {
      const config = loadConfigMock();
      const workspace = config.projects.get(testProjectPath)?.workspaces[0];
      if (!workspace) throw new Error("Missing fixture workspace");
      workspace.archivedAt = "2026-01-02T00:00:00.000Z";
      loadConfigMock.mockReturnValue(config);
      const eligibilitySpy = spyOn(service, "checkEligibility");
      const historySpy = spyOn(historyService, "getLastMessages");

      await service.checkAllWorkspaces();

      expect(eligibilitySpy).not.toHaveBeenCalled();
      expect(historySpy).not.toHaveBeenCalled();
      expect(executeIdleCompactionMock).not.toHaveBeenCalled();
    });

    test("skips projects without idleCompactionHours set", async () => {
      (mockConfig.loadConfigOrDefault as ReturnType<typeof mock>).mockReturnValueOnce({
        projects: new Map([
          [
            testProjectPath,
            {
              workspaces: [{ id: testWorkspaceId, path: "/test/path", name: "test" }],
              // idleCompactionHours not set
            },
          ],
        ]),
      } as ProjectsConfig);

      await service.checkAllWorkspaces();

      expect(executeIdleCompactionMock).not.toHaveBeenCalled();
    });

    test("executes idle compaction when eligible", async () => {
      await service.checkAllWorkspaces();

      await waitForCondition(() => executeIdleCompactionMock.mock.calls.length === 1);
      expect(executeIdleCompactionMock).toHaveBeenCalledWith(testWorkspaceId);
    });

    test("continues checking other workspaces if one fails", async () => {
      // Setup two workspaces in different projects
      const workspace2Id = "workspace-2";
      const idleTimestamp = now - 25 * oneHourMs;
      (mockConfig.loadConfigOrDefault as ReturnType<typeof mock>).mockReturnValueOnce({
        projects: new Map([
          [
            testProjectPath,
            {
              workspaces: [{ id: testWorkspaceId, path: "/test/path", name: "test" }],
              idleCompactionHours: 24,
            },
          ],
          [
            "/another/project",
            {
              workspaces: [{ id: workspace2Id, path: "/another/path", name: "test2" }],
              idleCompactionHours: 24,
            },
          ],
        ]),
      } as ProjectsConfig);

      // Make first workspace fail eligibility check (history throws)
      let callCount = 0;
      spyOn(historyService, "getLastMessages").mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error("History fetch failed");
        }
        return Promise.resolve(
          Ok([
            createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp }),
            createMuxMessage("2", "assistant", "Hi!", { timestamp: idleTimestamp }),
          ])
        );
      });

      await service.checkAllWorkspaces();

      // Should still have tried to process the second workspace.
      // Queue processing re-checks eligibility before execution, so callCount can exceed 2.
      expect(callCount).toBeGreaterThanOrEqual(2);
      await waitForCondition(() => executeIdleCompactionMock.mock.calls.length === 1);
      expect(executeIdleCompactionMock).toHaveBeenCalledWith(workspace2Id);
    });

    test("serializes idle compactions across workspaces", async () => {
      const workspace2Id = "workspace-2";
      const idleTimestamp = now - 25 * oneHourMs;

      (mockConfig.loadConfigOrDefault as ReturnType<typeof mock>).mockReturnValueOnce({
        projects: new Map([
          [
            testProjectPath,
            {
              workspaces: [
                { id: testWorkspaceId, path: "/test/path", name: "test" },
                { id: workspace2Id, path: "/another/path", name: "test2" },
              ],
              idleCompactionHours: 24,
            },
          ],
        ]),
      } as ProjectsConfig);

      spyOn(historyService, "getLastMessages").mockResolvedValue(
        Ok([
          createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp }),
          createMuxMessage("2", "assistant", "Hi!", { timestamp: idleTimestamp }),
        ])
      );

      let releaseFirstCompaction: (() => void) | undefined;
      const firstCompactionGate = new Promise<void>((resolve) => {
        releaseFirstCompaction = resolve;
      });

      const executionOrder: string[] = [];
      executeIdleCompactionMock.mockImplementation(async (workspaceId: string) => {
        executionOrder.push(`start:${workspaceId}`);
        if (workspaceId === testWorkspaceId) {
          await firstCompactionGate;
        }
        executionOrder.push(`end:${workspaceId}`);
      });

      await service.checkAllWorkspaces();

      await waitForCondition(() => executionOrder.includes(`start:${testWorkspaceId}`));
      expect(executionOrder).toEqual([`start:${testWorkspaceId}`]);

      releaseFirstCompaction?.();
      await waitForCondition(() => executionOrder.includes(`end:${workspace2Id}`));

      expect(executionOrder).toEqual([
        `start:${testWorkspaceId}`,
        `end:${testWorkspaceId}`,
        `start:${workspace2Id}`,
        `end:${workspace2Id}`,
      ]);
    });

    test("deduplicates queued idle compaction for same workspace", async () => {
      const sentinelWorkspaceId = "sentinel-workspace";
      const idleTimestamp = now - 25 * oneHourMs;
      loadConfigMock.mockImplementation(() => ({
        projects: new Map([
          [
            testProjectPath,
            {
              workspaces: [
                { id: testWorkspaceId, path: "/test/path", name: "test" },
                { id: sentinelWorkspaceId, path: "/sentinel/path", name: "sentinel" },
              ],
              idleCompactionHours: 24,
            },
          ],
        ]),
      }));

      let releaseCompaction: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseCompaction = resolve;
      });
      const executed: string[] = [];
      executeIdleCompactionMock.mockImplementation(async (workspaceId: string) => {
        executed.push(workspaceId);
        if (workspaceId === testWorkspaceId) {
          await gate;
        }
      });

      // The sentinel has no history yet, so only the first workspace is eligible.
      await service.checkAllWorkspaces();
      await waitForCondition(() => executed.length === 1);
      // Duplicate sweep while the first compaction is still running.
      await service.checkAllWorkspaces();

      // Queue the sentinel behind any duplicate. The queue is FIFO, so once the
      // sentinel has run, a duplicate entry would already have executed.
      await historyService.appendToHistory(
        sentinelWorkspaceId,
        createMuxMessage("s1", "user", "Hello", { timestamp: idleTimestamp })
      );
      await historyService.appendToHistory(
        sentinelWorkspaceId,
        createMuxMessage("s2", "assistant", "Hi!", { timestamp: idleTimestamp })
      );
      await service.checkAllWorkspaces();

      releaseCompaction?.();
      await waitForCondition(() => executed.includes(sentinelWorkspaceId));

      expect(executed).toEqual([testWorkspaceId, sentinelWorkspaceId]);
    });
  });

  describe("workspace ID resolution", () => {
    test("falls back to workspace name when id is not set", async () => {
      const workspaceName = "test-workspace-name";
      const idleTimestamp = now - 25 * oneHourMs;
      (mockConfig.loadConfigOrDefault as ReturnType<typeof mock>).mockReturnValueOnce({
        projects: new Map([
          [
            testProjectPath,
            {
              workspaces: [{ name: workspaceName, path: "/test/path" }], // No id field
              idleCompactionHours: 24,
            },
          ],
        ]),
      });

      // Spy on history to return idle messages for the name-based ID.
      // Queue processing re-checks eligibility before execution, so return the
      // same data for both checks.
      spyOn(historyService, "getLastMessages").mockResolvedValue(
        Ok([
          createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp }),
          createMuxMessage("2", "assistant", "Hi!", { timestamp: idleTimestamp }),
        ])
      );

      await service.checkAllWorkspaces();

      await waitForCondition(() => executeIdleCompactionMock.mock.calls.length === 1);
      expect(executeIdleCompactionMock).toHaveBeenCalledWith(workspaceName);
    });

    test("skips workspace when neither id nor name is set", async () => {
      (mockConfig.loadConfigOrDefault as ReturnType<typeof mock>).mockReturnValueOnce({
        projects: new Map([
          [
            testProjectPath,
            {
              workspaces: [{ path: "/test/path" }], // No id or name
              idleCompactionHours: 24,
            },
          ],
        ]),
      });

      await service.checkAllWorkspaces();

      expect(executeIdleCompactionMock).not.toHaveBeenCalled();
    });
  });

  describe("recordOutcome (failure suppression)", () => {
    const threshold24h = 24 * oneHourMs;

    test("stops the loop after two consecutive failures", async () => {
      service.recordOutcome(testWorkspaceId, { success: false, modelNotFound: false });

      // One failure is not enough to suppress.
      const afterOne = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(afterOne.eligible).toBe(true);

      service.recordOutcome(testWorkspaceId, { success: false, modelNotFound: false });

      const afterTwo = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(afterTwo.eligible).toBe(false);
      expect(afterTwo.reason).toBe("suppressed_after_failures");
    });

    test("stops the loop immediately on a model_not_found failure", async () => {
      service.recordOutcome(testWorkspaceId, { success: false, modelNotFound: true });

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("suppressed_after_failures");
    });

    test("a success between failures resets the consecutive failure streak", async () => {
      service.recordOutcome(testWorkspaceId, { success: false, modelNotFound: false });
      service.recordOutcome(testWorkspaceId, { success: true });
      service.recordOutcome(testWorkspaceId, { success: false, modelNotFound: false });

      // Only one failure since the last success, so the workspace is still eligible.
      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(true);
    });

    test("a later success lifts suppression (self-healing)", async () => {
      // Two failures suppress the workspace.
      service.recordOutcome(testWorkspaceId, { success: false, modelNotFound: false });
      service.recordOutcome(testWorkspaceId, { success: false, modelNotFound: false });
      expect((await service.checkEligibility(testWorkspaceId, threshold24h, now)).eligible).toBe(
        false
      );

      // An in-flight retry that actually persists a compaction clears suppression.
      service.recordOutcome(testWorkspaceId, { success: true });

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(true);
    });

    test("checkAllWorkspaces no longer queues a suppressed workspace", async () => {
      // A non-recoverable failure suppresses the workspace immediately.
      service.recordOutcome(testWorkspaceId, { success: false, modelNotFound: true });

      await service.checkAllWorkspaces();

      // Give the (fire-and-forget) queue a chance to run; it must not execute.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(executeIdleCompactionMock).not.toHaveBeenCalled();
    });
  });
});
