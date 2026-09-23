import { createHash } from "node:crypto";
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
import { preparePlanReviewFeedback } from "./planReviewService";
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
 * When a feedback send trips on-send auto-compaction, the persisted row is the compaction REQUEST,
 * which carries the envelope twice (prompt text + metadata.parsed.followUpContent.text), and the
 * summary boundary carries it again beside the model's summary. preparePlanReviewFeedback must
 * budget that derived shape: the largest feedback it accepts must still produce a request row within
 * the history line limit, measured with the real builder.
 */
describe("on-send auto-compaction request row for plan-review feedback", () => {
  test("the largest accepted feedback produces a compaction request row within the line limit", async () => {
    const h = await createAgentSessionHarness({ workspaceId });
    fixtures.push(h);
    const options: SendMessageOptions = {
      model: "openai:gpt-4o",
      agentId: "plan",
      toolPolicy: [{ regex_match: ".*", action: "disable" }],
    };
    const content = "# Plan\n";
    const snapshot: PlanReviewRecord = {
      v: 1,
      kind: "snapshot",
      recordId: "rec_snapshot",
      snapshotId: "snap_1",
      planPath: "/plans/p.md",
      contentHash: createHash("sha256").update(content).digest("hex"),
      content,
    };
    expect(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("snapshot-row", "user", formatPlanReviewEnvelope(snapshot), {
            synthetic: true,
            muxMetadata: buildPlanReviewMetadata(snapshot),
          })
        )
      ).success
    ).toBe(true);
    const prepare = (bodyLength: number) =>
      preparePlanReviewFeedback(
        h.historyService,
        workspaceId,
        {
          snapshotId: "snap_1",
          comments: [
            { anchor: { startLine: 1, endLine: 1 }, quote: "# Plan", body: "a".repeat(bodyLength) },
          ],
          replies: [],
        },
        options
      );

    // A body that fits the ORDINARY row cap on its own is refused: its compaction request would not.
    const ordinaryCapBody =
      SESSION_HISTORY_MAX_LINE_BYTES - PLAN_REVIEW_FEEDBACK_ROW_HEADROOM_BYTES - 4096;
    const refused = await prepare(ordinaryCapBody);
    expect(!refused.success && refused.error.type).toBe("feedback_too_large");

    // Largest accepted body (binary search), then the real request row for it.
    let low = 1;
    let high = ordinaryCapBody;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((await prepare(mid)).success) low = mid;
      else high = mid - 1;
    }
    const accepted = await prepare(low);
    expect(accepted.success).toBe(true);
    if (!accepted.success) return;
    const followUpContent = buildAutoCompactionFollowUp({
      messageText: accepted.data.text,
      options,
      modelForStream: options.model,
      muxMetadata: accepted.data.muxMetadata,
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
    expect(persistedRowBytes(requestRow)).toBeLessThanOrEqual(SESSION_HISTORY_MAX_LINE_BYTES);
    // The summary boundary carries the follow-up once plus a default-length summary.
    const summaryRow = createMuxMessage("summary", "assistant", "word ".repeat(2000), {
      timestamp: Date.now(),
      compactionBoundary: true,
      compacted: "user",
      muxMetadata: { type: "compaction-summary", pendingFollowUp: followUpContent },
    });
    expect(persistedRowBytes(summaryRow)).toBeLessThanOrEqual(SESSION_HISTORY_MAX_LINE_BYTES);
  });
});
