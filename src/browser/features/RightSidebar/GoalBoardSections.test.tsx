import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { installDom } from "../../../../tests/ui/dom";
import { APIContext, type APIClient } from "@/browser/contexts/API";
import { createTestApiClient } from "@/browser/testUtils";
import type { GoalBoardEntry, GoalBoardSnapshot, GoalRecordV1 } from "@/common/types/goal";
import { GoalBoardSections } from "./GoalBoardSections";

const WORKSPACE_ID = "ws-board";

let goalCounter = 0;
function goalRecord(overrides: Partial<GoalRecordV1> = {}): GoalRecordV1 {
  goalCounter += 1;
  return {
    version: 1,
    goalId: `00000000-0000-4000-8000-${String(goalCounter).padStart(12, "0")}`,
    objective: `Goal ${goalCounter}`,
    status: "active",
    budgetCents: null,
    turnCap: null,
    costCents: 0,
    turnsUsed: 0,
    attributedChildren: [],
    budgetLimitInjectedForGoalId: null,
    requireUserAcknowledgmentSinceMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function entry(section: GoalBoardEntry["section"], overrides: Partial<GoalRecordV1> = {}) {
  return { section, goal: goalRecord(overrides) } satisfies GoalBoardEntry;
}

type BoardMethod =
  | "archiveGoal"
  | "promoteUpcomingGoal"
  | "reviveArchivedGoal"
  | "updateUpcomingGoal";

interface BoardApiOptions {
  /** Reject the named procedure with this value (an Error or a non-Error). */
  failures?: Partial<Record<BoardMethod, unknown>>;
  /** Hold the named procedure until the test resolves it. */
  hold?: BoardMethod;
}

// One API double for the board procedures. Records each call's input in
// order, so tests check what reached the backend and what did not.
function createBoardApi(options: BoardApiOptions = {}) {
  const calls: Array<{ method: BoardMethod; input: unknown }> = [];
  let release: () => void = () => undefined;
  const respond = <T,>(method: BoardMethod, input: unknown, value: T): Promise<T> => {
    calls.push({ method, input });
    const failure = options.failures?.[method];
    if (failure !== undefined) return Promise.reject(failure as Error);
    if (options.hold === method) {
      return new Promise<T>((resolve) => {
        release = () => resolve(value);
      });
    }
    return Promise.resolve(value);
  };
  const api: APIClient = createTestApiClient({
    workspace: {
      archiveGoal: (input) => respond("archiveGoal", input, undefined),
      promoteUpcomingGoal: (input) => respond("promoteUpcomingGoal", input, null),
      reviveArchivedGoal: (input) => respond("reviveArchivedGoal", input, undefined),
      updateUpcomingGoal: (input) => respond("updateUpcomingGoal", input, null),
    },
  });
  return { api, calls, release: () => release() };
}

async function renderBoard(board: GoalBoardSnapshot, api: APIClient) {
  const onMutated = mock(() => undefined);
  const wrapper = (props: { children: ReactNode }) => (
    <APIContext.Provider
      value={{
        api,
        status: "connected",
        error: null,
        authenticate: () => undefined,
        retry: () => undefined,
      }}
    >
      {props.children}
    </APIContext.Provider>
  );
  const view = render(
    <GoalBoardSections workspaceId={WORKSPACE_ID} board={board} onMutated={onMutated} />,
    { wrapper }
  );
  // Let the goal-defaults load settle inside act, so its state update does not
  // land between assertions.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return { ...view, onMutated };
}

function sectionToggle(view: ReturnType<typeof render>, title: string): HTMLElement {
  const toggle = view
    .getAllByRole("button")
    .find(
      (button) =>
        button.getAttribute("aria-expanded") !== null && button.textContent?.includes(title)
    );
  if (!toggle) throw new Error(`no section toggle for ${title}`);
  return toggle;
}

// Role queries walk the whole accessibility tree and are slow in happy-dom, so
// read the alert banner by its role attribute directly.
function alertText(view: ReturnType<typeof render>): string | null {
  return view.container.querySelector('[role="alert"]')?.textContent ?? null;
}

function typeInto(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

describe("GoalBoardSections", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("an empty board shows only the queue button", async () => {
    const view = await renderBoard({ entries: [] }, createBoardApi().api);

    expect(view.getByLabelText("Queue another goal")).toBeTruthy();
    expect(view.queryByText("Upcoming")).toBeNull();
    expect(view.queryByText("Completed")).toBeNull();
  });

  test("upcoming starts open; completed and archived start closed and hide when empty", async () => {
    const board = {
      entries: [
        entry("upcoming", { objective: "Write docs", budgetCents: 500 }),
        entry("upcoming", { objective: "Fix flake" }),
        entry("complete", { objective: "Old work", costCents: 1234 }),
      ],
    };
    const view = await renderBoard(board, createBoardApi().api);

    expect(sectionToggle(view, "Upcoming").getAttribute("aria-expanded")).toBe("true");
    expect(sectionToggle(view, "Upcoming").textContent).toContain("(2)");
    expect(view.getByText("$5.00")).toBeTruthy();
    expect(view.getByText("no budget")).toBeTruthy();
    // No archived entries: the section is absent, not an empty shell.
    expect(view.queryByText("Archived")).toBeNull();

    const completed = sectionToggle(view, "Completed");
    expect(completed.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByText("Old work")).toBeNull();
    fireEvent.click(completed);
    expect(completed.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByText("Old work")).toBeTruthy();
    expect(view.getByText("$12.34")).toBeTruthy();
  });

  test("promote and remove send the goal id, then refresh the board", async () => {
    const upcoming = entry("upcoming", { objective: "Next up" });
    const { api, calls } = createBoardApi();
    const view = await renderBoard({ entries: [upcoming] }, api);

    fireEvent.click(view.getByLabelText("Promote Next up"));
    await waitFor(() => expect(view.onMutated).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByLabelText("Remove Next up"));
    await waitFor(() => expect(view.onMutated).toHaveBeenCalledTimes(2));

    const input = { workspaceId: WORKSPACE_ID, goalId: upcoming.goal.goalId };
    expect(calls).toEqual([
      { method: "promoteUpcomingGoal", input },
      { method: "archiveGoal", input },
    ]);
  });

  test("a rejected upcoming action shows the backend reason until the next success", async () => {
    const upcoming = entry("upcoming", { objective: "Next up" });
    const failing = createBoardApi({
      failures: { promoteUpcomingGoal: new Error("Goal is busy") },
    });
    const view = await renderBoard({ entries: [upcoming] }, failing.api);

    fireEvent.click(view.getByLabelText("Promote Next up"));
    await waitFor(() => expect(alertText(view)).toBe("Goal is busy"));
    expect(view.onMutated).not.toHaveBeenCalled();

    // Removing still works, and its success clears the stale error.
    fireEvent.click(view.getByLabelText("Remove Next up"));
    await waitFor(() => expect(alertText(view)).toBeNull());
    expect(view.onMutated).toHaveBeenCalledTimes(1);
  });

  test("a rejection without an Error message falls back to the action's own text", async () => {
    const upcoming = entry("upcoming", { objective: "Next up" });
    const failing = createBoardApi({ failures: { archiveGoal: "nope" } });
    const view = await renderBoard({ entries: [upcoming] }, failing.api);

    fireEvent.click(view.getByLabelText("Remove Next up"));
    await waitFor(() => expect(alertText(view)).toBe("Failed to remove goal."));
  });

  test("completed goals archive, and a failure shows its reason", async () => {
    const done = entry("complete", { objective: "Shipped" });
    const ok = createBoardApi();
    const view = await renderBoard({ entries: [done] }, ok.api);
    fireEvent.click(sectionToggle(view, "Completed"));

    fireEvent.click(view.getByLabelText("Archive Shipped"));
    await waitFor(() => expect(view.onMutated).toHaveBeenCalledTimes(1));
    expect(ok.calls).toEqual([
      {
        method: "archiveGoal",
        input: { workspaceId: WORKSPACE_ID, goalId: done.goal.goalId },
      },
    ]);
    view.unmount();

    const failing = createBoardApi({
      failures: { archiveGoal: new Error("Locked") },
    });
    const failedView = await renderBoard({ entries: [done] }, failing.api);
    fireEvent.click(sectionToggle(failedView, "Completed"));
    fireEvent.click(failedView.getByLabelText("Archive Shipped"));
    await waitFor(() => expect(alertText(failedView)).toBe("Locked"));
    expect(failedView.onMutated).not.toHaveBeenCalled();
  });

  test("archived goals revive, and a failure without a message shows the fallback", async () => {
    const stashed = entry("archived", { objective: "Parked" });
    const ok = createBoardApi();
    const view = await renderBoard({ entries: [stashed] }, ok.api);
    fireEvent.click(sectionToggle(view, "Archived"));

    fireEvent.click(view.getByLabelText("Revive Parked"));
    await waitFor(() => expect(view.onMutated).toHaveBeenCalledTimes(1));
    expect(ok.calls).toEqual([
      {
        method: "reviveArchivedGoal",
        input: { workspaceId: WORKSPACE_ID, goalId: stashed.goal.goalId },
      },
    ]);
    view.unmount();

    const failing = createBoardApi({
      failures: { reviveArchivedGoal: new Error("") },
    });
    const failedView = await renderBoard({ entries: [stashed] }, failing.api);
    fireEvent.click(sectionToggle(failedView, "Archived"));
    fireEvent.click(failedView.getByLabelText("Revive Parked"));
    await waitFor(() => expect(alertText(failedView)).toBe("Failed to revive."));
  });

  describe("upcoming row editor", () => {
    async function openEditor(goal: Partial<GoalRecordV1>, options?: BoardApiOptions) {
      const upcoming = entry("upcoming", { objective: "Draft plan", ...goal });
      const boardApi = createBoardApi(options);
      const view = await renderBoard({ entries: [upcoming] }, boardApi.api);
      fireEvent.click(view.getByLabelText(`Edit ${upcoming.goal.objective}`));
      return { ...boardApi, view, goalId: upcoming.goal.goalId };
    }

    test("prefills the goal's current values", async () => {
      const { view } = await openEditor({ budgetCents: 500, turnCap: 10 });

      expect((view.getByLabelText("Goal objective") as HTMLInputElement).value).toBe("Draft plan");
      expect((view.getByLabelText("Goal budget") as HTMLInputElement).value).toBe("5.00");
      expect((view.getByLabelText("Goal turn cap") as HTMLInputElement).value).toBe("10");
    });

    test("rejects invalid input locally without calling the backend", async () => {
      const { view, calls } = await openEditor({});
      const save = view.getByText("Save");

      typeInto(view.getByLabelText("Goal objective"), "   ");
      fireEvent.click(save);
      expect(alertText(view)).toBe("Goal objective is required.");

      typeInto(view.getByLabelText("Goal objective"), "Draft plan v2");
      typeInto(view.getByLabelText("Goal budget"), "five dollars");
      fireEvent.click(save);
      expect(alertText(view)).toContain("Enter a budget like $5");

      typeInto(view.getByLabelText("Goal budget"), "$5");
      typeInto(view.getByLabelText("Goal turn cap"), "1.5");
      fireEvent.click(save);
      expect(alertText(view)).toContain("whole-number turn cap");

      expect(calls).toHaveLength(0);
      expect(view.getByLabelText("Goal objective")).toBeTruthy();
    });

    test("closes without a backend call when nothing changed", async () => {
      const { view, calls } = await openEditor({ budgetCents: 500, turnCap: 10 });

      fireEvent.click(view.getByText("Save"));

      expect(calls).toHaveLength(0);
      expect(view.queryByLabelText("Goal objective")).toBeNull();
      expect(view.getByText("Draft plan")).toBeTruthy();
    });

    test("sends only the changed fields, with blank meaning no limit", async () => {
      const { view, calls, goalId } = await openEditor({
        budgetCents: 500,
        turnCap: 10,
      });

      typeInto(view.getByLabelText("Goal objective"), "  Final plan  ");
      typeInto(view.getByLabelText("Goal budget"), "");
      fireEvent.keyDown(view.getByLabelText("Goal objective"), {
        key: "Enter",
      });

      await waitFor(() => expect(view.onMutated).toHaveBeenCalledTimes(1));
      expect(calls).toEqual([
        {
          method: "updateUpcomingGoal",
          input: {
            workspaceId: WORKSPACE_ID,
            goalId,
            objective: "Final plan",
            budgetCents: null,
            turnCap: undefined,
          },
        },
      ]);
      expect(view.queryByLabelText("Goal objective")).toBeNull();
    });

    test("parses a new budget and turn cap", async () => {
      const { view, calls } = await openEditor({});

      typeInto(view.getByLabelText("Goal budget"), "$7.25");
      typeInto(view.getByLabelText("Goal turn cap"), "3");
      fireEvent.click(view.getByText("Save"));

      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0].input).toMatchObject({ budgetCents: 725, turnCap: 3 });
      expect((calls[0].input as { objective?: string }).objective).toBeUndefined();
    });

    test("disables Save while the update is in flight", async () => {
      const { view, release } = await openEditor({}, { hold: "updateUpcomingGoal" });

      typeInto(view.getByLabelText("Goal turn cap"), "4");
      fireEvent.click(view.getByText("Save"));

      const saving = await view.findByText("Saving…");
      expect((saving as HTMLButtonElement).disabled).toBe(true);
      release();
      // Compare a boolean: a failed retry that prints a happy-dom element is slow
      // enough to time the test out.
      await waitFor(() => expect(view.queryByLabelText("Goal objective") === null).toBe(true));
    });

    test("stays open and shows the backend reason when the update fails", async () => {
      const { view } = await openEditor(
        {},
        { failures: { updateUpcomingGoal: new Error("Too long") } }
      );

      typeInto(view.getByLabelText("Goal objective"), "A much longer plan");
      fireEvent.click(view.getByText("Save"));

      await waitFor(() => expect(alertText(view)).toBe("Too long"));
      expect((view.getByLabelText("Goal objective") as HTMLInputElement).value).toBe(
        "A much longer plan"
      );
      expect(view.onMutated).not.toHaveBeenCalled();
    });

    test("Escape and Cancel discard the edit", async () => {
      const { view, calls } = await openEditor({});

      typeInto(view.getByLabelText("Goal objective"), "Changed");
      fireEvent.keyDown(view.getByLabelText("Goal objective"), {
        key: "Escape",
      });
      expect(view.queryByLabelText("Goal objective")).toBeNull();
      expect(view.getByText("Draft plan")).toBeTruthy();

      fireEvent.click(view.getByLabelText("Edit Draft plan"));
      fireEvent.click(view.getByLabelText("Cancel goal edit"));
      expect(view.queryByLabelText("Goal objective")).toBeNull();
      expect(calls).toHaveLength(0);
    });
  });
});
