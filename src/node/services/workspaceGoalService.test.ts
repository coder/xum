import * as path from "path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import type { Config } from "@/node/config";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceGoalService, type GoalContinuationRuntimeBridge } from "./workspaceGoalService";
import { IdleDispatcher } from "./idleDispatcher";
import { createTestHistoryService } from "./testHistoryService";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { HistoryService } from "./historyService";
import type { GoalRecordV1 } from "@/common/types/goal";
import {
  GOAL_BUDGET_LIMIT_KIND,
  GOAL_CONTINUATION_IDLE_CONSUMER_NAME,
  GOAL_CONTINUATION_KIND,
} from "@/constants/goals";
import { createMuxMessage } from "@/common/types/message";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
import type { PlanReviewRecord } from "@/common/utils/planReview/planReviewRecord";
import { drainPendingDispatches, waitForCondition } from "./testDispatchHelpers";
import {
  captureGoalActivity,
  setGoalOk,
  appendUserHistoryMessage,
  appendAssistantHistoryMessage,
  getLastUserHistoryMessage,
  PROJECT_PATH,
  analyticsMock,
  continuationBridge,
  driveOneContinuation,
} from "./workspaceGoalService.testHarness";

describe("WorkspaceGoalService", () => {
  let config: Config;
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;
  let extensionMetadata: ExtensionMetadataService;
  let service: WorkspaceGoalService;
  let analytics: ReturnType<typeof analyticsMock>;
  const workspaceId = "goal-parent";

  beforeEach(async () => {
    ({ config, historyService, cleanup } = await createTestHistoryService());
    await config.addWorkspace(PROJECT_PATH, {
      id: workspaceId,
      name: "parent",
      projectName: "mux-goal-service-test-project",
      projectPath: PROJECT_PATH,
      runtimeConfig: { type: "local" },
    });
    extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    analytics = analyticsMock();
    service = new WorkspaceGoalService(config, historyService, extensionMetadata, analytics);
  });

  afterEach(async () => {
    await cleanup();
  });

  test("does not write null activity snapshots for ordinary no-goal reads", async () => {
    // Goals are GA, so tool availability asks for the current goal on every
    // turn. No-goal reads must stay read-only; lifecycle paths that actually
    // clear/corrupt-repair a goal still publish explicit null snapshots.
    const setGoalSpy = spyOn(extensionMetadata, "setGoal");

    const goal = await service.getGoal(workspaceId);

    expect(goal).toBeNull();
    expect(setGoalSpy).not.toHaveBeenCalled();
    setGoalSpy.mockRestore();
  });

  test("creates, reads, and clears a goal while updating snapshots", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "  Ship goal primitive  " });

    expect(created.objective).toBe("Ship goal primitive");
    expect(created.status).toBe("active");
    expect(created.costCents).toBe(0);
    expect(await service.getGoal(workspaceId)).toEqual(created);
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { goalId: created.goalId, objective: "Ship goal primitive", status: "active" },
    });

    const cleared = await service.clearGoal(workspaceId);

    expect(cleared?.goalId).toBe(created.goalId);
    expect(await service.getGoal(workspaceId)).toBeNull();
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({ goal: null });
    const history = await historyService.getLastMessages(workspaceId, 1);
    expect(history.success).toBe(true);
    if (!history.success) {
      throw new Error(history.error);
    }
    expect(history.data[0]?.metadata?.synthetic).toBe(true);
    // Hidden from the chat UI (the right-sidebar Goal Board already
    // shows cleared/completed goals). Still in the AI request payload
    // because synthetic + uiVisible:false stays in the model context.
    expect(history.data[0]?.metadata?.uiVisible).toBeUndefined();
    expect(history.data[0]?.parts[0]).toMatchObject({
      type: "text",
      text: 'Goal cleared: "Ship goal primitive" — spent $0.00 over 0 turns (status: active)',
    });

    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_created",
      expect.objectContaining({ objectiveLengthBucket: "10-49" })
    );
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_cleared",
      expect.objectContaining({ finalStatus: "active" })
    );
  });

  test("clearing a completed goal surfaces it on the completed board", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Finishable goal" });
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "complete",
      completionSummary: "Wrapped up.",
    });
    await service.clearGoal(workspaceId);

    const board = await service.getGoalBoard(workspaceId);
    expect(board.entries).toHaveLength(1);
    expect(board.entries[0]).toMatchObject({
      section: "complete",
      goal: {
        goalId: created.goalId,
        status: "complete",
        completionSummary: "Wrapped up.",
      },
    });
  });

  test("getGoalBoard returns completed goals newest-first when endedAtMs ties", async () => {
    const ts = Date.now();
    const nowSpy = ts;
    const dateNow = spyOn(Date, "now").mockImplementation(() => nowSpy);
    try {
      const first = await setGoalOk(service, { workspaceId, objective: "First" });
      await setGoalOk(service, {
        workspaceId,
        objective: first.objective,
        status: "complete",
        completionSummary: "First done.",
      });
      await service.clearGoal(workspaceId);
      const second = await setGoalOk(service, { workspaceId, objective: "Second" });
      await setGoalOk(service, {
        workspaceId,
        objective: second.objective,
        status: "complete",
        completionSummary: "Second done.",
      });
      await service.clearGoal(workspaceId);

      const completed = (await service.getGoalBoard(workspaceId)).entries.filter(
        (entry) => entry.section === "complete"
      );
      expect(completed).toHaveLength(2);
      // Same-ms timestamps force the append-index tie-breaker; the second append wins.
      expect(completed[0].goal.goalId).toBe(second.goalId);
      expect(completed[1].goal.goalId).toBe(first.goalId);
    } finally {
      dateNow.mockRestore();
    }
  });

  test("getGoalBoard tolerates corrupt JSONL lines without bricking completed goals", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Good entry" });
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "complete",
      completionSummary: "Done.",
    });
    await service.clearGoal(workspaceId);

    // Simulate a partially-written line from a prior crash. The board reader
    // must skip it instead of throwing.
    const historyPath = path.join(config.sessionsDir, workspaceId, "goal-history.jsonl");
    await fs.appendFile(historyPath, "{not-json}\n", "utf-8");

    const completed = (await service.getGoalBoard(workspaceId)).entries.filter(
      (entry) => entry.section === "complete"
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ goal: { goalId: created.goalId } });
  });

  test("setGoal with editInPlace renames the current goal without resetting accounting", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Initial objective" });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });

    const renamed = await setGoalOk(service, {
      workspaceId,
      objective: "Refined objective",
      editInPlace: true,
    });

    // Same `goalId`, preserved accounting — this is the contract that makes
    // the inline editor behave like budget/turn-cap edits.
    expect(renamed.goalId).toBe(created.goalId);
    expect(renamed.objective).toBe("Refined objective");
    expect(renamed.costCents).toBeGreaterThan(0);
    expect(renamed.costCents).toBe(25);
    const boardEntries = (await service.getGoalBoard(workspaceId)).entries;
    expect(boardEntries).toHaveLength(1);
    expect(boardEntries[0]).toMatchObject({
      section: "active",
      goal: { goalId: created.goalId },
    });
  });

  test("setGoal without editInPlace continues to archive + replace on objective change", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Initial objective" });
    const replaced = await setGoalOk(service, { workspaceId, objective: "Different objective" });

    // Replace flow: new goalId, with only the new active goal on the board.
    expect(replaced.goalId).not.toBe(created.goalId);
    const boardEntries = (await service.getGoalBoard(workspaceId)).entries;
    expect(boardEntries).toHaveLength(1);
    expect(boardEntries[0]).toMatchObject({
      section: "active",
      goal: { goalId: replaced.goalId },
    });
  });

  test("editInPlace without a current goal still falls through to create", async () => {
    // Without a current goal, `editInPlace` has nothing to mutate. Falling
    // through to the normal create path keeps the right-sidebar resilient if
    // the renderer race-loses to a backend clear between fetch and submit.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Fresh goal",
      editInPlace: true,
    });
    expect(created.objective).toBe("Fresh goal");
    expect((await service.getGoalBoard(workspaceId)).entries).toHaveLength(1);
  });

  test("arms a kickoff continuation when a brand-new goal is set on an idle workspace", async () => {
    const dispatcher = new IdleDispatcher();
    const executed: Array<{
      message: string;
      kind: string | undefined;
      goalId: string | undefined;
    }> = [];
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        executed.push({ message: input.message, kind: input.kind, goalId: input.goalId });
        return Promise.resolve(true);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Kick off without a prior stream",
    });
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(executed[0]?.message).toContain("<untrusted_objective>");
    expect(executed[0]?.kind).toBe("goal_continuation");
    // The dispatch carries the goal identity so the persisted row is goal-scoped.
    expect(executed[0]?.goalId).toBe(created.goalId);
  });

  test("arms a kickoff continuation when resuming a paused goal on an idle workspace", async () => {
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ message: string }> = [];
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        executed.push({ message: input.message });
        return Promise.resolve(true);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await setGoalOk(service, { workspaceId, objective: "Resume after pause", status: "paused" });
    expect(executed).toHaveLength(0);

    await setGoalOk(service, { workspaceId, status: "active" });
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(executed[0]?.message).toContain("<untrusted_objective>");
  });

  test("getGoal reconciles driven active goals to paused when the latest user turn is not a continuation", async () => {
    await setGoalOk(service, { workspaceId, objective: "Follow chat tail" });
    await driveOneContinuation(service, historyService, workspaceId);
    await appendUserHistoryMessage(historyService, workspaceId, "Manual interruption");

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "paused" });
  });

  test("getGoal keeps a never-driven active goal active across candidate loss (durable kickoff window)", async () => {
    // A goal that has never fired a continuation only has pre-goal manual user
    // rows in its chat tail (e.g. the request that made the model set it).
    // Reconciliation must not pause it — the in-memory kickoff candidate can be
    // lost (restart, eviction), and the next getGoal (heartbeat/wake tool
    // assembly) would otherwise silently pause the goal before it ever ran.
    await appendUserHistoryMessage(historyService, workspaceId, "Set yourself a goal", {
      timestamp: 10_000,
    });
    await setGoalOk(service, { workspaceId, objective: "Follow chat tail" });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "active" });
  });

  test("getGoal keeps a never-driven goal active for queued rows authored before the goal", async () => {
    // Queue race: the row is persisted at dispatch (after the goal-creating
    // turn's stream end) so its timestamp postdates the goal, but the durable
    // enqueuedAtMs proves the user typed before the goal existed.
    const created = await setGoalOk(service, { workspaceId, objective: "Queue race" });
    await appendUserHistoryMessage(historyService, workspaceId, "Typed mid-stream", {
      timestamp: created.createdAtMs + 500,
      enqueuedAtMs: created.createdAtMs - 500,
    });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "active" });
  });

  test("a paused write invalidates captured redispatch admissions before publication completes", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cSREI): the explicit-pause generation must
    // bump at the durable write commit, not after snapshot/preview
    // publication — a captured continuation's admission probe re-checked
    // during the publication awaits (before setGoal returns and arms the
    // finalization hold) must already read stale, or an autonomous turn could
    // be admitted against the committed Pause.
    const created = await setGoalOk(service, { workspaceId, objective: "Pause admission" });
    const admission = await service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_CONTINUATION_KIND
    );
    expect(admission.admissible).toBe(true);
    if (!admission.admissible) {
      throw new Error("expected admissible probe");
    }
    expect(admission.admissionStale()).toBe(false);

    // Block publication so the paused record is durable while setGoal is
    // still awaiting inside its locked persistence.
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let markPublicationEntered!: () => void;
    const publicationEntered = new Promise<void>((resolve) => {
      markPublicationEntered = resolve;
    });
    const pushSnapshotSpy = spyOn(
      service as unknown as { pushSnapshot: (workspaceId: string, goal: unknown) => Promise<void> },
      "pushSnapshot"
    ).mockImplementation(async () => {
      markPublicationEntered();
      await publicationGate;
    });
    const pausePromise = service.setGoal({
      workspaceId,
      status: "paused",
      initiator: "user",
    });
    try {
      // Atomic rename makes the file visible before write-file-atomic finishes
      // cleanup. Publication entry proves writeGoal completed its generation bump.
      await publicationEntered;
      // The durable pause has committed but publication (and the finalization
      // hold arming) has not — the captured probe must already be stale.
      expect(admission.admissionStale()).toBe(true);
      releasePublication();
      const paused = await pausePromise;
      expect(paused.success).toBe(true);
    } finally {
      releasePublication();
      try {
        // Drain the write even if an assertion fails, before fixture cleanup runs.
        await pausePromise;
      } finally {
        pushSnapshotSpy.mockRestore();
      }
    }
  });

  test("a Stop in flight refuses redispatch admissions before its acknowledgment commits", async () => {
    // Codex security P2 (PRRT_kwDOPxxmWM6cS7qG): recordUserStoppedStream bumps
    // the stop generation BEFORE awaiting the goal lock, so an admission built
    // in that window captures the post-Stop generation as its fresh baseline
    // while readGoalFile still returns the pre-Stop active record (no
    // acknowledgment gate yet). The later active→active acknowledgment write
    // moves no generation — the in-flight Stop itself must refuse admission.
    const created = await setGoalOk(service, { workspaceId, objective: "Stop latch" });
    const svc = service as unknown as {
      writeGoal: (workspaceId: string, goal: GoalRecordV1) => Promise<void>;
    };
    const realWriteGoal = svc.writeGoal.bind(service);
    let releaseAck!: () => void;
    const ackGate = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const writeSpy = spyOn(svc, "writeGoal").mockImplementationOnce(
      async (wsId: string, goal: GoalRecordV1) => {
        await ackGate;
        return realWriteGoal(wsId, goal);
      }
    );
    try {
      const stopPromise = service.recordUserStoppedStream(workspaceId);
      const admission = await service.buildGoalRedispatchAdmission(
        workspaceId,
        created.goalId,
        GOAL_CONTINUATION_KIND
      );
      expect(admission.admissible).toBe(false);
      releaseAck();
      await stopPromise;
    } finally {
      releaseAck();
      writeSpy.mockRestore();
    }
  });

  test("a synthetic assistant follower does not mark a manual row processed", async () => {
    // Codex security P2 (PRRT_kwDOPxxmWM6cS8Bx): synthetic assistant artifacts
    // (e.g. the goal-cleared summary appended by clearGoal auto-promotion) are
    // not the manual turn's settled response. Treating one as proof that the
    // intervention was processed would keep an auto-promoted goal active with
    // its autonomous kickoff recoverable over an unprocessed intervention.
    await appendUserHistoryMessage(historyService, workspaceId, "Stop this");
    await appendAssistantHistoryMessage(historyService, workspaceId, "Goal cleared: summary", {
      timestamp: Date.now(),
      synthetic: true,
    });
    await setGoalOk(service, {
      workspaceId,
      objective: "Auto-promoted goal",
      initiator: "model",
    });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "paused" });
  });

  test("a user Stop invalidates captured redispatch admissions", async () => {
    // Codex security P2 (PRRT_kwDOPxxmWM6cSx0M): recordUserStoppedStream
    // leaves an active goal's status and identity unchanged (it only bumps the
    // stop generation; the acknowledgment gate lands later), so the pause/
    // terminal/identity generation probes stay fresh across a Stop — a
    // recovered goal-scoped follow-up whose admission was captured before the
    // Stop could otherwise start an exec turn after it.
    const created = await setGoalOk(service, { workspaceId, objective: "Stop admission" });
    const admission = await service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_CONTINUATION_KIND
    );
    expect(admission.admissible).toBe(true);
    if (!admission.admissible) {
      throw new Error("expected admissible probe");
    }
    expect(admission.admissionStale()).toBe(false);

    await service.recordUserStoppedStream(workspaceId);

    expect(admission.admissionStale()).toBe(true);
  });

  test("getGoal pauses a never-driven model-created goal on an unprocessed pre-goal row", async () => {
    // Codex security P2 (PRRT_kwDOPxxmWM6cSGrq): only explicit user activation
    // is consent. A model-published goal whose chat tail ends at a queue-raced
    // manual row (no completed assistant row after it) fails closed to paused —
    // timestamp order alone must not let the model outrun a queued correction.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Model queue race",
      initiator: "model",
    });
    await appendUserHistoryMessage(historyService, workspaceId, "Typed mid-stream", {
      timestamp: created.createdAtMs + 500,
      enqueuedAtMs: created.createdAtMs - 500,
    });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "paused" });
  });

  test("getGoal keeps a never-driven model-created goal active when the pre-goal prompt was processed", async () => {
    // The initiating prompt's turn settled (completed assistant row follows
    // it) — that turn PRODUCED the goal, so the prompt is not an unprocessed
    // intervention. Candidate loss (restart/eviction) must not pause the
    // fresh goal before it ever runs.
    await appendUserHistoryMessage(historyService, workspaceId, "Set yourself a goal");
    await appendAssistantHistoryMessage(historyService, workspaceId, "Goal created");
    await setGoalOk(service, {
      workspaceId,
      objective: "Processed prompt",
      initiator: "model",
    });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "active" });
  });

  test("getGoal keeps a never-driven goal active when a hidden plan snapshot follows the processed prompt", async () => {
    // A plan turn that sets a goal and calls propose_plan appends a hidden snapshot record
    // between the manual row and the completed assistant row; the record is state, not a turn,
    // so the initiating prompt still counts as processed after candidate loss.
    await appendUserHistoryMessage(historyService, workspaceId, "Plan it and set a goal");
    const snapshot: PlanReviewRecord = {
      v: 1,
      kind: "snapshot",
      recordId: "rec_goal_snap",
      snapshotId: "snap_goal",
      planPath: "/plans/p.md",
      contentHash: "a".repeat(64),
      content: "# Plan\n",
    };
    const appended = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("goal-test-snapshot", "user", formatPlanReviewEnvelope(snapshot), {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: buildPlanReviewMetadata(snapshot),
      })
    );
    expect(appended.success).toBe(true);
    await appendAssistantHistoryMessage(historyService, workspaceId, "Plan proposed, goal set");
    await setGoalOk(service, {
      workspaceId,
      objective: "Processed prompt behind a snapshot",
      initiator: "model",
    });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "active" });
  });

  test("getGoal pauses a never-driven goal when a manual row was authored after the goal", async () => {
    // Crash-recovery self-healing: if the dispatch-time auto-pause was lost
    // (process exit between the user row persist and the pause write), the
    // durable row authored after the goal must still pause it on restart.
    const created = await setGoalOk(service, { workspaceId, objective: "Post-goal intervention" });
    await appendUserHistoryMessage(historyService, workspaceId, "Stop this goal", {
      timestamp: created.createdAtMs + 1_000,
    });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "paused" });
  });

  test("getGoal ignores malformed persisted enqueuedAtMs and pauses on the row timestamp", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6b_1_J): chat.jsonl is unchecked JSON — a
    // malformed enqueuedAtMs (negative here) must not beat a valid row
    // timestamp, or a genuine post-goal intervention would be misread as
    // pre-goal after a restart and the goal would keep running.
    const created = await setGoalOk(service, { workspaceId, objective: "Malformed metadata" });
    await appendUserHistoryMessage(historyService, workspaceId, "Stop this goal", {
      timestamp: created.createdAtMs + 1_000,
      enqueuedAtMs: -1,
    });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "paused" });
  });

  test("chat-tail reconciliation ignores synthetic maintenance user rows", async () => {
    await setGoalOk(service, { workspaceId, objective: "Ignore maintenance rows" });
    // Drive a real continuation first so the goal is past its kickoff window
    // and the synthetic-row skip below is what keeps it active.
    await driveOneContinuation(service, historyService, workspaceId);
    await appendUserHistoryMessage(historyService, workspaceId, "Synthetic heartbeat", {
      timestamp: Date.now(),
      synthetic: true,
      muxMetadata: { type: "heartbeat-request", source: "heartbeat" },
    });

    const reconciled = await service.getGoal(workspaceId);

    expect(reconciled).toMatchObject({ status: "active" });
  });

  test("pause appends a hidden user boundary so the chat tail no longer marks the goal active", async () => {
    await setGoalOk(service, { workspaceId, objective: "Pause from continuation" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue goal", {
      timestamp: Date.now(),
      synthetic: true,
      uiVisible: true,
      kind: GOAL_CONTINUATION_KIND,
    });

    const paused = await setGoalOk(service, { workspaceId, status: "paused" });
    const lastUserMessage = await getLastUserHistoryMessage(historyService, workspaceId);

    expect(paused).toMatchObject({ status: "paused" });
    expect(lastUserMessage?.metadata?.synthetic).toBe(true);
    expect(lastUserMessage?.metadata?.muxMetadata).toMatchObject({ type: "goal-pause-boundary" });
    expect(lastUserMessage?.metadata?.kind).toBeUndefined();
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "paused" });
  });

  test("resume appends a goal continuation before reporting the goal active", async () => {
    await setGoalOk(service, { workspaceId, objective: "Resume via chat tail", status: "paused" });
    await appendUserHistoryMessage(historyService, workspaceId, "Manual pause reason");
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: async (input) => {
        await appendUserHistoryMessage(historyService, input.workspaceId, input.message, {
          timestamp: Date.now(),
          synthetic: true,
          uiVisible: true,
          kind: input.kind ?? GOAL_CONTINUATION_KIND,
        });
        return true;
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const resumed = await setGoalOk(service, { workspaceId, status: "active" });
    const lastUserMessage = await getLastUserHistoryMessage(historyService, workspaceId);

    expect(resumed).toMatchObject({ status: "active" });
    expect(lastUserMessage?.metadata?.kind).toBe(GOAL_CONTINUATION_KIND);
  });

  test("pause clears a deferred kickoff continuation candidate", async () => {
    await setGoalOk(service, { workspaceId, objective: "Deferred resume", status: "paused" });
    let busy = true;
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(execute),
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: busy }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await setGoalOk(service, { workspaceId, status: "active" });
    await drainPendingDispatches();
    expect(execute).not.toHaveBeenCalled();

    await setGoalOk(service, { workspaceId, status: "paused" });
    busy = false;
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);

    expect(execute).not.toHaveBeenCalled();
  });

  test("skips the kickoff arm when no kickoff send options are available", async () => {
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ message: string }> = [];
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        executed.push({ message: input.message });
        return Promise.resolve(true);
      },
      getKickoffSendOptions: () => Promise.resolve(null),
    });

    // Negative assertion: the kickoff arm short-circuits synchronously when
    // getKickoffSendOptions returns null, so no microtask hop is needed.
    await setGoalOk(service, { workspaceId, objective: "No kickoff defaults" });

    expect(executed).toHaveLength(0);
  });

  test("falls back to priced kickoff options when stream options are unpriced for budgeted goals", async () => {
    await setGoalOk(service, {
      workspaceId,
      objective: "Use priced fallback",
      budgetCents: 500,
    });
    const dispatcher = new IdleDispatcher();
    const seenModels: string[] = [];
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge((input) => {
        seenModels.push(input.options.model);
        return Promise.resolve(true);
      }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "custom:unpriced-model", agentId: "exec" },
      streamEndedAtMs: 10_000,
    });
    await waitForCondition(() => seenModels.length > 0, { timeoutMs: 1_000 });

    expect(seenModels).toEqual(["openai:gpt-4o"]);
  });

  test("dispatches an eligible active-goal continuation and records cooldown telemetry", async () => {
    await setGoalOk(service, { workspaceId, objective: "Keep going until tests pass" });
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ message: string; workspaceId: string }> = [];
    service.registerGoalContinuationConsumer(
      dispatcher,
      continuationBridge((input) => {
        executed.push({ message: input.message, workspaceId: input.workspaceId });
        return Promise.resolve(true);
      })
    );

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 10_000,
    });

    expect(executed).toHaveLength(1);
    expect(executed[0]?.workspaceId).toBe(workspaceId);
    expect(executed[0]?.message).toContain("<untrusted_objective>");
    const updated = await service.getGoal(workspaceId);
    expect(typeof updated?.lastContinuationFiredAtMs).toBe("number");
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_continuation_fired",
      expect.objectContaining({ source: "stream_end_idle_dispatch" })
    );
  });

  test("does not carry workspace-turn metadata into goal continuations", async () => {
    await setGoalOk(service, { workspaceId, objective: "Start a new goal continuation" });
    const dispatcher = new IdleDispatcher();
    const seenOptions: SendMessageOptions[] = [];
    service.registerGoalContinuationConsumer(
      dispatcher,
      continuationBridge((input) => {
        seenOptions.push(input.options);
        return Promise.resolve(true);
      })
    );

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: {
        model: "openai:gpt-4o",
        agentId: "exec",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "delegated-task",
          ownerWorkspaceId: "owner-workspace",
          turnId: "delegated-turn",
        },
      },
      streamEndedAtMs: 10_000,
    });

    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]?.muxMetadata).toBeUndefined();
  });

  test("can suppress setGoal kickoff continuation for CLI-controlled kickoff", async () => {
    service = new WorkspaceGoalService(config, historyService, extensionMetadata, analytics, {
      suppressKickoffContinuation: true,
    });
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    service.registerGoalContinuationConsumer(dispatcher, continuationBridge(execute));

    await setGoalOk(service, { workspaceId, objective: "Wait for the CLI kickoff message" });
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);

    expect(execute).not.toHaveBeenCalled();
  });

  test("allows zero cooldown for immediate CLI-style continuations", async () => {
    service = new WorkspaceGoalService(config, historyService, extensionMetadata, analytics, {
      continuationCooldownMs: 0,
    });
    await setGoalOk(service, { workspaceId, objective: "Keep going without idle delay" });
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    service.registerGoalContinuationConsumer(dispatcher, continuationBridge(execute));

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 10_000,
    });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 10_001,
    });

    expect(execute).toHaveBeenCalledTimes(2);
  });

  test("dispatches one budget-limit wrap-up after a continuation-origin stream exhausts the budget", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Stop cleanly after budget",
      budgetCents: 100,
    });
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ kind: string | undefined; message: string }> = [];
    service.registerGoalContinuationConsumer(
      dispatcher,
      continuationBridge((input) => {
        executed.push({ kind: input.kind, message: input.message });
        return Promise.resolve(true);
      })
    );

    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 20_000,
    });
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);

    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ kind: GOAL_BUDGET_LIMIT_KIND });
    expect(executed[0]?.message).toContain("The budget for this goal has been exhausted.");
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: created.goalId,
    });
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_wrapup_fired",
      expect.objectContaining({ source: "stream_end_idle_dispatch", "cost-overshoot": "1-99" })
    );
  });

  test("model-created goals stay active and arm kickoff after a normal user turn", async () => {
    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-set-goal-request", "user", "Set yourself a goal and continue", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);
    const dispatcher = new IdleDispatcher();
    const executed: Array<Parameters<GoalContinuationRuntimeBridge["executeGoalContinuation"]>[0]> =
      [];
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(async (input) => {
        executed.push(input);
        const continuationAppend = await historyService.appendToHistory(
          workspaceId,
          createMuxMessage("model-created-goal-continuation", "user", input.message, {
            timestamp: Date.now(),
            kind: GOAL_CONTINUATION_KIND,
          })
        );
        expect(continuationAppend.success).toBe(true);
        return true;
      }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const goal = await setGoalOk(service, {
      workspaceId,
      objective: "Model-created auto goal",
      status: "active",
      initiator: "model",
    });
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(goal.status).toBe("active");
    expect(executed[0]?.kind).toBe(GOAL_CONTINUATION_KIND);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goal.goalId,
      status: "active",
    });
  });

  test("preserves model-created kickoff candidate when stream-end continuation is requested", async () => {
    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-set-goal-stream", "user", "Set yourself a goal and continue", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);
    let busy = true;
    const dispatcher = new IdleDispatcher();
    const executed: Array<Parameters<GoalContinuationRuntimeBridge["executeGoalContinuation"]>[0]> =
      [];
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(async (input) => {
        executed.push(input);
        const continuationAppend = await historyService.appendToHistory(
          workspaceId,
          createMuxMessage("preserved-kickoff-continuation", "user", input.message, {
            timestamp: Date.now(),
            kind: GOAL_CONTINUATION_KIND,
          })
        );
        expect(continuationAppend.success).toBe(true);
        return true;
      }),
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: busy }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({
      workspaceId,
      objective: "Queued model-created auto goal",
      status: "active",
      initiator: "model",
    });
    expect(queued.success).toBe(true);
    await extensionMetadata.setStreaming(workspaceId, false);
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(drained).toMatchObject({ status: "active" });

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: Date.now(),
    });
    busy = false;
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(executed[0]?.kind).toBe(GOAL_CONTINUATION_KIND);
    expect(executed[0]?.startStreamInBackground).toBe(true);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: drained?.goalId,
      status: "active",
    });
  });

  // Regression: bash-monitor wake turns used to disable freshly set goals.
  // The wake turn's synthetic user row lands before the kickoff continuation
  // row, so chat-tail reconciliation saw the pre-goal manual user row and
  // flipped the goal active→paused mid-window.
  test("getGoal keeps a kickoff-window goal active while a synthetic wake turn runs", async () => {
    await appendUserHistoryMessage(historyService, workspaceId, "Set yourself a goal and continue");
    const busy = true;
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(execute),
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: busy }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const goal = await setGoalOk(service, {
      workspaceId,
      objective: "Survive a wake turn",
      status: "active",
      initiator: "model",
    });
    // Simulate a bash-monitor wake turn starting before the kickoff fires: its
    // synthetic user row is appended and the wake turn's tool build reads the
    // goal while the kickoff candidate is still armed.
    await appendUserHistoryMessage(
      historyService,
      workspaceId,
      "A background bash monitor matched output.",
      { timestamp: Date.now(), synthetic: true, uiVisible: true }
    );

    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goal.goalId,
      status: "active",
    });
  });

  test("a wake turn ending during the kickoff window does not drop the kickoff candidate", async () => {
    await appendUserHistoryMessage(historyService, workspaceId, "Set yourself a goal and continue");
    let busy = true;
    const dispatcher = new IdleDispatcher();
    const executed: Array<Parameters<GoalContinuationRuntimeBridge["executeGoalContinuation"]>[0]> =
      [];
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(async (input) => {
        executed.push(input);
        await appendUserHistoryMessage(historyService, workspaceId, input.message, {
          timestamp: Date.now(),
          synthetic: true,
          uiVisible: true,
          kind: input.kind ?? GOAL_CONTINUATION_KIND,
        });
        return true;
      }),
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: busy }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const goal = await setGoalOk(service, {
      workspaceId,
      objective: "Survive a wake turn end",
      status: "active",
      initiator: "model",
    });
    await appendUserHistoryMessage(
      historyService,
      workspaceId,
      "A background bash monitor matched output.",
      { timestamp: Date.now(), synthetic: true, uiVisible: true }
    );
    // getGoal during the wake turn must not flip the goal, and the wake turn's
    // stream-end hook must keep the armed kickoff instead of downgrading or
    // deleting it.
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "active" });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: Date.now(),
    });

    busy = false;
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(executed[0]?.kind).toBe(GOAL_CONTINUATION_KIND);
    expect(executed[0]?.startStreamInBackground).toBe(true);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goal.goalId,
      status: "active",
    });
  });

  test("wake turn stream end preserves a paused kickoff candidate armed by resume", async () => {
    await setGoalOk(service, { workspaceId, objective: "Resume through a wake turn" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue goal", {
      timestamp: Date.now(),
      synthetic: true,
      uiVisible: true,
      kind: GOAL_CONTINUATION_KIND,
    });
    let busy = true;
    const dispatcher = new IdleDispatcher();
    const executed: Array<Parameters<GoalContinuationRuntimeBridge["executeGoalContinuation"]>[0]> =
      [];
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(async (input) => {
        executed.push(input);
        await appendUserHistoryMessage(historyService, workspaceId, input.message, {
          timestamp: Date.now(),
          synthetic: true,
          uiVisible: true,
          kind: input.kind ?? GOAL_CONTINUATION_KIND,
        });
        return true;
      }),
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: busy }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    // Explicit pause appends a goal-pause-boundary row and clears candidates;
    // resume then arms a kickoff whose continuation is deferred while busy. The
    // chat tail still ends at the boundary, so the persisted status flaps back
    // to paused — the armed kickoff is the durable carrier of resume intent.
    await setGoalOk(service, { workspaceId, status: "paused" });
    const resumed = await setGoalOk(service, { workspaceId, status: "active" });

    // A wake turn's stream end must not delete that paused kickoff candidate.
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: Date.now(),
    });

    busy = false;
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(executed[0]?.kind).toBe(GOAL_CONTINUATION_KIND);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: resumed.goalId,
      status: "active",
    });
  });

  test("strips set_goal capability from synthetic goal continuations", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Continue safely" });
    const dispatcher = new IdleDispatcher();
    const executed: Array<Parameters<GoalContinuationRuntimeBridge["executeGoalContinuation"]>[0]> =
      [];
    service.registerGoalContinuationConsumer(
      dispatcher,
      continuationBridge((input) => {
        executed.push(input);
        return Promise.resolve(true);
      })
    );

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec", allowAgentSetGoal: true },
      streamEndedAtMs: created.createdAtMs + 1,
    });
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);

    expect(executed).toHaveLength(1);
    expect(executed[0]?.kind).toBe(GOAL_CONTINUATION_KIND);
    expect(executed[0]?.options.allowAgentSetGoal).toBeUndefined();
  });

  test("replacing a goal while a stale continuation candidate exists arms the new goal", async () => {
    let busy = true;
    const dispatcher = new IdleDispatcher();
    const executed: string[] = [];
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge((input) => {
        executed.push(input.message);
        return Promise.resolve(true);
      }),
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: busy }),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const first = await setGoalOk(service, { workspaceId, objective: "First goal" });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: first.createdAtMs + 1,
    });
    await drainPendingDispatches();
    expect(executed).toEqual([]);

    busy = false;
    await setGoalOk(service, { workspaceId, objective: "Second goal" });
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain("Second goal");
  });

  test("rejects resuming budgeted goals when kickoff model has no pricing", async () => {
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(),
      getKickoffSendOptions: () =>
        Promise.resolve({ model: "custom:unpriced-model", agentId: "exec" }),
    });
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Paused budgeted goal",
      status: "paused",
      budgetCents: 500,
    });

    const result = await service.setGoal({
      workspaceId,
      objective: created.objective,
      status: "active",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatchObject({ type: "invalid_transition" });
    }
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "paused" });
  });

  test("explicit user resume clears the user-stop gate", async () => {
    // Regression: lastUserStopAtMsByWorkspace was never cleared on resume, so
    // once a user interrupted a stream after goal creation, all future
    // continuation candidates for that goal were rejected forever as
    // `user_stop` (the gate compares against the goal's createdAtMs, which
    // never changes when the goal is paused/resumed).
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Survive a user interruption",
    });
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    service.registerGoalContinuationConsumer(dispatcher, continuationBridge(execute));

    // User stops mid-stream after goal creation, then pauses.
    await service.recordUserStoppedStream(workspaceId, created.createdAtMs + 5_000);
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "paused",
      initiator: "user",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "paused" });

    // User resumes. The next continuation must fire — without the gate clear,
    // the dispatcher would silently reject all candidates with `user_stop`.
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "active",
      initiator: "user",
    });

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: created.createdAtMs + 10_000,
    });

    // No kickoff path here (no getKickoffSendOptions); only the stream-end
    // dispatch should fire — and it must, because the gate is cleared.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("explicit resume re-requests a gated same-goal continuation candidate", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Resume gated candidate",
    });
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(execute),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await service.recordUserStoppedStream(workspaceId, created.createdAtMs + 5_000);
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: created.createdAtMs + 6_000,
    });
    await drainPendingDispatches();
    expect(execute).not.toHaveBeenCalled();

    await setGoalOk(service, { workspaceId, objective: created.objective, status: "paused" });
    await setGoalOk(service, { workspaceId, objective: created.objective, status: "active" });
    await waitForCondition(() => execute.mock.calls.length > 0, { timeoutMs: 1_000 });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("startup recovery does not rearm an active goal after a persisted user stop", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Stay stopped after restart",
    });
    await service.recordUserStoppedStream(workspaceId, created.createdAtMs + 5_000);

    const restartedService = new WorkspaceGoalService(
      config,
      historyService,
      extensionMetadata,
      analytics
    );
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    restartedService.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(execute),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await restartedService.recoverPendingDispatchAfterRestart(workspaceId);
    await drainPendingDispatches();

    expect(execute).not.toHaveBeenCalled();
    expect(await restartedService.getGoal(workspaceId)).toMatchObject({
      status: "active",
      requireUserAcknowledgmentSinceMs: created.createdAtMs + 5_000,
    });
  });

  test("startup recovery does not arm a budgeted kickoff on an unpriced persisted model", async () => {
    // A goal created on a priced turn-model override persists without that
    // override; after a restart the kickoff falls back to the persisted model.
    // An unpriced one would be rejected by the send-time gate on every
    // dispatch, so recovery must leave the goal idle instead of arming it.
    await setGoalOk(service, {
      workspaceId,
      objective: "Created on a priced one-shot model",
      budgetCents: 500,
    });

    const restartedService = new WorkspaceGoalService(
      config,
      historyService,
      extensionMetadata,
      analytics
    );
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    restartedService.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(execute),
      getKickoffSendOptions: () =>
        Promise.resolve({ model: "custom:unpriced-model", agentId: "exec" }),
    });

    await restartedService.recoverPendingDispatchAfterRestart(workspaceId);
    await drainPendingDispatches();

    expect(execute).not.toHaveBeenCalled();
    expect(await restartedService.getGoal(workspaceId)).toMatchObject({ status: "active" });
  });

  test("rejected wrap-up send leaves the candidate retryable on the next dispatch", async () => {
    // Regression: tryMarkBudgetLimitInjected used to flip permanently before the
    // send. A transient sendMessage rejection (e.g. requireIdle race) then locked
    // the goal into budget_limited with no wrap-up. Now we mark only after a
    // successful send so a retry works.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Retry wrap-up after rejection",
      budgetCents: 100,
    });
    const dispatcher = new IdleDispatcher();
    // First call rejects (transient), second call accepts.
    let callCount = 0;
    const execute = mock(() => {
      callCount += 1;
      return Promise.resolve(callCount > 1);
    });
    service.registerGoalContinuationConsumer(dispatcher, continuationBridge(execute));

    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });

    // requestContinuationAfterStreamEnd internally triggers one dispatch (the
    // rejected one). The explicit second requestDispatch here simulates the
    // next stream-end and exercises the retry path.
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 20_000,
    });
    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: created.goalId,
    });
  });

  test("recoverPendingDispatchAfterRestart re-arms a stranded budget_limited wrap-up", async () => {
    // Regression: Simulates a process
    // restart by:
    //  1. Setting up a budgeted goal + recording a continuation-origin stream
    //     that exhausts the budget. This puts the goal in `budget_limited`
    //     with `budgetLimitInjectedForGoalId === null` AND an in-memory
    //     stamp/candidate.
    //  2. Throwing away the in-memory state by re-instantiating the service.
    //  3. Calling `recoverPendingDispatchAfterRestart` and checking that the
    //     wrap-up fires on the next idle dispatch.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Survive a restart with the wrap-up still owed",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: null,
    });

    // Simulate restart: throw away the in-memory state.
    const restartedService = new WorkspaceGoalService(
      config,
      historyService,
      extensionMetadata,
      analytics
    );
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ kind: string | undefined; message: string }> = [];
    restartedService.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        executed.push({ kind: input.kind, message: input.message });
        return Promise.resolve(true);
      },
      // Recovery synthesizes a candidate from scratch, which requires a
      // kickoff send-options provider to know how to dispatch the wrap-up.
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await restartedService.recoverPendingDispatchAfterRestart(workspaceId);
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });

    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ kind: GOAL_BUDGET_LIMIT_KIND });
    expect(await restartedService.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: created.goalId,
    });
  });

  test("getGoal normalizes legacy zero-budget goals on read", async () => {
    const legacy = await setGoalOk(service, {
      workspaceId,
      objective: "Legacy read normalization",
      budgetCents: 100,
    });
    await fs.writeFile(
      path.join(config.sessionsDir, workspaceId, "goal.json"),
      JSON.stringify({ ...legacy, status: "budget_limited", budgetCents: 0 })
    );

    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "active",
      budgetCents: null,
    });
  });

  test("recordUserStoppedStream drops queued goal mutations alongside continuation candidates", async () => {
    // Regression for pendingGoalMutations
    // were not cleared on user stop, so a setGoal racing with a stop would
    // leak into the NEXT stream's stream-end via applyPendingAfterStreamEnd
    // and bypass the lastUserStopAtMsByWorkspace gate. Auto-continuation
    // would then fire in a context the user did not intend.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Original objective",
    });

    const activityUpdates = captureGoalActivity(service);
    // Simulate a setGoal arriving mid-stream (this queues a pending
    // mutation in `pendingGoalMutations` because the workspace is streaming).
    // Override the private streaming check so setGoal hits the queueing path.
    const serviceAccess = service as unknown as {
      isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
    };
    const isStreamingOriginal = serviceAccess.isWorkspaceStreaming;
    serviceAccess.isWorkspaceStreaming = () => Promise.resolve(true);
    try {
      const queued = await service.setGoal({
        workspaceId,
        objective: "Should be dropped after user stop",
        expectedGoalId: created.goalId,
      });
      expect(queued.success).toBe(true);
      expect(activityUpdates.at(-1)).toMatchObject({
        goal: { objective: "Should be dropped after user stop", pendingPersistence: true },
      });
      expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
        goal: { goalId: created.goalId, objective: "Original objective" },
      });
    } finally {
      serviceAccess.isWorkspaceStreaming = isStreamingOriginal;
    }

    await service.recordUserStoppedStream(workspaceId, created.createdAtMs + 5_000);
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { goalId: created.goalId, objective: "Original objective" },
    });

    // applyPendingAfterStreamEnd should now be a no-op — the queued mutation
    // was discarded along with the continuation candidate.
    const applied = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(applied).toBeNull();
    expect(await service.getGoal(workspaceId)).toMatchObject({
      objective: "Original objective",
    });
  });

  test("serializes four active workspaces that all request goal continuations at once", async () => {
    const workspaceIds = [workspaceId, "goal-parent-2", "goal-parent-3", "goal-parent-4"];
    for (const id of workspaceIds.slice(1)) {
      await config.addWorkspace(PROJECT_PATH, {
        id,
        name: id,
        projectName: "mux-goal-service-test-project",
        projectPath: PROJECT_PATH,
        runtimeConfig: { type: "local" },
      });
    }
    for (const id of workspaceIds) {
      await setGoalOk(service, { workspaceId: id, objective: `Keep ${id} moving` });
    }

    const dispatcher = new IdleDispatcher();
    const events: string[] = [];
    const releaseByWorkspaceId = new Map<string, () => void>();
    const gateByWorkspaceId = new Map<string, Promise<void>>();
    let activeContinuations = 0;
    let maxActiveContinuations = 0;

    for (const id of workspaceIds) {
      gateByWorkspaceId.set(
        id,
        new Promise<void>((resolve) => {
          releaseByWorkspaceId.set(id, resolve);
        })
      );
    }

    service.registerGoalContinuationConsumer(
      dispatcher,
      continuationBridge(async (input) => {
        activeContinuations += 1;
        maxActiveContinuations = Math.max(maxActiveContinuations, activeContinuations);
        events.push(`start:${input.workspaceId}`);
        const gate = gateByWorkspaceId.get(input.workspaceId);
        if (!gate) {
          throw new Error(`Missing continuation gate for ${input.workspaceId}`);
        }
        await gate;
        events.push(`end:${input.workspaceId}`);
        activeContinuations -= 1;
        return true;
      })
    );

    const requests = workspaceIds.map((id) =>
      service.requestContinuationAfterStreamEnd({
        workspaceId: id,
        sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
        streamEndedAtMs: 10_000,
      })
    );
    await waitForCondition(() => events.some((event) => event.startsWith("start:")));
    // Drain so any spurious extra dispatches would surface before we assert
    // the global concurrency cap holds. There is no clean deterministic
    // signal here — we are asserting absence of events.
    await drainPendingDispatches();
    expect(events).toHaveLength(1);
    expect(maxActiveContinuations).toBe(1);

    let currentWorkspaceId = events[0]?.replace("start:", "");
    if (!currentWorkspaceId) {
      throw new Error("Expected a started continuation workspace");
    }
    for (let index = 0; index < workspaceIds.length; index += 1) {
      const releaseCurrent = releaseByWorkspaceId.get(currentWorkspaceId);
      if (!releaseCurrent) {
        throw new Error(`Missing continuation release for ${currentWorkspaceId}`);
      }
      releaseCurrent();
      await waitForCondition(() => events.includes(`end:${currentWorkspaceId}`));
      const expectedStartCount = index + 2;
      if (expectedStartCount <= workspaceIds.length) {
        await waitForCondition(
          () => events.filter((event) => event.startsWith("start:")).length === expectedStartCount
        );
        const nextWorkspaceId = events
          .filter((event) => event.startsWith("start:"))
          .at(-1)
          ?.replace("start:", "");
        if (!nextWorkspaceId) {
          throw new Error("Expected the next started continuation workspace");
        }
        currentWorkspaceId = nextWorkspaceId;
        expect(maxActiveContinuations).toBe(1);
      }
    }

    await Promise.all(requests);
    expect(events).toHaveLength(workspaceIds.length * 2);
    expect(
      events
        .filter((event) => event.startsWith("start:"))
        .map((event) => event.slice(6))
        .sort()
    ).toEqual([...workspaceIds].sort());
    expect(
      events
        .filter((event) => event.startsWith("end:"))
        .map((event) => event.slice(4))
        .sort()
    ).toEqual([...workspaceIds].sort());
    expect(maxActiveContinuations).toBe(1);
  });

  test("does not build stale continuation payloads after the goal changes", async () => {
    await setGoalOk(service, { workspaceId, objective: "Original" });
    const dispatcher = new IdleDispatcher();
    const requestDispatch = spyOn(dispatcher, "requestDispatch").mockResolvedValue();
    service.registerGoalContinuationConsumer(dispatcher, continuationBridge());

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 10_000,
    });
    expect(requestDispatch).toHaveBeenCalled();
    expect(await service.buildGoalContinuationPayload(workspaceId)).not.toBeNull();
    await setGoalOk(service, { workspaceId, objective: "Replacement" });

    expect(await service.buildGoalContinuationPayload(workspaceId)).toBeNull();
  });

  test("preserves goal id and accounting for same-objective set", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Same objective" });
    await fs.writeFile(
      path.join(config.sessionsDir, workspaceId, "goal.json"),
      JSON.stringify({ ...created, costCents: 123, turnsUsed: 4 })
    );

    const same = await setGoalOk(service, { workspaceId, objective: "  Same objective  " });

    expect(same.goalId).toBe(created.goalId);
    expect(same.costCents).toBe(123);
    expect(same.turnsUsed).toBe(4);
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_replaced",
      expect.objectContaining({ sameObjective: true })
    );
  });
});
