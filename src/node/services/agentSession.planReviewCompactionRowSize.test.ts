import { afterEach, describe, expect, mock, test } from "bun:test";
import { SESSION_HISTORY_MAX_LINE_BYTES } from "@/common/constants/contextBudget";
import { PLAN_REVIEW_FEEDBACK_ROW_HEADROOM_BYTES } from "@/constants/planReview";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { CompactionFollowUpRequest } from "@/common/types/message";
import {
  createMuxMessage,
  pickStartupRetrySendOptions,
  type MuxMessage,
  type MuxMessageMetadata,
} from "@/common/types/message";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
import type { PlanReviewRecord } from "@/common/utils/planReview/planReviewRecord";
import { buildAutoCompactionFollowUp } from "./contextManagement/compactionRequests";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";

const workspaceId = "plan-review-compaction-row";
const fixtures: AgentSessionHarness[] = [];

interface Internals {
  buildAutoCompactionRequest(params: {
    followUpContent: CompactionFollowUpRequest;
    baseOptions: SendMessageOptions;
    reason: "on-send" | "mid-stream";
  }): { messageText: string; metadata: MuxMessageMetadata; sendOptions: SendMessageOptions };
}

afterEach(async () => {
  mock.restore();
  for (const h of fixtures.splice(0).reverse()) {
    await h.session.dispose();
    await h.cleanup();
  }
});

/** Same formula as planReviewService.measurePersistedRowBytes (module-private there). */
function persistedRowBytes(message: MuxMessage): number {
  return Buffer.byteLength(
    JSON.stringify({
      ...message,
      workspaceId,
      metadata: { ...message.metadata, historySequence: Number.MAX_SAFE_INTEGER },
    }),
    "utf8"
  );
}

/**
 * preparePlanReviewFeedback caps the ORDINARY user-row shape of a feedback envelope at
 * SESSION_HISTORY_MAX_LINE_BYTES - PLAN_REVIEW_FEEDBACK_ROW_HEADROOM_BYTES. When that send trips
 * on-send auto-compaction instead, the persisted row is the compaction REQUEST, which carries the
 * envelope twice (prompt text + metadata.parsed.followUpContent.text). This measures that shape
 * with the real builder and records which readers still see the row.
 */
describe("on-send auto-compaction request row for plan-review feedback", () => {
  test("a feedback just under the ordinary-row cap yields a compaction request row above the line limit", async () => {
    const h = await createAgentSessionHarness({ workspaceId });
    fixtures.push(h);
    const options: SendMessageOptions = {
      model: "openai:gpt-4o",
      agentId: "plan",
      toolPolicy: [{ regex_match: ".*", action: "disable" }],
    };
    const maxRowBytes = SESSION_HISTORY_MAX_LINE_BYTES - PLAN_REVIEW_FEEDBACK_ROW_HEADROOM_BYTES;
    const feedbackRow = (body: string) => {
      const record: PlanReviewRecord = {
        v: 1,
        kind: "feedback",
        recordId: "rec_feedback",
        feedbackId: "fb_1",
        snapshotId: "snap_1",
        contentHash: "a".repeat(64),
        comments: [
          { threadId: "thr_1", anchor: { startLine: 1, endLine: 1 }, quote: "# Plan", body },
        ],
        replies: [],
      };
      const text = formatPlanReviewEnvelope(record);
      return {
        text,
        muxMetadata: buildPlanReviewMetadata(record),
        message: createMuxMessage("user-feedback", "user", text, {
          timestamp: Date.now(),
          toolPolicy: options.toolPolicy,
          retrySendOptions: pickStartupRetrySendOptions(options),
          muxMetadata: buildPlanReviewMetadata(record),
        }),
      };
    };
    // Plain ASCII body sized so the ordinary user row sits just under the prepare-time cap.
    const overhead = persistedRowBytes(feedbackRow("").message);
    const feedback = feedbackRow("a".repeat(maxRowBytes - overhead));
    const ordinaryRowBytes = persistedRowBytes(feedback.message);
    expect(ordinaryRowBytes).toBeLessThanOrEqual(maxRowBytes);

    const followUpContent = buildAutoCompactionFollowUp({
      messageText: feedback.text,
      options,
      modelForStream: options.model,
      muxMetadata: feedback.muxMetadata,
    });
    const request = (h.session as unknown as Internals).buildAutoCompactionRequest({
      followUpContent,
      baseOptions: options,
      reason: "on-send",
    });
    // The row sendMessage persists for the compaction request (text + muxMetadata + options).
    const requestRow = createMuxMessage("compaction-request", "user", request.messageText, {
      timestamp: Date.now(),
      toolPolicy: request.sendOptions.toolPolicy,
      retrySendOptions: pickStartupRetrySendOptions(request.sendOptions),
      muxMetadata: request.metadata,
    });
    const requestRowBytes = persistedRowBytes(requestRow);
    // The summary row that follows carries the follow-up once more (pendingFollowUp) plus the
    // model's summary text; DEFAULT_COMPACTION_WORD_TARGET words ≈ 2000 × 6 chars.
    const summaryRow = createMuxMessage("summary", "assistant", "word ".repeat(2000), {
      timestamp: Date.now(),
      compactionBoundary: true,
      compacted: "user",
      muxMetadata: { type: "compaction-summary", pendingFollowUp: followUpContent },
    });
    const summaryRowBytes = persistedRowBytes(summaryRow);
    console.log(
      `[plan-review compaction row] ordinary feedback row ${ordinaryRowBytes} B (cap ${maxRowBytes}); ` +
        `on-send compaction request row ${requestRowBytes} B; summary row ${summaryRowBytes} B; ` +
        `line limit ${SESSION_HISTORY_MAX_LINE_BYTES} B`
    );
    expect(requestRowBytes).toBeGreaterThan(SESSION_HISTORY_MAX_LINE_BYTES);

    // Which readers still see the oversized request row once persisted.
    expect((await h.historyService.appendToHistory(workspaceId, requestRow)).success).toBe(true);
    const provider = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(provider.success).toBe(true);
    if (!provider.success) return;
    expect(provider.data.map((m) => m.id)).toEqual(["compaction-request"]);
    const replayed: string[] = [];
    await h.historyService.iterateFullHistory(workspaceId, "forward", (chunk) => {
      for (const m of chunk) replayed.push(m.id);
    });
    expect(replayed).toEqual(["compaction-request"]);
    // The bounded scanner (session_history tool) is the reader that skips oversized rows.
    const visited: string[] = [];
    const bounded = await h.historyService.scanHistoryBounded(workspaceId, {
      recentFirst: true,
      visit: (row) => {
        visited.push(row.message.id);
        return true;
      },
    });
    console.log(
      `[plan-review compaction row] bounded scan visited ${JSON.stringify(visited)}, oversizedLines=${bounded.oversizedLines}`
    );
  });
});
