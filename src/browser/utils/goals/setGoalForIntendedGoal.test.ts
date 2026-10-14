import { describe, expect, mock, test } from "bun:test";
import type { APIClient } from "@/browser/contexts/API";
import { toGoalSnapshot, type GoalRecordV1 } from "@/common/types/goal";
import { intendedGoalIdOf, setGoalForIntendedGoal } from "./setGoalForIntendedGoal";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";

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

type GoalResult = Awaited<ReturnType<APIClient["workspace"]["getGoal"]>>;
type SetGoalResult = Awaited<ReturnType<APIClient["workspace"]["setGoal"]>>;

function makeApi(getGoalImpl: () => GoalResult, setGoalImpl: () => SetGoalResult): APIClient {
  const workspace: TestApiOverrides<APIClient["workspace"]> = {
    getGoal: mock(() => Promise.resolve(getGoalImpl())),
    setGoal: mock(() => Promise.resolve(setGoalImpl())),
  };
  return createTestApiClient({ workspace });
}

describe("setGoalForIntendedGoal", () => {
  test("first-try success returns the result without retrying", async () => {
    const goal = makeGoal();
    const api = makeApi(
      () => ({ goal }),
      () => ({ success: true, data: goal })
    );

    const result = await setGoalForIntendedGoal(api, "ws-1", { status: "paused" });

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

  // #5461: a conflict means the goal was replaced. Re-reading and retrying would apply an edit
  // meant for the old goal to its replacement, so the conflict goes back to the caller.
  test("returns a conflict without retrying against the replacement goal", async () => {
    const stale = makeGoal({ goalId: "22222222-2222-4222-8222-222222222222" });
    const fresh = makeGoal({ goalId: "33333333-3333-4333-8333-333333333333" });
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

    const result = await setGoalForIntendedGoal(api, "ws-2", { status: "paused" });

    expect(result).toMatchObject({ success: false, error: { type: "goal_conflict" } });
    const ws = api.workspace as unknown as FakeApi;
    expect(ws.setGoal).toHaveBeenCalledTimes(1);
    expect(ws.setGoal.mock.calls[0]).toEqual([
      { workspaceId: "ws-2", status: "paused", expectedGoalId: stale.goalId },
    ]);
  });

  // #5461: the sidebar and palette pass the goal they displayed, so a goal replaced after the
  // user saw it is refused by the backend instead of being edited.
  test("targets the intended goal instead of the goal read at call time", async () => {
    const shown = makeGoal({ goalId: "66666666-6666-4666-8666-666666666666" });
    const replacement = makeGoal({ goalId: "77777777-7777-4777-8777-777777777777" });
    const api = makeApi(
      () => ({ goal: replacement }),
      () => ({ success: true, data: replacement })
    );

    await setGoalForIntendedGoal(api, "ws-5", { status: "paused" }, shown.goalId);

    const ws = api.workspace as unknown as FakeApi;
    expect(ws.getGoal).not.toHaveBeenCalled();
    expect(ws.setGoal.mock.calls).toEqual([
      [{ workspaceId: "ws-5", status: "paused", expectedGoalId: shown.goalId }],
    ]);
  });

  // A replacement still pending persistence has no durable id the backend can compare, so the
  // caller falls back to reading the current goal.
  test("intendedGoalIdOf reads the current goal for a goal pending persistence", () => {
    const goal = toGoalSnapshot(makeGoal());
    expect(intendedGoalIdOf(goal)).toBe(goal.goalId);
    expect(intendedGoalIdOf(null)).toBeNull();
    expect(intendedGoalIdOf({ ...goal, pendingPersistence: true })).toBeUndefined();
  });

  test("passes expectedGoalId null when no goal exists yet", async () => {
    const api = makeApi(
      () => ({ goal: null }),
      () => ({ success: true, data: makeGoal() })
    );

    await setGoalForIntendedGoal(api, "ws-3", {
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

    const result = await setGoalForIntendedGoal(api, "ws-non-conflict", { status: "paused" });

    expect(result.success).toBe(false);
    const ws = api.workspace as unknown as FakeApi;
    expect(ws.getGoal).toHaveBeenCalledTimes(1);
    expect(ws.setGoal).toHaveBeenCalledTimes(1);
  });
});
