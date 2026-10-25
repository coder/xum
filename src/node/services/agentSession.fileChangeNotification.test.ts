import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { createMuxMessage } from "@/common/types/message";
import type { MuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import type { AgentSession } from "./agentSession";
import type { StreamMessageOptions } from "./aiService";
import { createAgentSessionHarness, createStartedTurnHandle } from "./agentSession.testHarness";

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
    const { historyService, session, cleanup } = await createAgentSessionHarness({
      workspaceId: "ws",
      aiServiceOverrides: { streamMessage },
    });
    historyCleanup = cleanup;
    sessions.push(session);
    await historyService.appendToHistory(
      "ws",
      createMuxMessage("user-1", "user", "hello", { timestamp: Date.now() })
    );

    return { historyService, session, capturedRequests, streamMessage };
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
