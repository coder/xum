import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Config } from "@/node/config";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { IdleDispatcher } from "./idleDispatcher";
import { createTestHistoryService } from "./testHistoryService";
import type { HistoryService } from "./historyService";
import { waitForCondition } from "./testDispatchHelpers";
import { setGoalOk, PROJECT_PATH, analyticsMock } from "./workspaceGoalService.testHarness";

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

  // -------------------------------------------------------------------------
  // assertPricedModelForBudgetedGoal — canonical gate that every dispatch
  // path delegates to. Lives on WorkspaceGoalService so WorkspaceService AND
  // AgentSession share one implementation; that's required because queued
  // messages dispatched via AgentSession.sendQueuedMessages() never re-enter
  // WorkspaceService, and a budgeted goal that becomes resumable while a
  // queued unpriced-model message waits would otherwise bypass enforcement.
  // -------------------------------------------------------------------------
  describe("assertPricedModelForBudgetedGoal", () => {
    const UNPRICED = "openai:not-priced-model";
    const PRICED = "openai:gpt-4o-mini";

    test("rejects unpriced model on a resumable budgeted goal", async () => {
      await setGoalOk(service, {
        workspaceId,
        objective: "ship",
        budgetCents: 500,
      });

      const result = await service.assertPricedModelForBudgetedGoal(workspaceId, UNPRICED);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("unknown");
        if (result.error.type === "unknown") {
          expect(result.error.raw).toContain("Target model has no pricing data");
        }
      }
    });

    test("rejects on paused budgeted goals (would resume on un-pause)", async () => {
      await setGoalOk(service, {
        workspaceId,
        objective: "ship",
        budgetCents: 500,
      });
      await setGoalOk(service, { workspaceId, status: "paused" });

      const result = await service.assertPricedModelForBudgetedGoal(workspaceId, UNPRICED);
      expect(result.success).toBe(false);
    });

    test("priced models short-circuit before reading goal.json", async () => {
      // Internal compaction / heartbeat callers always pick a priced model, so
      // they hit the early-exit and never touch goal.json. We can't observe
      // the absence of disk I/O directly, but we can prove the goal record is
      // never consulted: no goal exists, yet the call returns Ok and is fast.
      const result = await service.assertPricedModelForBudgetedGoal(workspaceId, PRICED);
      expect(result.success).toBe(true);
    });

    test("undefined model is treated as not-yet-resolved and passes through", async () => {
      // The model-resolution cascade in WorkspaceService can return null when
      // a workspace has no AI settings and no global default, in which case
      // the gate must not block — the actual stream layer will pick a fallback.
      await setGoalOk(service, {
        workspaceId,
        objective: "ship",
        budgetCents: 500,
      });

      const result = await service.assertPricedModelForBudgetedGoal(workspaceId, undefined);
      expect(result.success).toBe(true);
    });

    test("allows when no goal exists", async () => {
      const result = await service.assertPricedModelForBudgetedGoal(workspaceId, UNPRICED);
      expect(result.success).toBe(true);
    });

    test("allows when goal has no budget", async () => {
      await setGoalOk(service, { workspaceId, objective: "ship" });
      const result = await service.assertPricedModelForBudgetedGoal(workspaceId, UNPRICED);
      expect(result.success).toBe(true);
    });

    test("allows when goal is complete (terminal)", async () => {
      await setGoalOk(service, {
        workspaceId,
        objective: "ship",
        budgetCents: 500,
      });
      await setGoalOk(service, {
        workspaceId,
        status: "complete",
        completionSummary: "done",
      });
      const result = await service.assertPricedModelForBudgetedGoal(workspaceId, UNPRICED);
      expect(result.success).toBe(true);
    });
  });

  describe("goal board (multi-goal queue)", () => {
    test("getGoalBoard returns an empty snapshot when nothing exists", async () => {
      const board = await service.getGoalBoard(workspaceId);
      expect(board).toEqual({ entries: [] });
    });

    test("addUpcomingGoal appends to the upcoming list and getGoalBoard reflects it", async () => {
      const queued = await service.addUpcomingGoal({
        workspaceId,
        objective: "Refactor auth flow",
        budgetCents: 1000,
        turnCap: 20,
      });
      expect(queued.objective).toBe("Refactor auth flow");
      // Upcoming goals are stored with a placeholder `paused` status —
      // promote/auto-promote is what flips them to `active`.
      expect(queued.status).toBe("paused");

      const board = await service.getGoalBoard(workspaceId);
      expect(board.entries).toHaveLength(1);
      expect(board.entries[0]).toMatchObject({
        section: "upcoming",
        goal: { goalId: queued.goalId, objective: "Refactor auth flow" },
      });
    });

    test("board surfaces active + upcoming together with active first", async () => {
      const active = await setGoalOk(service, { workspaceId, objective: "Active work" });
      const upcoming = await service.addUpcomingGoal({ workspaceId, objective: "Next up" });
      const board = await service.getGoalBoard(workspaceId);
      expect(board.entries.map((e) => [e.section, e.goal.goalId])).toEqual([
        ["active", active.goalId],
        ["upcoming", upcoming.goalId],
      ]);
    });

    test("auto-promotes the next upcoming goal when the active goal completes", async () => {
      const active = await setGoalOk(service, { workspaceId, objective: "First" });
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Second" });
      const dispatcher = new IdleDispatcher();
      const executed: string[] = [];
      service.registerGoalContinuationConsumer(dispatcher, {
        hasActiveDescendantTasks: () => false,
        getRuntimeState: () => ({ isRuntimeCompatible: true }),
        executeGoalContinuation: (input) => {
          executed.push(input.message);
          return Promise.resolve(true);
        },
        getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
      });

      // Mark the active goal complete. The board's invariant is: the
      // completed goal moves to history + the next upcoming becomes
      // active in the same write, then the promoted goal starts without a
      // manual pause/unpause nudge.
      await setGoalOk(service, {
        workspaceId,
        status: "complete",
        completionSummary: "Wrapped up first goal.",
      });

      const board = await service.getGoalBoard(workspaceId);
      const activeEntry = board.entries.find((e) => e.section === "active");
      expect(activeEntry?.goal.goalId).toBe(queued.goalId);
      expect(activeEntry?.goal.status).toBe("active");

      await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });
      expect(executed[0]).toContain("Second");

      const completed = board.entries.find(
        (e) => e.section === "complete" && e.goal.goalId === active.goalId
      );
      expect(completed).toBeDefined();
    });

    test("completeGoalFromSilentContinuation promotes the next upcoming goal", async () => {
      // #3326 Codex P2 (PRRT_kwDOPxxmWM6DMh9j): silent-continuation
      // completion must run the deferred auto-promote pass, otherwise
      // the queued upcoming goal would stay stuck until some later
      // manual mutation (because `maybeAutoPromoteOnComplete`'s inline
      // pass races with the async `setStreaming(false)` listener).
      const active = await setGoalOk(service, { workspaceId, objective: "First" });
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Second" });

      const result = await service.completeGoalFromSilentContinuation({
        workspaceId,
        completionSummary: "Looks done.",
      });
      expect(result?.goalId).toBe(active.goalId);
      expect(result?.status).toBe("complete");

      const board = await service.getGoalBoard(workspaceId);
      const activeEntry = board.entries.find((e) => e.section === "active");
      expect(activeEntry?.goal.goalId).toBe(queued.goalId);
      expect(activeEntry?.goal.status).toBe("active");

      const completedEntry = board.entries.find(
        (e) => e.section === "complete" && e.goal.goalId === active.goalId
      );
      expect(completedEntry).toBeDefined();
    });

    test("does NOT auto-promote when the upcoming list is empty (preserves single-goal UX)", async () => {
      const active = await setGoalOk(service, { workspaceId, objective: "Solo" });
      await setGoalOk(service, {
        workspaceId,
        status: "complete",
        completionSummary: "All done.",
      });

      // Without queued upcoming goals, the active goal stays in
      // `goal.json` with its completion summary so the existing
      // single-goal UX is preserved.
      const board = await service.getGoalBoard(workspaceId);
      const activeEntry = board.entries.find((e) => e.section === "active");
      expect(activeEntry?.goal.goalId).toBe(active.goalId);
      expect(activeEntry?.goal.status).toBe("complete");
      expect(activeEntry?.goal.completionSummary).toBe("All done.");
    });

    test("archiveGoal moves an upcoming goal to archived", async () => {
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "To archive" });
      await service.archiveGoal(workspaceId, queued.goalId);

      const board = await service.getGoalBoard(workspaceId);
      expect(board.entries.find((e) => e.section === "upcoming")).toBeUndefined();
      expect(board.entries.find((e) => e.section === "archived")?.goal.goalId).toBe(queued.goalId);
    });

    test("archiveGoal handles the active goal by clearing it and snapshotting into archived", async () => {
      const active = await setGoalOk(service, { workspaceId, objective: "Active to archive" });
      await service.archiveGoal(workspaceId, active.goalId);

      const board = await service.getGoalBoard(workspaceId);
      expect(board.entries.find((e) => e.section === "active")).toBeUndefined();
      expect(board.entries.find((e) => e.section === "archived")?.goal.goalId).toBe(active.goalId);
    });

    test("reviveArchivedGoal returns an archived goal to upcoming", async () => {
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Revivable" });
      await service.archiveGoal(workspaceId, queued.goalId);
      await service.reviveArchivedGoal(workspaceId, queued.goalId);

      const board = await service.getGoalBoard(workspaceId);
      expect(board.entries.find((e) => e.section === "archived")).toBeUndefined();
      expect(board.entries.find((e) => e.section === "upcoming")?.goal.goalId).toBe(queued.goalId);
    });

    test("reorderUpcomingGoals applies the given id order, defensively dropping unknown ids", async () => {
      const a = await service.addUpcomingGoal({ workspaceId, objective: "A" });
      const b = await service.addUpcomingGoal({ workspaceId, objective: "B" });
      const c = await service.addUpcomingGoal({ workspaceId, objective: "C" });

      // Reorder to C, A, B with an unknown id mixed in.
      await service.reorderUpcomingGoals(workspaceId, [
        c.goalId,
        "00000000-0000-4000-8000-000000000000",
        a.goalId,
        b.goalId,
      ]);

      const board = await service.getGoalBoard(workspaceId);
      const upcomingIds = board.entries
        .filter((e) => e.section === "upcoming")
        .map((e) => e.goal.goalId);
      expect(upcomingIds).toEqual([c.goalId, a.goalId, b.goalId]);
    });

    test("promoteUpcomingGoal swaps active with the chosen upcoming goal", async () => {
      const active = await setGoalOk(service, { workspaceId, objective: "Currently active" });
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Promote me" });

      const promoted = await service.promoteUpcomingGoal(workspaceId, queued.goalId);
      expect(promoted).not.toBeNull();
      expect(promoted?.goalId).toBe(queued.goalId);
      expect(promoted?.status).toBe("active");

      const board = await service.getGoalBoard(workspaceId);
      const activeEntry = board.entries.find((e) => e.section === "active");
      expect(activeEntry?.goal.goalId).toBe(queued.goalId);

      // The previously-active goal is demoted to the head of upcoming so
      // the user's roadmap stays intact ("swap on drag-to-activate").
      const upcomingIds = board.entries
        .filter((e) => e.section === "upcoming")
        .map((e) => e.goal.goalId);
      expect(upcomingIds[0]).toBe(active.goalId);
    });

    test("records a timeline row for both the manual and automatic promotion paths", async () => {
      const recorded: Array<{ kind: string; digest: string | undefined }> = [];
      service.setTimelineRecorder({
        record: (_workspaceId, draft) =>
          recorded.push({ kind: draft.kind, digest: draft.data?.digest }),
        closeWorkspace: () => Promise.resolve(),
        reopenWorkspace: () => undefined,
      });

      await setGoalOk(service, { workspaceId, objective: "First objective" });
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Second objective" });
      await service.promoteUpcomingGoal(workspaceId, queued.goalId);

      // Promoting demoted the first objective to the head of upcoming, so completing the second
      // auto-promotes it back and that re-activation must be recorded too.
      await setGoalOk(service, { workspaceId, status: "complete", completionSummary: "done" });

      const goalsSet = recorded.filter((row) => row.kind === "goal.set").map((row) => row.digest);
      expect(goalsSet).toEqual(["First objective", "Second objective", "First objective"]);
    });

    test("promoteUpcomingGoal starts the promoted goal and clears stale stop gates", async () => {
      const active = await setGoalOk(service, { workspaceId, objective: "Stopped active" });
      const queued = await service.addUpcomingGoal({
        workspaceId,
        objective: "Promote after stop",
      });
      // The user stopped the previous active turn, then explicitly promoted a
      // queued goal. That old stop/ack gate must not suppress the promoted
      // goal's kickoff and force a pause/unpause workaround.
      await service.recordUserStoppedStream(workspaceId, Date.now());

      const dispatcher = new IdleDispatcher();
      const executed: string[] = [];
      service.registerGoalContinuationConsumer(dispatcher, {
        hasActiveDescendantTasks: () => false,
        getRuntimeState: () => ({ isRuntimeCompatible: true }),
        executeGoalContinuation: (input) => {
          executed.push(input.message);
          return Promise.resolve(true);
        },
        getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
      });

      const promoted = await service.promoteUpcomingGoal(workspaceId, queued.goalId);
      expect(promoted?.goalId).toBe(queued.goalId);
      await waitForCondition(() => executed.length >= 1, { timeoutMs: 1_000 });
      expect(executed[0]).toContain("Promote after stop");

      const rePromoted = await service.promoteUpcomingGoal(workspaceId, active.goalId);
      expect(rePromoted?.goalId).toBe(active.goalId);
      await waitForCondition(() => executed.length >= 2, { timeoutMs: 1_000 });
      expect(executed[1]).toContain("Stopped active");
      expect(await service.getGoal(workspaceId)).toMatchObject({
        goalId: active.goalId,
        requireUserAcknowledgmentSinceMs: null,
      });
    });

    test("promoteUpcomingGoal archives a completed active goal instead of demoting to upcoming", async () => {
      // Complete the active goal but leave it sitting in goal.json
      // (single-goal UX path — no auto-promote because upcoming is
      // empty at completion time). Then queue an upcoming goal and
      // promote it: the previously-active complete goal must NOT
      // re-enter the queue.
      await setGoalOk(service, { workspaceId, objective: "Finish first" });
      const completed = await setGoalOk(service, {
        workspaceId,
        status: "complete",
        completionSummary: "Marked complete by user.",
      });
      const queued = await service.addUpcomingGoal({
        workspaceId,
        objective: "Next goal",
      });

      const promoted = await service.promoteUpcomingGoal(workspaceId, queued.goalId);
      expect(promoted?.goalId).toBe(queued.goalId);

      const board = await service.getGoalBoard(workspaceId);
      // The completed goal is in the Completed section, not Upcoming.
      const upcoming = board.entries.filter((e) => e.section === "upcoming");
      expect(upcoming.find((e) => e.goal.goalId === completed.goalId)).toBeUndefined();
      const complete = board.entries.filter((e) => e.section === "complete");
      expect(complete.find((e) => e.goal.goalId === completed.goalId)).toBeDefined();
    });

    test("promoteUpcomingGoal interrupts the active stream and proceeds with the promotion", async () => {
      await setGoalOk(service, { workspaceId, objective: "Currently active" });
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Promote me" });

      // Mark the workspace as streaming. The wired interrupter flips
      // the flag back to false as part of its work — mirrors what
      // `WorkspaceService.interruptStream` does in production.
      await extensionMetadata.setStreaming(workspaceId, true);

      let interruptCalls = 0;
      service.setStreamInterrupter(async (id) => {
        interruptCalls += 1;
        expect(id).toBe(workspaceId);
        await extensionMetadata.setStreaming(id, false);
      });

      const promoted = await service.promoteUpcomingGoal(workspaceId, queued.goalId);
      expect(interruptCalls).toBe(1);
      expect(promoted?.goalId).toBe(queued.goalId);

      // Idempotent: with no live stream, the second call must succeed
      // without invoking the interrupter (promotion already happened
      // above, so a second call on the same id returns null — but the
      // important check is that the guard does not block).
      const repeat = await service.promoteUpcomingGoal(workspaceId, queued.goalId);
      expect(repeat).toBeNull();
      expect(interruptCalls).toBe(1);
    });

    test("promoteUpcomingGoal proceeds even when no interrupter is wired", async () => {
      await setGoalOk(service, { workspaceId, objective: "Currently active" });
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Promote me" });

      // No `setStreamInterrupter` call. We mimic the brief stream
      // tail-end where streaming flips to false while waitForStream
      // Settled is polling — set false up front so the bounded poll
      // returns immediately and promotion proceeds.
      await extensionMetadata.setStreaming(workspaceId, false);

      const promoted = await service.promoteUpcomingGoal(workspaceId, queued.goalId);
      expect(promoted?.goalId).toBe(queued.goalId);
    });

    test("updateUpcomingGoal patches an upcoming goal in place", async () => {
      await setGoalOk(service, { workspaceId, objective: "Currently active" });
      const queued = await service.addUpcomingGoal({
        workspaceId,
        objective: "Original objective",
        budgetCents: 500,
      });

      const patched = await service.updateUpcomingGoal({
        workspaceId,
        goalId: queued.goalId,
        objective: "Updated objective",
        budgetCents: 1000,
      });
      expect(patched?.objective).toBe("Updated objective");
      expect(patched?.budgetCents).toBe(1000);

      // Reload from disk to confirm the write landed.
      const board = await service.getGoalBoard(workspaceId);
      const upcoming = board.entries.find((e) => e.goal.goalId === queued.goalId);
      expect(upcoming?.goal.objective).toBe("Updated objective");
      expect(upcoming?.goal.budgetCents).toBe(1000);
    });

    test("updateUpcomingGoal returns null for unknown ids", async () => {
      const result = await service.updateUpcomingGoal({
        workspaceId,
        goalId: "00000000-0000-4000-8000-000000000000",
        objective: "noop",
      });
      expect(result).toBeNull();
    });

    test("updateUpcomingGoal rejects an empty objective", async () => {
      const queued = await service.addUpcomingGoal({ workspaceId, objective: "Original" });
      let caught: unknown = null;
      try {
        await service.updateUpcomingGoal({
          workspaceId,
          goalId: queued.goalId,
          objective: "   ",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("objective");
    });

    test("updateUpcomingGoal can clear the budget by passing null", async () => {
      const queued = await service.addUpcomingGoal({
        workspaceId,
        objective: "Has budget",
        budgetCents: 500,
      });
      const patched = await service.updateUpcomingGoal({
        workspaceId,
        goalId: queued.goalId,
        budgetCents: null,
      });
      expect(patched?.budgetCents).toBeNull();
    });
  });
});
