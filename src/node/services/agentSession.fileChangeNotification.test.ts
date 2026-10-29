import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { createMuxMessage } from "@/common/types/message";
import type { MuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import type { AgentSession } from "./agentSession";
import type { StreamMessageOptions } from "./aiService";
import type { HistoryService } from "./historyService";
import {
  compactSessionForTest,
  createAgentSessionHarness,
  createStartedTurnHandle,
} from "./agentSession.testHarness";

/**
 * Log purity: externally-edited files must produce a durable <system-file-update>
 * row in chat.jsonl BEFORE the provider request is built. The request itself is a
 * pure function of history — there is no request-time injection path.
 */
describe("AgentSession file-change notification (turn start)", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  let tmpDir: string | undefined;
  const sessions: AgentSession[] = [];

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.dispose();
    }
    await historyCleanup?.();
    historyCleanup = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  /** Real history service + mocked AI service, seeded with one user row. */
  async function createSessionFixture() {
    const capturedRequests: MuxMessage[][] = [];
    const streamMessage = mock((opts: StreamMessageOptions) => {
      capturedRequests.push(opts.messages);
      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });
    const { historyService, session, config, cleanup } = await createAgentSessionHarness({
      workspaceId: "ws",
      aiServiceOverrides: { streamMessage },
    });
    historyCleanup = cleanup;
    sessions.push(session);
    await historyService.appendToHistory(
      "ws",
      createMuxMessage("user-1", "user", "hello", { timestamp: Date.now() })
    );

    return { historyService, session, config, capturedRequests, streamMessage };
  }

  /** Track a file via the session, then edit it externally (content + future mtime). */
  async function trackAndEditExternally(session: AgentSession, dir: string): Promise<string> {
    const trackedFile = join(dir, "plan.md");
    await writeFile(trackedFile, "original content");
    const originalMtime = (await stat(trackedFile)).mtimeMs;
    await session.recordFileState(trackedFile, {
      content: "original content",
      timestamp: originalMtime,
    });
    await writeFile(trackedFile, "modified content");
    const futureMtime = Date.now() + 1000;
    await utimes(trackedFile, futureMtime / 1000, futureMtime / 1000);
    return trackedFile;
  }

  test("changed files append a durable history row before the request is built", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mux-file-change-notification-"));

    const { historyService, session, capturedRequests, streamMessage } =
      await createSessionFixture();
    await trackAndEditExternally(session, tmpDir);

    const result = await session.resumeStream({
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    // The request contains the notification…
    const requestMessages = capturedRequests[0];
    const requestNotification = requestMessages.find((m) =>
      m.parts.some((p) => p.type === "text" && p.text.includes("<system-file-update>"))
    );
    expect(requestNotification).toBeDefined();
    const requestText = requestNotification?.parts.find((p) => p.type === "text")?.text ?? "";
    expect(requestText).toContain("plan.md was modified");
    expect(requestText).toContain("+modified content");

    // …and that exact row (same id, same content) is durable in chat.jsonl:
    // the request was built purely from history.
    const historyResult = await historyService.getHistoryFromLatestBoundary("ws");
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) return;
    const persistedNotification = historyResult.data.find((m) => m.id === requestNotification?.id);
    expect(persistedNotification).toBeDefined();
    expect(persistedNotification?.metadata?.synthetic).toBe(true);
    expect(persistedNotification?.parts).toEqual(requestNotification?.parts ?? []);

    // A second stream without further edits appends no duplicate notification
    // (tracker state was committed after the successful append).
    const secondResult = await session.resumeStream({
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    expect(secondResult.success).toBe(true);
    const secondHistory = await historyService.getHistoryFromLatestBoundary("ws");
    expect(secondHistory.success).toBe(true);
    if (!secondHistory.success) return;
    const notificationRows = secondHistory.data.filter((m) => m.id.startsWith("file-change-"));
    expect(notificationRows).toHaveLength(1);
  });

  /** Run `body` with XUM_ROOT in a temp dir that holds the plan "plan v1" of workspace "ws". */
  async function withPlanFile(body: (planFile: string) => Promise<void>): Promise<void> {
    tmpDir = await mkdtemp(join(tmpdir(), "mux-file-change-notification-"));
    const previousRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = tmpDir;
    try {
      // The harness metadata is local workspace "ws" in project "project".
      const planFile = join(tmpDir, "plans", "project", "ws.md");
      await mkdir(dirname(planFile), { recursive: true });
      await writeFile(planFile, "plan v1");
      await body(planFile);
    } finally {
      if (previousRoot === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = previousRoot;
    }
  }

  async function editPlanExternally(planFile: string): Promise<void> {
    await writeFile(planFile, "plan v2");
    const futureMtime = Date.now() + 1000;
    await utimes(planFile, futureMtime / 1000, futureMtime / 1000);
  }

  async function expectOnePlanNotification(historyService: HistoryService): Promise<void> {
    const historyResult = await historyService.getHistoryFromLatestBoundary("ws");
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) return;
    const notificationRows = historyResult.data.filter((m) => m.id.startsWith("file-change-"));
    expect(notificationRows).toHaveLength(1);
    const notificationText = notificationRows[0].parts.find((p) => p.type === "text")?.text ?? "";
    expect(notificationText).toContain("+plan v2");
  }

  /** Compact for real; the boundary header holds the plan unless exclusions.json drops it. */
  async function compact(session: AgentSession, historyService: HistoryService): Promise<void> {
    await compactSessionForTest(session, historyService, "ws");
    // A user row after the boundary lets every later resume start a turn.
    await historyService.appendToHistory(
      "ws",
      createMuxMessage("user-2", "user", "continue", { timestamp: Date.now() })
    );
  }

  async function writeExclusions(config: { sessionsDir: string }, excludedItems: string[]) {
    const sessionDir = join(config.sessionsDir, "ws");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "exclusions.json"), JSON.stringify({ excludedItems }));
  }

  async function resume(session: AgentSession): Promise<void> {
    const result = await session.resumeStream({
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    expect(result.success).toBe(true);
  }

  async function countNotifications(historyService: HistoryService): Promise<number> {
    const historyResult = await historyService.getHistoryFromLatestBoundary("ws");
    if (!historyResult.success) throw new Error(historyResult.error);
    return historyResult.data.filter((m) => m.id.startsWith("file-change-")).length;
  }

  test("a plan edit between compaction and the next turn appends a notification", async () => {
    await withPlanFile(async (planFile) => {
      const { historyService, session } = await createSessionFixture();
      // Nothing tracks the plan before this compaction, whose boundary header holds "plan v1".
      await compact(session, historyService);

      await editPlanExternally(planFile);
      await resume(session);
      await expectOnePlanNotification(historyService);
    });
  });

  test("an external plan edit after compaction appends a notification", async () => {
    await withPlanFile(async (planFile) => {
      const { historyService, session } = await createSessionFixture();
      await compact(session, historyService);
      // The first turn after compaction consumes the pending state and clears the tracker.
      await resume(session);

      await editPlanExternally(planFile);
      await resume(session);
      await expectOnePlanNotification(historyService);
    });
  });

  test("plan tracking follows the boundary header, not exclusions changed after it", async () => {
    await withPlanFile(async (planFile) => {
      const { historyService, session, config } = await createSessionFixture();
      await compact(session, historyService);
      await writeExclusions(config, ["plan"]);
      await resume(session);

      await editPlanExternally(planFile);
      await resume(session);
      await expectOnePlanNotification(historyService);
    });
  });

  test("a plan excluded at compaction stays untracked when the exclusion is removed", async () => {
    await withPlanFile(async (planFile) => {
      const { historyService, session, config } = await createSessionFixture();
      await writeExclusions(config, ["plan"]);
      await compact(session, historyService);
      await writeExclusions(config, []);
      await resume(session);

      await editPlanExternally(planFile);
      await resume(session);
      expect(await countNotifications(historyService)).toBe(0);
    });
  });

  test("a failed notification append is not dropped: retry re-detects and persists it", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mux-file-change-notification-"));

    const { historyService, session } = await createSessionFixture();
    await trackAndEditExternally(session, tmpDir);

    // First attempt: the notification append fails, so the turn errors out
    // before anything reaches chat.jsonl. Tracker state must NOT advance.
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementationOnce(() =>
      Promise.resolve(Err("simulated append failure"))
    );
    const failedResult = await session.resumeStream({
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    expect(failedResult.success).toBe(false);
    expect(appendSpy).toHaveBeenCalledTimes(1);

    // Retry: the same change is re-detected and durably appended (the real
    // appendToHistory runs after the one-shot failure).
    const retryResult = await session.resumeStream({
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    expect(retryResult.success).toBe(true);

    const historyResult = await historyService.getHistoryFromLatestBoundary("ws");
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) return;
    const notificationRows = historyResult.data.filter((m) => m.id.startsWith("file-change-"));
    expect(notificationRows).toHaveLength(1);
    const notificationText = notificationRows[0].parts.find((p) => p.type === "text")?.text ?? "";
    expect(notificationText).toContain("+modified content");
  });
});
