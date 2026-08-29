import { describe, expect, mock, test } from "bun:test";
import type { ORPCContext } from "@/node/orpc/context";
import { clearWorkspaceGoal, getWorkspaceGoal, setWorkspaceGoal } from "./workspaceOperations";

describe("workspace goal operations", () => {
  test("do not touch goal files for unknown workspaces", async () => {
    const getGoal = mock(() => Promise.resolve({ goalId: "should-not-read" }));
    const clearGoal = mock(() => Promise.resolve({ goalId: "should-not-clear" }));
    const setGoal = mock(() =>
      Promise.resolve({ success: true, data: { goalId: "should-not-set" } })
    );
    const context = {
      workspaceService: { getInfo: mock(() => Promise.resolve(null)) },
      workspaceGoalService: { getGoal, clearGoal, setGoal },
    } as unknown as ORPCContext;
    const workspaceId = "../../tmp/not-a-workspace";

    expect(await getWorkspaceGoal(context, workspaceId)).toEqual({ goal: null });
    expect(await clearWorkspaceGoal(context, workspaceId)).toEqual({ cleared: false });
    expect(await setWorkspaceGoal(context, { workspaceId, objective: "do not write" })).toEqual({
      success: false,
      error: { type: "invalid_transition", message: "Workspace not found." },
    });
    expect(getGoal).not.toHaveBeenCalled();
    expect(setGoal).not.toHaveBeenCalled();
    expect(clearGoal).not.toHaveBeenCalled();
  });
});
