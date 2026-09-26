import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import assert from "@/common/utils/assert";
import type { SendMessageOptions, WorkspaceChatMessage } from "@/common/orpc/types";
import { createMuxMessage, type MuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import { Err } from "@/common/types/result";
import { PLAN_REVIEW_FEEDBACK_STALE_MESSAGE, type AgentSession } from "./agentSession";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
  getAuthenticPlanReviewRecord,
} from "@/common/utils/planReview/planReviewEnvelope";
import type { PlanReviewRecord } from "@/common/utils/planReview/planReviewRecord";
import type { CompactionMonitor } from "./compactionMonitor";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import { HistoryService } from "./historyService";
import { getPlanReviewState, hashPlanSnapshotContent } from "./planReviewService";
import {
  createAgentSessionHarness,
  runSessionTerminalPolicy,
  type AgentSessionHarness,
} from "./agentSession.testHarness";

const workspaceId = "plan-review-compaction-handoff";
const options: SendMessageOptions = { model: "openai:gpt-4o", agentId: "plan" };
const fixtures: AgentSessionHarness[] = [];

/**
 * planReviewSubmitFeedback sends the feedback envelope through the ordinary user-message path.
 * When that send trips ON-SEND auto-compaction, sendMessage durably appends only a
 * compaction-request row whose nested follow-up (metadata.parsed.followUpContent) carries the
 * envelope text + plan-review muxMetadata; the authentic feedback row exists only once the
 * post-compaction follow-up dispatches. These tests pin what is durable at each step.
 */
async function fixture() {
  const h = await createAgentSessionHarness({ workspaceId, captureEvents: true });
  fixtures.push(h);
  // Force the divert: every pre-send check says "compact first".
  (
    h.session as unknown as { contextController: { compactionMonitor: CompactionMonitor } }
  ).contextController.compactionMonitor = {
    checkBeforeSend: mock(() => ({
      shouldShowWarning: true,
      shouldForceCompact: true,
      usagePercentage: 99,
      thresholdPercentage: 85,
    })),
    checkMidStream: mock(() => false),
    resetForNewStream: mock(() => undefined),
  } as unknown as CompactionMonitor;
  const rows = async (): Promise<MuxMessage[]> => {
    const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(result.success);
    return result.data;
  };
  const allRows = async (): Promise<MuxMessage[]> => {
    const collected: MuxMessage[] = [];
    const scanned = await h.historyService.iterateFullHistory(workspaceId, "forward", (chunk) => {
      collected.push(...chunk);
    });
    assert(scanned.success);
    return collected;
  };
  return { ...h, stream: spyOn(h.aiService, "streamMessage"), rows, allRows };
}

afterEach(async () => {
  mock.restore();
  for (const h of fixtures.splice(0).reverse()) {
    await h.session.dispose();
    await h.cleanup();
  }
});

const planContent = "# Plan\n\nStep one.\n";
const snapshot: PlanReviewRecord = {
  v: 1,
  kind: "snapshot",
  recordId: "rec_snapshot",
  snapshotId: "snap_1",
  planPath: "/tmp/plan.md",
  contentHash: hashPlanSnapshotContent(planContent),
  content: planContent,
};
/** What preparePlanReviewFeedback hands to sendMessage: envelope text + metadata mirror. */
const feedback: PlanReviewRecord = {
  v: 1,
  kind: "feedback",
  recordId: "rec_feedback",
  feedbackId: "fb_1",
  snapshotId: snapshot.snapshotId,
  contentHash: snapshot.contentHash,
  comments: [
    {
      threadId: "thr_1",
      anchor: { startLine: 1, endLine: 1 },
      quote: "# Plan",
      body: "Please clarify step one",
    },
  ],
  replies: [],
};
const feedbackText = formatPlanReviewEnvelope(feedback);
const feedbackMeta = buildPlanReviewMetadata(feedback);

