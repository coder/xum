import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import assert from "@/common/utils/assert";
import { createMuxMessage } from "@/common/types/message";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
import { isModelHiddenMessage } from "@/common/utils/messages/modelHiddenMessages";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";

const workspaceId = "plan-review-follow-up";
const options = { model: "openai:gpt-4o", agentId: "exec" };
const fixtures: AgentSessionHarness[] = [];

interface Internals {
  dispatchPendingFollowUp(summaryMessageId?: string): Promise<boolean>;
}

async function fixture() {
  const h = await createAgentSessionHarness({ workspaceId });
  fixtures.push(h);
  const rows = async () => {
    const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(result.success);
    return result.data;
  };
  return {
    ...h,
    stream: spyOn(h.aiService, "streamMessage"),
    rows,
    state: h.session as unknown as Internals,
  };
}

afterEach(async () => {
  mock.restore();
  for (const h of fixtures.splice(0).reverse()) {
    await h.session.dispose();
    await h.cleanup();
  }
});

/**
 * A compaction summary carries `pendingFollowUp` until its continuation dispatches. Plan-review
 * record rows (snapshot/resolve/reopen) are hidden UI state (isModelHiddenMessage) that the
 * review UI can append at any moment — including between the summary committing and the
 * follow-up dispatching (stream-end path) or between a crash and startup recovery. They are
 * not conversation, so they must not make the follow-up look stale.
 */
describe("compaction follow-up dispatch with hidden plan-review rows", () => {
  const seedSummary = (h: Awaited<ReturnType<typeof fixture>>) =>
    h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("summary", "assistant", "summary", {
        compactionBoundary: true,
        compacted: "user",
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "continue the plan", model: options.model, agentId: "exec" },
        },
      })
    );
  const appendHiddenResolve = (h: Awaited<ReturnType<typeof fixture>>) => {
    const resolve = {
      v: 1 as const,
      kind: "resolve" as const,
      recordId: "rec_1",
      threadId: "thr_1",
    };
    return h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("plan-review-resolve", "user", formatPlanReviewEnvelope(resolve), {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: buildPlanReviewMetadata(resolve),
      })
    );
  };
  const expectFollowUpDispatched = async (h: Awaited<ReturnType<typeof fixture>>) => {
    expect(h.stream).toHaveBeenCalledTimes(1);
    const last = (await h.rows()).at(-1);
    expect(last?.role).toBe("user");
    expect(last?.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "continue the plan",
    ]);
  };

  test("control: startup recovery dispatches a follow-up whose summary is the last row", async () => {
    const h = await fixture();
    expect((await seedSummary(h)).success).toBe(true);
    expect(await h.state.dispatchPendingFollowUp()).toBe(true);
    await expectFollowUpDispatched(h);
  });

  test("startup recovery still dispatches when a hidden resolve row trails the summary", async () => {
    const h = await fixture();
    expect((await seedSummary(h)).success).toBe(true);
    expect((await appendHiddenResolve(h)).success).toBe(true);
    expect(await h.state.dispatchPendingFollowUp()).toBe(true);
    await expectFollowUpDispatched(h);
  });

  test("stream-end targeted dispatch still fires when a hidden resolve row trails the summary", async () => {
    const h = await fixture();
    expect((await seedSummary(h)).success).toBe(true);
    expect((await appendHiddenResolve(h)).success).toBe(true);
    expect(await h.state.dispatchPendingFollowUp("summary")).toBe(true);
    await expectFollowUpDispatched(h);
  });
});

describe("manual resume with a hidden plan-review row at the tail", () => {
  test("resumes from the newest visible row instead of silently returning", async () => {
    const h = await fixture();
    expect(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("user-work", "user", "Refactor the scheduler", {
            timestamp: Date.now() - 1_000,
          })
        )
      ).success
    ).toBe(true);
    // Resolving a review thread appends a hidden user row as the raw tail; provider-visible
    // history is unchanged, so an explicit resume must still start a stream.
    const resolve = {
      v: 1 as const,
      kind: "resolve" as const,
      recordId: "rec_r",
      threadId: "thr_r",
    };
    expect(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("plan-review-resolve-tail", "user", formatPlanReviewEnvelope(resolve), {
            timestamp: Date.now(),
            synthetic: true,
            muxMetadata: buildPlanReviewMetadata(resolve),
          })
        )
      ).success
    ).toBe(true);
    const resumed = await h.session.resumeStream(options);
    expect(resumed.success).toBe(true);
    await h.session.waitForIdle();
    expect(h.stream).toHaveBeenCalledTimes(1);
  });
});

describe("resume after a completed assistant with a hidden plan-review row at the tail", () => {
  test("appends the [CONTINUE] sentinel so the request does not end with the assistant", async () => {
    const h = await fixture();
    const seeded = [
      createMuxMessage("user-work", "user", "Draft the plan", { timestamp: Date.now() - 2_000 }),
      createMuxMessage("assistant-done", "assistant", "Here is the plan.", {
        timestamp: Date.now() - 1_000,
      }),
    ];
    for (const message of seeded) {
      expect((await h.historyService.appendToHistory(workspaceId, message)).success).toBe(true);
    }
    // A snapshot/resolve/reopen row after the assistant is the raw tail, but request assembly
    // drops it, so the model-visible tail is still the completed assistant.
    const resolve = {
      v: 1 as const,
      kind: "resolve" as const,
      recordId: "rec_after_assistant",
      threadId: "thr_after_assistant",
    };
    expect(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("plan-review-resolve-tail", "user", formatPlanReviewEnvelope(resolve), {
            timestamp: Date.now(),
            synthetic: true,
            muxMetadata: buildPlanReviewMetadata(resolve),
          })
        )
      ).success
    ).toBe(true);

    const resumed = await h.session.resumeStream(options);
    expect(resumed.success).toBe(true);
    await h.session.waitForIdle();
    expect(h.stream).toHaveBeenCalledTimes(1);
    const visible = h.stream.mock.calls[0][0].messages.filter(
      (message) => !isModelHiddenMessage(message)
    );
    const last = visible.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "[CONTINUE]",
    ]);
  });
});
