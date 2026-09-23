import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { SESSION_HISTORY_MAX_LINE_BYTES } from "@/common/constants/contextBudget";
import { CHAT_FILE_NAME } from "@/common/constants/paths";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
import type { PlanReviewRecord } from "@/common/utils/planReview/planReviewRecord";
import {
  getPlanReviewState,
  hashPlanSnapshotContent,
  setPlanReviewThreadResolved,
} from "./planReviewService";
import { createTestHistoryService } from "./testHistoryService";

/**
 * Resolve/reopen rows are built from a threadId the caller looked up in the projection. The
 * projection accepts any non-empty threadId a persisted feedback row carries (schema:
 * `z.string().min(1)`), so a hand-edited feedback row can introduce a thread whose id is far
 * longer than the backend-generated `thr_<uuid>`. The resolve row repeats that id twice (envelope
 * text + muxMetadata mirror), so a feedback row that is itself readable can still produce a
 * resolve row above SESSION_HISTORY_MAX_LINE_BYTES — which the history scanner skips on replay.
 */
describe("setPlanReviewThreadResolved persisted-row size", () => {
  const workspaceId = "ws-plan-review-resolve";
  let historyHandle: Awaited<ReturnType<typeof createTestHistoryService>>;
  const emitted: MuxMessage[] = [];

  beforeEach(async () => {
    historyHandle = await createTestHistoryService();
    emitted.length = 0;
  });

  afterEach(async () => {
    await historyHandle.cleanup();
  });

  function recordRow(id: string, record: PlanReviewRecord): MuxMessage {
    return createMuxMessage(id, "user", formatPlanReviewEnvelope(record), {
      timestamp: Date.now(),
      synthetic: true,
      muxMetadata: buildPlanReviewMetadata(record),
    });
  }

  function persistedRowBytes(): number[] {
    const chatPath = join(historyHandle.config.sessionsDir, workspaceId, CHAT_FILE_NAME);
    return readFileSync(chatPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => Buffer.byteLength(line, "utf8"));
  }

  async function seedThread(threadId: string): Promise<void> {
    const content = "# Plan\n\nStep one.\n";
    const snapshot: PlanReviewRecord = {
      v: 1,
      kind: "snapshot",
      recordId: "rec_snapshot",
      snapshotId: "snap_1",
      planPath: "/tmp/plan.md",
      contentHash: hashPlanSnapshotContent(content),
      content,
    };
    const feedback: PlanReviewRecord = {
      v: 1,
      kind: "feedback",
      recordId: "rec_feedback",
      feedbackId: "fb_1",
      snapshotId: "snap_1",
      contentHash: snapshot.contentHash,
      comments: [
        {
          threadId,
          anchor: { startLine: 1, endLine: 1 },
          quote: "# Plan",
          body: "Please clarify",
        },
      ],
      replies: [],
    };
    const appendSnapshot = await historyHandle.historyService.appendToHistory(
      workspaceId,
      recordRow("pr-snapshot", snapshot)
    );
    expect(appendSnapshot.success).toBe(true);
    // Persisted directly (not through preparePlanReviewFeedback): models a hand-edited or
    // otherwise forged feedback row, the only way a non-`thr_<uuid>` id enters the projection.
    const appendFeedback = await historyHandle.historyService.appendToHistory(
      workspaceId,
      recordRow("pr-feedback", feedback)
    );
    expect(appendFeedback.success).toBe(true);
  }

  test("a resolve row for an ordinary backend-generated thread id survives replay", async () => {
    const threadId = "thr_0f2c2c4e-6f7b-4f1c-9d0e-2c1c3b6a8f10";
    await seedThread(threadId);
    const deps = {
      historyService: historyHandle.historyService,
      emitChatEvent: (_workspaceId: string, message: MuxMessage) => {
        emitted.push(message);
      },
    };

    const resolved = await setPlanReviewThreadResolved(deps, {
      workspaceId,
      threadId,
      resolved: true,
    });
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;
    expect(resolved.data.threads.map((t) => [t.threadId, t.resolved])).toEqual([[threadId, true]]);
    expect(emitted).toHaveLength(1);

    const replayed = await getPlanReviewState(historyHandle.historyService, workspaceId);
    expect(replayed.success).toBe(true);
    if (!replayed.success) return;
    expect(replayed.data.threads.map((t) => [t.threadId, t.resolved])).toEqual([[threadId, true]]);
  });

  test("a resolve row for a long forged thread id must not be reported resolved if replay drops it", async () => {
    // Pick a thread id whose FEEDBACK row stays under the readable-row limit (so the thread does
    // exist in the projection) but whose RESOLVE row — which repeats the id in the envelope text
    // AND in muxMetadata.threadId — lands above it.
    const threadId = "a".repeat(600 * 1024);
    await seedThread(threadId);
    const [snapshotBytes, feedbackBytes] = persistedRowBytes();
    expect(snapshotBytes).toBeLessThan(SESSION_HISTORY_MAX_LINE_BYTES);
    expect(feedbackBytes).toBeLessThan(SESSION_HISTORY_MAX_LINE_BYTES);

    const before = await getPlanReviewState(historyHandle.historyService, workspaceId);
    expect(before.success).toBe(true);
    if (!before.success) return;
    expect(before.data.threads.map((t) => [t.threadId.length, t.resolved])).toEqual([
      [threadId.length, false],
    ]);

    const deps = {
      historyService: historyHandle.historyService,
      emitChatEvent: (_workspaceId: string, message: MuxMessage) => {
        emitted.push(message);
      },
    };
    const resolved = await setPlanReviewThreadResolved(deps, {
      workspaceId,
      threadId,
      resolved: true,
    });
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;

    const rows = persistedRowBytes();
    const resolveBytes = rows[2];
    // Evidence for the report: the resolve row is roughly twice the feedback row's id payload.
    console.log(
      `[plan-review resolve size] feedback row ${feedbackBytes} B, resolve row ${resolveBytes} B, ` +
        `limit ${SESSION_HISTORY_MAX_LINE_BYTES} B`
    );

    // Whatever the append did, the state the caller was told about and the state a fresh
    // replay derives from disk must agree. A row that only the in-memory projection can see
    // is a resolve the UI shows and the next reload silently reverts.
    const replayed = await getPlanReviewState(historyHandle.historyService, workspaceId);
    expect(replayed.success).toBe(true);
    if (!replayed.success) return;
    expect(replayed.data.threads.map((t) => [t.threadId.length, t.resolved])).toEqual(
      resolved.data.threads.map((t) => [t.threadId.length, t.resolved])
    );
  });
});