async function seedSnapshot(h: Awaited<ReturnType<typeof fixture>>) {
  const appended = await h.historyService.appendToHistory(
    workspaceId,
    createMuxMessage("pr-snapshot", "user", formatPlanReviewEnvelope(snapshot), {
      timestamp: Date.now(),
      synthetic: true,
      muxMetadata: buildPlanReviewMetadata(snapshot),
    })
  );
  expect(appended.success).toBe(true);
}

async function sendDivertedFeedback(h: Awaited<ReturnType<typeof fixture>>) {
  const sent = await h.session.sendMessage(feedbackText, { ...options, muxMetadata: feedbackMeta });
  expect(sent.success).toBe(true);
  expect(h.stream).toHaveBeenCalledTimes(1);
  const request = (await h.rows()).find(
    (row) => row.metadata?.muxMetadata?.type === "compaction-request"
  );
  assert(request?.metadata?.muxMetadata?.type === "compaction-request");
  return request;
}

function authenticFeedbackRows(rowsToScan: MuxMessage[]): MuxMessage[] {
  return rowsToScan.filter((row) => getAuthenticPlanReviewRecord(row)?.kind === "feedback");
}

function planReviewThreads(state: Awaited<ReturnType<typeof getPlanReviewState>>) {
  assert(state.success);
  return state.data.threads.map((thread) => thread.threadId);
}

