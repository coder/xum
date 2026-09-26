import { describe, expect, mock, test } from "bun:test";
import type { APIClient } from "@/browser/contexts/API";
import type { GoalRecordV1 } from "@/common/types/goal";
import { setGoalWithConflictRetry } from "./setGoalWithConflictRetry";
import { createTestApiClient } from "@/browser/testUtils";

function makeGoal(overrides: Partial<GoalRecordV1> = {}): GoalRecordV1 {
  return {
    version: 1,
    goalId: "11111111-1111-4111-8111-111111111111",
    objective: "Test goal",
    status: "active",
    budgetCents: null,
    turnCap: null,
    costCents: 0,
    turnsUsed: 0,
    attributedChildren: [],
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    budgetLimitInjectedForGoalId: null,
    requireUserAcknowledgmentSinceMs: null,
    lastContinuationFiredAtMs: null,
    ...overrides,
  };
}

interface FakeApi {
  getGoal: ReturnType<typeof mock>;
  setGoal: ReturnType<typeof mock>;
}

function makeApi(getGoalImpl: () => unknown, setGoalImpl: () => unknown): APIClient {
  const fake: FakeApi = {
    getGoal: mock(getGoalImpl),
    setGoal: mock(setGoalImpl),
  };
  return createTestApiClient({ workspace: fake });
}

describe("setGoalWithConflictRetry", () => {
  test("first-try success returns the result without retrying", async () => {
    const goal = makeGoal();
    const api = makeApi(
      () => ({ goal }),
      () => ({ success: true, data: goal })
    );

    const result = await setGoalWithConflictRetry(api, "ws-1", { status: "paused" });

    expect(result).toEqual({ success: true, data: goal });
    // One getGoal + one setGoal — no second attempt.
    const ws = api.workspace as unknown as FakeApi;
    expect(ws.getGoal).toHaveBeenCalledTimes(1);
    expect(ws.setGoal).toHaveBeenCalledTimes(1);
    expect(ws.setGoal).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      status: "paused",
      expectedGoalId: goal.goalId,
    });
  });

  // Coder-agents-review P3 DEREM-38: pin the retry-once branch — the path
  // where the three pre-consolidation implementations diverged.
  test("conflict on first attempt re-fetches and retries with the fresh goalId", async () => {
    const stale = makeGoal({ goalId: "22222222-2222-4222-8222-222222222222" });
    const fresh = makeGoal({ goalId: "33333333-3333-4333-8333-333333333333" });
    let getGoalCall = 0;
    let setGoalCall = 0;
    const api = makeApi(
      () => ({ goal: getGoalCall++ === 0 ? stale : fresh }),
      () =>
        setGoalCall++ === 0
          ? {
              success: false,
              error: { type: "goal_conflict" as const, expectedGoalId: stale.goalId },
            }
          : { success: true, data: fresh }
    );

    const result = await setGoalWithConflictRetry(api, "ws-2", { status: "paused" });

    expect(result).toEqual({ success: true, data: fresh });
    const ws = api.workspace as unknown as FakeApi;
    expect(ws.getGoal).toHaveBeenCalledTimes(2);
    expect(ws.setGoal).toHaveBeenCalledTimes(2);
    expect(ws.setGoal.mock.calls[0]).toEqual([
      { workspaceId: "ws-2", status: "paused", expectedGoalId: stale.goalId },
    ]);
    expect(ws.setGoal.mock.calls[1]).toEqual([
      { workspaceId: "ws-2", status: "paused", expectedGoalId: fresh.goalId },
    ]);
  });

  test("passes expectedGoalId null when no goal exists yet", async () => {
    const api = makeApi(
      () => ({ goal: null }),
      () => ({ success: true, data: makeGoal() })
    );

    await setGoalWithConflictRetry(api, "ws-3", {
      objective: "First goal",
      budgetCents: 500,
    });

    const ws = api.workspace as unknown as FakeApi;
    expect(ws.setGoal).toHaveBeenCalledWith({
      workspaceId: "ws-3",
      objective: "First goal",
      budgetCents: 500,
      expectedGoalId: null,
    });
  });

  test("returns non-conflict failures without retrying", async () => {
    const api = makeApi(
      () => ({ goal: null }),
      () => ({
        success: false,
        error: { type: "invalid_transition" as const, message: "No goal" },
      })
    );

    const result = await setGoalWithConflictRetry(api, "ws-non-conflict", { status: "paused" });

    expect(result.success).toBe(false);
    const ws = api.workspace as unknown as FakeApi;
    expect(ws.getGoal).toHaveBeenCalledTimes(1);
    expect(ws.setGoal).toHaveBeenCalledTimes(1);
  });

  test("returns the second-attempt result even when retry also fails", async () => {
    const stale = makeGoal({ goalId: "44444444-4444-4444-8444-444444444444" });
    const fresh = makeGoal({ goalId: "55555555-5555-4555-8555-555555555555" });
    let getGoalCall = 0;
    const api = makeApi(
      () => ({ goal: getGoalCall++ === 0 ? stale : fresh }),
      () => ({
        success: false,
        error: {
          type: "goal_conflict" as const,
          expectedGoalId: stale.goalId,
          actualGoalId: fresh.goalId,
        },
      })
    );

    const result = await setGoalWithConflictRetry(api, "ws-4", { status: "paused" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatchObject({ type: "goal_conflict" });
    }
  });
});
