import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { SendMessageOptions } from "@/common/orpc/types";
import { createMuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import type { SendMessageError } from "@/common/types/errors";
import { Err, Ok, type Result } from "@/common/types/result";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
import type { AgentSession } from "./agentSession";
import { hashPlanSnapshotContent } from "./planReviewService";
import { saveWorkspaces } from "./taskService.testHarness";
import {
  createCompactionAdmissionMocks,
  createMockAIService,
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

const workspaceId = "plan-review-ws";
const content = "# Plan\n\nStep one.\nStep two.\n";
// No fake session here: truncateHistory needs the real AgentSession's admission hold.
const clearedWorkspaceId = "plan-review-cleared-ws";
const options: SendMessageOptions = { model: "openai:gpt-5.2", agentId: "plan" };
const comment = { anchor: { startLine: 3, endLine: 3 }, quote: "Step one.", body: "Why first?" };
const feedback = { snapshotId: "snap_1", comments: [comment], replies: [], options };

describe("WorkspaceService.planReviewSubmitFeedback", () => {
  let harness: WorkspaceServiceHarness;
  let busy: boolean;
  // Registered through the production injection point (`registerSession`); its sendMessage
  // persists the row as AgentSession does, so the refreshed state comes from real history.
  let session: ReturnType<typeof createSession>;

  function createSession() {
    return {
      ...createCompactionAdmissionMocks(),
      isBusy: mock(() => busy),
      hasQueuedMessages: mock(() => false),
      queueMessage: mock(() => "tool-end" as const),
      sendMessage: mock(
        async (text: string, sent: SendMessageOptions): Promise<Result<void, SendMessageError>> => {
          await harness.historyService.appendToHistory(
            workspaceId,
            createMuxMessage("feedback-row", "user", text, {
              timestamp: Date.now(),
              muxMetadata: sent.muxMetadata as MuxMessageMetadata,
            })
          );
          return Ok(undefined);
        }
      ),
      onChatEvent: mock(() => () => undefined),
      onMetadataEvent: mock(() => () => undefined),
    };
  }

  async function feedbackIds(): Promise<string[]> {
    const state = await harness.service.planReviewGetState(workspaceId);
    expect(state.success).toBe(true);
    return state.success ? state.data.feedbacks.map((row) => row.feedbackId) : [];
  }

  async function seedSnapshot(id: string): Promise<void> {
    const snapshot = {
      v: 1 as const,
      kind: "snapshot" as const,
      recordId: "rec_snapshot",
      snapshotId: "snap_1",
      planPath: "/tmp/plan.md",
      contentHash: hashPlanSnapshotContent(content),
      content,
    };
    await harness.historyService.appendToHistory(
      id,
      createMuxMessage("snapshot-row", "user", formatPlanReviewEnvelope(snapshot), {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: buildPlanReviewMetadata(snapshot),
      })
    );
  }

  beforeEach(async () => {
    busy = false;
    harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({ isStreaming: mock(() => false) }),
    });
    await saveWorkspaces(harness.config, "/tmp/plan-review/project", [
      { id: workspaceId, path: "/tmp/plan-review/ws", name: "ws" },
      { id: clearedWorkspaceId, path: "/tmp/plan-review/cleared", name: "cleared" },
    ]);
    // sendMessage fires an unawaited recency write; keep it off disk so it cannot race cleanup.
    spyOn(harness.extensionMetadata, "updateRecency").mockResolvedValue({
      recency: Date.now(),
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
    });
    await seedSnapshot(workspaceId);
    session = createSession();
    harness.service.registerSession(workspaceId, session as unknown as AgentSession);
  });

  afterEach(async () => {
    mock.restore();
    await harness.cleanup();
  });

  test("sends the envelope as an immediate turn and returns the refreshed state with it", async () => {
    const result = await harness.service.planReviewSubmitFeedback(workspaceId, feedback);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.feedbackId).toMatch(/^fb_/);
    expect(result.data.state?.feedbacks.map((row) => row.feedbackId)).toEqual([
      result.data.feedbackId,
    ]);
    expect(result.data.state?.threads.map((thread) => thread.body)).toEqual(["Why first?"]);
    expect(session.queueMessage).not.toHaveBeenCalled();
  });

  test("edit semantics are refused before anything is read or sent", async () => {
    const refused = harness.service.planReviewSubmitFeedback(workspaceId, {
      ...feedback,
      options: { ...options, editMessageId: "older-row" },
    });
    // The service asserts this programming error instead of returning a result.
    expect(
      await refused.then(
        () => "resolved",
        () => "rejected"
      )
    ).toBe("rejected");
    expect(session.sendMessage).not.toHaveBeenCalled();
  });

  test("a validation error is returned as-is and nothing is sent", async () => {
    const result = await harness.service.planReviewSubmitFeedback(workspaceId, {
      ...feedback,
      snapshotId: "snap_missing",
    });

    expect(result).toMatchObject({ success: false, error: { type: "unknown_snapshot" } });
    expect(session.sendMessage).not.toHaveBeenCalled();
  });

  test("a busy workspace refuses the feedback instead of queueing it", async () => {
    busy = true;

    const result = await harness.service.planReviewSubmitFeedback(workspaceId, feedback);

    // The generic idle-only refusal, which plan review replaces with its own guidance.
    const generic = await harness.service.sendMessage(workspaceId, "x", options, {
      requireIdle: true,
    });
    expect(generic.success).toBe(false);
    expect(result.success).toBe(false);
    if (result.success || generic.success) return;
    expect(result.error).toMatchObject({ type: "send_failed", error: { type: "unknown" } });
    expect(result.error).not.toEqual({ type: "send_failed", error: generic.error });
    expect(session.queueMessage).not.toHaveBeenCalled();
    expect(session.sendMessage).not.toHaveBeenCalled();
    expect(await feedbackIds()).toEqual([]);
  });

  test("any other send error is passed through unchanged", async () => {
    const sendError = { type: "unknown" as const, raw: "provider rejected the request" };
    session.sendMessage.mockResolvedValueOnce(Err(sendError));

    const result = await harness.service.planReviewSubmitFeedback(workspaceId, feedback);

    expect(result).toEqual(Err({ type: "send_failed", error: sendError }));
  });

  test("a context clear committed while preparing refuses the stale feedback", async () => {
    await seedSnapshot(clearedWorkspaceId);
    const iterate = harness.historyService.iterateFullHistory.bind(harness.historyService);
    spyOn(harness.historyService, "iterateFullHistory").mockImplementationOnce(
      async (...args: Parameters<typeof iterate>) => {
        const scanned = await iterate(...args);
        // Another window clears the chat after prepare read the snapshot it binds to.
        const cleared = await harness.service.truncateHistory(clearedWorkspaceId, 1.0);
        expect(cleared).toEqual(Ok(undefined));
        return scanned;
      }
    );
    const send = spyOn(harness.service, "sendMessage");

    const result = await harness.service.planReviewSubmitFeedback(clearedWorkspaceId, feedback);

    expect(result.success).toBe(false);
    if (result.success) return;
    // Refused before sendMessage: no busy or send error can produce this result.
    expect(result.error).toMatchObject({ type: "send_failed", error: { type: "unknown" } });
    expect(send).not.toHaveBeenCalled();
  });

  test("a failed state refresh after a durable send still reports success without state", async () => {
    const iterate = harness.historyService.iterateFullHistory.bind(harness.historyService);
    let scans = 0;
    spyOn(harness.historyService, "iterateFullHistory").mockImplementation(
      (...args: Parameters<typeof iterate>) =>
        ++scans === 2 ? Promise.resolve(Err("EIO: history unreadable")) : iterate(...args)
    );

    const result = await harness.service.planReviewSubmitFeedback(workspaceId, feedback);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.state).toBeNull();
    // The row is durable, so a resend would duplicate it: the id must match what history holds.
    expect(await feedbackIds()).toEqual([result.data.feedbackId]);
  });
});