describe("plan-review feedback diverted into on-send auto-compaction", () => {
  test("(1) the divert persists only the compaction request; the follow-up keeps text + metadata; state lacks the feedback", async () => {
    const h = await fixture();
    await seedSnapshot(h);
    const request = await sendDivertedFeedback(h);

    assert(request.metadata?.muxMetadata?.type === "compaction-request");
    const followUp = request.metadata.muxMetadata.parsed.followUpContent;
    expect(followUp?.text).toBe(feedbackText);
    expect(followUp?.muxMetadata).toEqual(feedbackMeta);
    // No authentic feedback row yet — the endpoint's post-send getPlanReviewState cannot see it.
    expect(authenticFeedbackRows(await h.allRows())).toHaveLength(0);
    expect(planReviewThreads(await getPlanReviewState(h.historyService, workspaceId))).toEqual([]);
    const triggered = h.events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "auto-compaction-triggered" }> =>
        event.type === "auto-compaction-triggered"
    );
    expect(triggered?.reason).toBe("on-send");
  });

  test("(2) compaction completion dispatches exactly one authentic feedback row and the projection sees one thread", async () => {
    const h = await fixture();
    await seedSnapshot(h);
    await sendDivertedFeedback(h);
    // Let the follow-up itself stream normally (no second divert).
    (
      h.session as unknown as { contextController: { compactionMonitor: CompactionMonitor } }
    ).contextController.compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: false,
        shouldForceCompact: false,
        usagePercentage: 10,
        thresholdPercentage: 85,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
    } as unknown as CompactionMonitor;

    await runSessionTerminalPolicy(h.session, h.aiEmitter, {
      type: "stream-end",
      workspaceId,
      messageId: "compaction-summary",
      parts: [{ type: "text", text: "Summary of the plan discussion." }],
      metadata: { model: options.model, agentId: "compact", finishReason: "stop" },
    });

    const epoch = await h.rows();
    expect(epoch[0]?.metadata?.compactionBoundary).toBe(true);
    const summaryMeta = epoch[0]?.metadata?.muxMetadata;
    assert(summaryMeta?.type === "compaction-summary");
    // The handoff stays on the summary after dispatch (cleared only by cancel); the staleness
    // guard (a non-copy row now follows the summary) prevents a second dispatch.
    expect(summaryMeta.pendingFollowUp?.muxMetadata).toEqual(feedbackMeta);
    const feedbackRows = authenticFeedbackRows(await h.allRows());
    expect(feedbackRows).toHaveLength(1);
    expect(feedbackRows[0].metadata?.muxMetadata).toEqual(feedbackMeta);
    expect(planReviewThreads(await getPlanReviewState(h.historyService, workspaceId))).toEqual([
      "thr_1",
    ]);
    // Compaction stream + follow-up stream.
    expect(h.stream).toHaveBeenCalledTimes(2);

    // A restart after the dispatch must not replay the retained handoff (no duplicate row).
    await h.session.dispose();
    const restarted = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: new HistoryService(h.config),
    });
    fixtures.push(restarted);
    expect(await restarted.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(false);
    expect(authenticFeedbackRows(await h.allRows())).toHaveLength(1);
  });

  test("(3b) a failed follow-up dispatch leaves the handoff on the summary; startup recovery dispatches it exactly once", async () => {
    const h = await fixture();
    await seedSnapshot(h);
    await sendDivertedFeedback(h);
    // The follow-up send fails at stream end (e.g. transient refusal); the summary must retain
    // the durable handoff.
    const internals = h.session as unknown as { sendMessage: AgentSession["sendMessage"] };
    const originalSend = h.session.sendMessage.bind(h.session);
    let sends = 0;
    internals.sendMessage = (async (...args: Parameters<AgentSession["sendMessage"]>) => {
      sends += 1;
      if (sends === 1) return Err({ type: "unknown", raw: "follow-up dispatch failed" });
      return originalSend(...args);
    }) as AgentSession["sendMessage"];
    await runSessionTerminalPolicy(h.session, h.aiEmitter, {
      type: "stream-end",
      workspaceId,
      messageId: "compaction-summary",
      parts: [{ type: "text", text: "Summary of the plan discussion." }],
      metadata: { model: options.model, agentId: "compact", finishReason: "stop" },
    });
    expect(sends).toBe(1);
    const epoch = await h.rows();
    const summaryMeta = epoch[0]?.metadata?.muxMetadata;
    assert(summaryMeta?.type === "compaction-summary");
    expect(summaryMeta.pendingFollowUp?.muxMetadata).toEqual(feedbackMeta);
    expect(authenticFeedbackRows(await h.allRows())).toHaveLength(0);

    await h.session.dispose();
    const restarted = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: new HistoryService(h.config),
    });
    fixtures.push(restarted);
    (
      restarted.session as unknown as {
        contextController: { compactionMonitor: CompactionMonitor };
      }
    ).contextController.compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: false,
        shouldForceCompact: false,
        usagePercentage: 10,
        thresholdPercentage: 85,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
    } as unknown as CompactionMonitor;
    expect(await restarted.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(true);
    const feedbackRows = authenticFeedbackRows(await h.allRows());
    expect(feedbackRows).toHaveLength(1);
    expect(feedbackRows[0].metadata?.muxMetadata).toEqual(feedbackMeta);
    expect(planReviewThreads(await getPlanReviewState(h.historyService, workspaceId))).toEqual([
      "thr_1",
    ]);
    // Second recovery pass: the handoff is now followed by the feedback row → no re-dispatch.
    expect(await restarted.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(false);
    expect(authenticFeedbackRows(await h.allRows())).toHaveLength(1);
  });

  test("(3) a crash after the divert leaves the nested follow-up as the interrupted tail; restart re-arms the compaction, not a plain resend", async () => {
    const h = await fixture();
    await seedSnapshot(h);
    await sendDivertedFeedback(h);
    // Crash before the compaction stream produced anything.
    await h.session.dispose();

    const restarted = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: new HistoryService(h.config),
      captureEvents: true,
    });
    fixtures.push(restarted);
    const restartedStream = spyOn(restarted.aiService, "streamMessage");
    // Startup follow-up recovery only handles a durable summary; there is none yet.
    expect(await restarted.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(false);
    await restarted.session.ensureStartupAutoRetryCheck();
    const scheduled = restarted.events.find((event) => event.type === "auto-retry-scheduled");
    expect(scheduled).toBeDefined();
    const resume = (
      restarted.session as unknown as {
        lastAutoRetryResumeRequest?: { options: SendMessageOptions };
      }
    ).lastAutoRetryResumeRequest;
    // The retry replays the compaction request (compact agent) whose nested follow-up still
    // carries the feedback text + metadata, so the feedback is represented exactly once.
    expect(resume?.options.agentId).toBe("compact");
    // SendMessageOptions.muxMetadata is a black box at this boundary; narrow it explicitly.
    const resumeMeta = resume?.options.muxMetadata as MuxMessageMetadata | undefined;
    assert(resumeMeta?.type === "compaction-request");
    expect(resumeMeta.parsed.followUpContent?.text).toBe(feedbackText);
    expect(resumeMeta.parsed.followUpContent?.muxMetadata).toEqual(feedbackMeta);
    expect(restartedStream).not.toHaveBeenCalled();
    expect(authenticFeedbackRows(await h.allRows())).toHaveLength(0);
    expect(
      (await h.allRows()).filter((row) => row.metadata?.muxMetadata?.type === "compaction-request")
    ).toHaveLength(1);
  });

  test("(4) Stop during the diverted compaction retains the nested follow-up in the request row and restores nothing to the composer", async () => {
    const h = await fixture();
    await seedSnapshot(h);
    await sendDivertedFeedback(h);

    const stopped = await h.session.interruptStream();
    expect(stopped.success).toBe(true);
    h.session.restoreQueueToInput();

    const restore = h.events.filter((event) => event.type === "restore-to-input");
    expect(restore).toEqual([]);
    const epoch = await h.rows();
    const request = epoch.find((row) => row.metadata?.muxMetadata?.type === "compaction-request");
    assert(request?.metadata?.muxMetadata?.type === "compaction-request");
    expect(request.metadata.muxMetadata.parsed.followUpContent?.muxMetadata).toEqual(feedbackMeta);
    expect(authenticFeedbackRows(await h.allRows())).toHaveLength(0);
    expect(planReviewThreads(await getPlanReviewState(h.historyService, workspaceId))).toEqual([]);

    // After a user Stop, a restart does not silently re-arm the compaction: the handoff stays
    // in the request row until the user retries the compaction from the transcript.
    await h.session.dispose();
    const restarted = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: new HistoryService(h.config),
      captureEvents: true,
    });
    fixtures.push(restarted);
    await restarted.session.ensureStartupAutoRetryCheck();
    expect(restarted.events.map((event) => event.type)).not.toContain("auto-retry-scheduled");
    expect(
      (await h.allRows()).filter((row) => row.metadata?.muxMetadata?.type === "compaction-request")
    ).toHaveLength(1);
    expect(authenticFeedbackRows(await h.allRows())).toHaveLength(0);
  });
});

/**
 * A sibling backend (XUM_ALLOW_MULTIPLE_INSTANCES, or the desktop app beside `xum server`) can
 * truncate history between feedback preparation and the row's append, and while a diverted
 * compaction runs; WorkspaceService's in-memory epochs never see it. It is modelled as a second
 * HistoryService over the same config, which shares the cross-process history write lock.
 */
describe("plan-review feedback whose snapshot or threads leave history before its append", () => {
  function setMonitor(h: Awaited<ReturnType<typeof fixture>>, divert: boolean) {
    (
      h.session as unknown as { contextController: { compactionMonitor: CompactionMonitor } }
    ).contextController.compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: divert,
        shouldForceCompact: divert,
        usagePercentage: divert ? 99 : 10,
        thresholdPercentage: 85,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
    } as unknown as CompactionMonitor;
  }

  /** Rows after the snapshot, each larger than it, so a small token cut removes only the snapshot. */
  async function seedFillers(h: Awaited<ReturnType<typeof fixture>>) {
    for (const id of ["filler-1", "filler-2", "filler-3"]) {
      const appended = await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage(id, "user", `${id} ${"context ".repeat(400)}`, { timestamp: Date.now() })
      );
      expect(appended.success).toBe(true);
    }
  }

  /** The sibling's partial truncation; asserts it removed the snapshot and kept the fillers. */
  async function siblingTruncateSnapshot(h: Awaited<ReturnType<typeof fixture>>) {
    const cut = await new HistoryService(h.config).truncateHistory(workspaceId, 0.05, {
      refuseFullDelete: true,
    });
    expect(cut.success).toBe(true);
    const ids = (await h.allRows()).map((row) => row.id);
    expect(ids).not.toContain("pr-snapshot");
    expect(ids).toContain("filler-3");
  }

  test("(5) feedback sent after a sibling truncation removed its snapshot is refused at the append", async () => {
    const h = await fixture();
    setMonitor(h, false);
    await seedSnapshot(h);
    await seedFillers(h);
    await siblingTruncateSnapshot(h);

    const sent = await h.session.sendMessage(feedbackText, {
      ...options,
      muxMetadata: feedbackMeta,
    });
    expect(!sent.success && sent.error.type === "unknown" && sent.error.raw).toBe(
      PLAN_REVIEW_FEEDBACK_STALE_MESSAGE
    );
    expect(h.stream).not.toHaveBeenCalled();
    expect(authenticFeedbackRows(await h.allRows())).toHaveLength(0);
  });

  test("(6) the diverting compaction request is refused when its nested feedback's snapshot is gone", async () => {
    const h = await fixture();
    await seedSnapshot(h);
    await seedFillers(h);
    await siblingTruncateSnapshot(h);

    const sent = await h.session.sendMessage(feedbackText, {
      ...options,
      muxMetadata: feedbackMeta,
    });
    expect(!sent.success && sent.error.type === "unknown" && sent.error.raw).toBe(
      PLAN_REVIEW_FEEDBACK_STALE_MESSAGE
    );
    expect(h.stream).not.toHaveBeenCalled();
    expect(
      (await h.allRows()).filter((row) => row.metadata?.muxMetadata?.type === "compaction-request")
    ).toHaveLength(0);
  });

  test("(7) a sibling truncation after the diverted compaction lands refuses the follow-up and drops the handoff", async () => {
    const h = await fixture();
    await seedSnapshot(h);
    await seedFillers(h);
    await sendDivertedFeedback(h);
    setMonitor(h, false);
    // The sibling cuts right after the summary lands, before the follow-up dispatch appends
    // (a cut while the compaction still streams fails that compaction instead). The snapshot now
    // sits before the boundary, so this cut does not touch the active context at all.
    const internals = h.session as unknown as { sendMessage: AgentSession["sendMessage"] };
    const originalSend = h.session.sendMessage.bind(h.session);
    let sends = 0;
    internals.sendMessage = (async (...args: Parameters<AgentSession["sendMessage"]>) => {
      sends += 1;
      if (sends === 1) await siblingTruncateSnapshot(h);
      return originalSend(...args);
    }) as AgentSession["sendMessage"];

    await runSessionTerminalPolicy(h.session, h.aiEmitter, {
      type: "stream-end",
      workspaceId,
      messageId: "compaction-summary",
      parts: [{ type: "text", text: "Summary of the plan discussion." }],
      metadata: { model: options.model, agentId: "compact", finishReason: "stop" },
    });

    expect(sends).toBe(1);
    expect(authenticFeedbackRows(await h.allRows())).toHaveLength(0);
    const summaryMeta = (await h.rows())[0]?.metadata?.muxMetadata;
    assert(summaryMeta?.type === "compaction-summary");
    // Dropped: the refusal is permanent, so no startup would ever dispatch it successfully.
    expect(summaryMeta.pendingFollowUp).toBeUndefined();
    await h.session.dispose();
    const restarted = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: new HistoryService(h.config),
    });
    fixtures.push(restarted);
    expect(await restarted.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(false);
    expect(authenticFeedbackRows(await h.allRows())).toHaveLength(0);
  });

  test("(8) a reply to a thread whose feedback row a sibling removed is refused", async () => {
    const h = await fixture();
    setMonitor(h, false);
    await seedSnapshot(h);
    const opened = await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("pr-feedback", "user", feedbackText, {
        timestamp: Date.now(),
        muxMetadata: feedbackMeta,
      })
    );
    expect(opened.success).toBe(true);
    const deleted = await new HistoryService(h.config).deleteMessages(workspaceId, ["pr-feedback"]);
    expect(deleted.success).toBe(true);

    const reply: PlanReviewRecord = {
      v: 1,
      kind: "feedback",
      recordId: "rec_reply",
      feedbackId: "fb_2",
      snapshotId: snapshot.snapshotId,
      contentHash: snapshot.contentHash,
      comments: [],
      replies: [{ replyId: "rpl_1", threadId: "thr_1", body: "Still unclear" }],
    };
    const sent = await h.session.sendMessage(formatPlanReviewEnvelope(reply), {
      ...options,
      muxMetadata: buildPlanReviewMetadata(reply),
    });
    expect(!sent.success && sent.error.type === "unknown" && sent.error.raw).toBe(
      PLAN_REVIEW_FEEDBACK_STALE_MESSAGE
    );
    expect(authenticFeedbackRows(await h.allRows())).toHaveLength(0);
  });

  test("(9) sibling appends before the send do not refuse feedback", async () => {
    const h = await fixture();
    setMonitor(h, false);
    await seedSnapshot(h);
    const appended = await new HistoryService(h.config).appendToHistory(
      workspaceId,
      createMuxMessage("sibling-row", "user", "unrelated", { timestamp: Date.now() })
    );
    expect(appended.success).toBe(true);

    const sent = await h.session.sendMessage(feedbackText, {
      ...options,
      muxMetadata: feedbackMeta,
    });
    expect(sent.success).toBe(true);
    expect(authenticFeedbackRows(await h.allRows())).toHaveLength(1);
    expect(planReviewThreads(await getPlanReviewState(h.historyService, workspaceId))).toEqual([
      "thr_1",
    ]);
  });

  test("(10) a sibling backend re-dispatching an already delivered follow-up is refused", async () => {
    const h = await fixture();
    await seedSnapshot(h);
    await sendDivertedFeedback(h);
    setMonitor(h, false);
    await runSessionTerminalPolicy(h.session, h.aiEmitter, {
      type: "stream-end",
      workspaceId,
      messageId: "compaction-summary",
      parts: [{ type: "text", text: "Summary of the plan discussion." }],
      metadata: { model: options.model, agentId: "compact", finishReason: "stop" },
    });
    // The compaction request and summary that carried the follow-up did not block its own append.
    expect(authenticFeedbackRows(await h.allRows())).toHaveLength(1);
    expect(h.stream).toHaveBeenCalledTimes(2);

    // A sibling backend (XUM_ALLOW_MULTIPLE_INSTANCES) that passed its staleness check before
    // this append sends the same retained handoff: same record, so it must not append again.
    const sibling = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: new HistoryService(h.config),
    });
    fixtures.push(sibling);
    const siblingStream = spyOn(sibling.aiService, "streamMessage");
    const sent = await sibling.session.sendMessage(feedbackText, {
      ...options,
      muxMetadata: feedbackMeta,
    });
    expect(!sent.success && sent.error.type === "unknown" && sent.error.raw).toBe(
      PLAN_REVIEW_FEEDBACK_STALE_MESSAGE
    );
    expect(siblingStream).not.toHaveBeenCalled();
    expect(authenticFeedbackRows(await h.allRows())).toHaveLength(1);
  });

  test("(11) an intact copy repairs an earlier partial copy of the same record", async () => {
    const h = await fixture();
    setMonitor(h, false);
    await seedSnapshot(h);
    // A damaged crash duplicate of the same record: its only comment anchor points past the
    // snapshot, so the projection accepts the feedback without its thread (partial).
    assert(feedback.kind === "feedback");
    const damaged: PlanReviewRecord = {
      ...feedback,
      comments: [{ ...feedback.comments[0], anchor: { startLine: 99, endLine: 99 } }],
    };
    expect(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("pr-feedback-damaged", "user", formatPlanReviewEnvelope(damaged), {
            timestamp: Date.now(),
            muxMetadata: buildPlanReviewMetadata(damaged),
          })
        )
      ).success
    ).toBe(true);
    expect(planReviewThreads(await getPlanReviewState(h.historyService, workspaceId))).toEqual([]);

    const sent = await h.session.sendMessage(feedbackText, {
      ...options,
      muxMetadata: feedbackMeta,
    });
    expect(sent.success).toBe(true);
    expect(h.stream).toHaveBeenCalledTimes(1);
    const state = await getPlanReviewState(h.historyService, workspaceId);
    expect(planReviewThreads(state)).toEqual(["thr_1"]);
    assert(state.success);
    expect(state.data.feedbacks.map((entry) => [entry.feedbackId, entry.threadIds])).toEqual([
      ["fb_1", ["thr_1"]],
    ]);
  });

  test("(12) a damaged record whose two replies share one replyId is refused", async () => {
    const h = await fixture();
    setMonitor(h, false);
    await seedSnapshot(h);
    const opened = await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("pr-feedback", "user", feedbackText, {
        timestamp: Date.now(),
        muxMetadata: feedbackMeta,
      })
    );
    expect(opened.success).toBe(true);

    // The projection admits only the first reply, so the second body would never enter review
    // state even though the row reads as sent.
    const damaged: PlanReviewRecord = {
      v: 1,
      kind: "feedback",
      recordId: "rec_reply",
      feedbackId: "fb_2",
      snapshotId: snapshot.snapshotId,
      contentHash: snapshot.contentHash,
      comments: [],
      replies: [
        { replyId: "rpl_1", threadId: "thr_1", body: "First reply" },
        { replyId: "rpl_1", threadId: "thr_1", body: "Second reply" },
      ],
    };
    const sent = await h.session.sendMessage(formatPlanReviewEnvelope(damaged), {
      ...options,
      muxMetadata: buildPlanReviewMetadata(damaged),
    });
    expect(!sent.success && sent.error.type === "unknown" && sent.error.raw).toBe(
      PLAN_REVIEW_FEEDBACK_STALE_MESSAGE
    );
    expect(h.stream).not.toHaveBeenCalled();
    expect(authenticFeedbackRows(await h.allRows())).toHaveLength(1);
  });
});

describe("plan-review feedback refused before it streams", () => {
  test("a pricing-gate refusal persists nothing instead of an editable plain-text copy", async () => {
    // planReviewSubmitFeedback reports send_failed and the client keeps its drafts to resend. A
    // preserved plain-text copy (the metadata is not kept) would duplicate the visible turn on
    // that retry and put conflicting review context in front of the model.
    const workspaceGoalService = new Proxy(
      {
        assertPricedModelForBudgetedGoal: () =>
          Promise.resolve(Err({ type: "unknown" as const, raw: "unpriced model" })),
      } as Record<PropertyKey, unknown>,
      { get: (target, prop) => target[prop] ?? (() => Promise.resolve(undefined)) }
    ) as unknown as WorkspaceGoalService;
    const h = await createAgentSessionHarness({
      workspaceId,
      captureEvents: true,
      workspaceGoalService,
    });
    fixtures.push(h);
    const stream = spyOn(h.aiService, "streamMessage");
    await seedSnapshot(h as Awaited<ReturnType<typeof fixture>>);

    const sent = await h.session.sendMessage(feedbackText, {
      ...options,
      muxMetadata: feedbackMeta,
    });

    expect(sent).toMatchObject({
      success: false,
      error: { type: "unknown", raw: "unpriced model" },
    });
    expect(stream).not.toHaveBeenCalled();
    const rows: MuxMessage[] = [];
    const scanned = await h.historyService.iterateFullHistory(workspaceId, "forward", (chunk) => {
      rows.push(...chunk);
    });
    assert(scanned.success);
    expect(rows.map((row) => row.id)).toEqual(["pr-snapshot"]);
    // The refusal is still surfaced in the transcript as a stream error.
    expect(h.events.some((event) => event.type === "stream-error")).toBe(true);
  });
});
