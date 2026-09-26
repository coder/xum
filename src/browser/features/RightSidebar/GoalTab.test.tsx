import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import type { GoalSnapshot } from "@/common/types/goal";
import * as RealGoalDefaultsModalModule from "@/browser/features/RightSidebar/GoalDefaultsModal";
import * as RealGoalBoardSectionsModule from "@/browser/features/RightSidebar/GoalBoardSections";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";

// No APIProvider and no contexts/API module mock: GoalTab, `useGoalDefaults` and
// `useGoalBoard` read `APIContext` directly and fall back to canonical defaults when it is
// null (the real context's default), matching Storybook rendering without a provider. A
// module mock here would leak process-wide into later-evaluated suites.

// Restore the real modules after this suite so the stubs below cannot leak into later files.
restoreModulesAfterSuite([
  ["@/browser/features/RightSidebar/GoalDefaultsModal", { ...RealGoalDefaultsModalModule }],
  ["@/browser/features/RightSidebar/GoalBoardSections", { ...RealGoalBoardSectionsModule }],
]);
// `GoalDefaultsModal` opens a Radix Dialog with portaled content that
// happy-dom can't render. The test never opens the modal — only that
// the trigger button exists — so a stub here keeps the form tree
// renderable without dragging the full Dialog primitive in.
void mock.module("@/browser/features/RightSidebar/GoalDefaultsModal", () => ({
  GoalDefaultsModal: () => null,
}));

// The goal-board sections subscribe to `workspace.getGoalBoard` via
// `useGoalBoard`. Existing tests render the GoalTab without an
// APIProvider, so the hook resolves to an empty board — but the
// component still mounts. Stub the renderer to keep the tree compact:
// these tests target the active-goal surface, not the board sections.
void mock.module("@/browser/features/RightSidebar/GoalBoardSections", () => ({
  GoalBoardSections: () => null,
}));

import { GoalTab } from "./GoalTab";

function goal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: "11111111-1111-4111-8111-111111111111",
    status: "active",
    objective: "Ship the goal lifecycle slice",
    budgetCents: null,
    costCents: 125,
    turnsUsed: 3,
    turnCap: null,
    startedAtMs: Date.now(),
    ...overrides,
  };
}

describe("GoalTab", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders lifecycle buttons based on status", () => {
    const { rerender, getByLabelText, queryByLabelText } = render(
      <GoalTab goal={goal()} onSetStatus={mock()} onClear={mock()} />
    );

    expect(getByLabelText("Pause goal")).toBeTruthy();
    expect(getByLabelText("Mark goal complete")).toBeTruthy();
    expect(queryByLabelText("Resume goal")).toBeNull();

    rerender(<GoalTab goal={goal({ status: "paused" })} onSetStatus={mock()} onClear={mock()} />);
    expect(getByLabelText("Resume goal")).toBeTruthy();
    expect(queryByLabelText("Pause goal")).toBeNull();
    expect(queryByLabelText("Mark goal complete")).toBeNull();

    rerender(
      <GoalTab
        goal={goal({ status: "complete", completionSummary: "All work is complete." })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );
    // Completed goals now expose a "Reopen" affordance so the user can
    // revive a goal the agent marked done too eagerly. Pause / Mark
    // complete remain hidden because the goal already left the active
    // lifecycle state.
    expect(queryByLabelText("Pause goal")).toBeNull();
    expect(getByLabelText("Reopen goal")).toBeTruthy();
    expect(queryByLabelText("Mark goal complete")).toBeNull();
    expect(getByLabelText("Completion summary").textContent).toContain("All work is complete.");

    // budget_limited must keep the manual
    // "Mark goal complete" button so the user can wrap up after exhausting
    // the budget. Pause is hidden because the goal is already paused-ish
    // (no auto-continuation), and Resume is hidden because the goal is
    // not in the `paused` state.
    rerender(
      <GoalTab
        goal={goal({ status: "budget_limited", budgetCents: 100, costCents: 100 })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );
    expect(getByLabelText("Mark goal complete")).toBeTruthy();
    expect(queryByLabelText("Pause goal")).toBeNull();
    expect(queryByLabelText("Resume goal")).toBeNull();
  });

  test("header tone differentiates running vs paused / budget-limited", () => {
    // Running goals get the success/green band; paused + budget_limited
    // share the warning/amber band so the user can spot a stalled
    // workspace at a glance instead of every active goal looking the
    // same. Complete falls back to the muted surface tone. The
    // `aria-label="Workspace goal"` section wraps the colored header,
    // so we look up the header element via its tone classes — that's
    // the actual user-visible cue and the contract we want to lock in.
    const { container, rerender } = render(
      <GoalTab goal={goal({ status: "active" })} onSetStatus={mock()} onClear={mock()} />
    );
    expect(container.querySelector("header")?.className).toContain("border-success");
    expect(container.querySelector("header")?.className).not.toContain("border-warning");

    rerender(<GoalTab goal={goal({ status: "paused" })} onSetStatus={mock()} onClear={mock()} />);
    // Paused: amber tone replaces the green band so the lifecycle is
    // legible without reading the badge text.
    expect(container.querySelector("header")?.className).toContain("border-warning");
    expect(container.querySelector("header")?.className).not.toContain("border-success");

    rerender(
      <GoalTab
        goal={goal({ status: "budget_limited", budgetCents: 100, costCents: 100 })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );
    // Budget-limited shares the amber tone with paused: both mean
    // "active but not auto-running".
    expect(container.querySelector("header")?.className).toContain("border-warning");
    expect(container.querySelector("header")?.className).not.toContain("border-success");
  });

  test("lifecycle action buttons surface their semantic icon", () => {
    // The lifecycle row (Pause / Resume / Reopen / Mark complete) now
    // carries semantic icons in addition to the text label. The icons
    // are inside the button DOM with `aria-hidden`, so we assert on the
    // button containing an SVG to guard against accidentally regressing
    // back to the text-only buttons. This is the user-visible cue that
    // distinguishes "Pause" from "Resume" in the pre-mouse-hover
    // glance, which is the whole point of this UX iteration.
    const { rerender, getByLabelText } = render(
      <GoalTab goal={goal({ status: "active" })} onSetStatus={mock()} onClear={mock()} />
    );
    expect(getByLabelText("Pause goal").querySelector("svg")).not.toBeNull();
    expect(getByLabelText("Mark goal complete").querySelector("svg")).not.toBeNull();

    rerender(<GoalTab goal={goal({ status: "paused" })} onSetStatus={mock()} onClear={mock()} />);
    // Resume is the success-tinted primary action when paused so the
    // user knows what to click next; the icon confirms the affordance.
    const resume = getByLabelText("Resume goal");
    expect(resume.querySelector("svg")).not.toBeNull();
    expect(resume.className).toContain("text-success");
  });

  test("renders accounting breakdown", () => {
    const startedAtMs = Date.now() - 90_000;
    const { getByText } = render(
      <GoalTab
        goal={goal({
          budgetCents: 500,
          costCents: 125,
          turnsUsed: 3,
          turnCap: 10,
          startedAtMs,
        })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );

    expect(getByText("$1.25")).toBeTruthy();
    expect(getByText("$5.00")).toBeTruthy();
    expect(getByText("$3.75")).toBeTruthy();
    expect(getByText("3 / 10")).toBeTruthy();
  });

  test("renders the turn cap alongside turns used even before the user opens the editor", () => {
    // Before this redesign, the Turns tile rendered just `turnsUsed`
    // when a cap was set elsewhere but the component thought it was
    // null — this exercises the explicit `null` case to lock in the
    // "no cap" indicator so the user can distinguish "no limit" from
    // "limit not yet hit".
    const { getByText, queryByText } = render(
      <GoalTab goal={goal({ turnsUsed: 3, turnCap: null })} onSetStatus={mock()} onClear={mock()} />
    );

    expect(getByText("3")).toBeTruthy();
    expect(getByText("no cap")).toBeTruthy();
    // The legacy combined "3 / X" rendering should not appear when no
    // cap is set; we should see the explicit "no cap" label instead.
    expect(queryByText(/3 \/ /)).toBeNull();
  });

  test("budget tile shows cost / cap / remaining together as a single composite tile", () => {
    // The redesign collapses the previous three standalone tiles
    // (Cost, Budget, Remaining) into one tile so the user reads
    // "spent / cap / remaining" without bouncing between corners of
    // the panel. The progress bar is exposed via role=progressbar so
    // screen readers and behavioral tests can target it.
    const { getByText, getByRole } = render(
      <GoalTab
        goal={goal({ budgetCents: 500, costCents: 125 })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );

    expect(getByText("$1.25")).toBeTruthy(); // cost
    expect(getByText("$5.00")).toBeTruthy(); // cap
    expect(getByText("$3.75")).toBeTruthy(); // remaining
    const bar = getByRole("progressbar", { name: "Budget used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("25"); // 125/500 → 25%
  });

  test("budget tile reports the actual overage when the goal is over budget", () => {
    // Critical: the pre-fix render clamped `remaining` to 0 and then
    // showed "$0.00 over" for any overspend, which made the tile lie
    // about how far past the cap the goal was. The over-budget branch
    // must surface the true magnitude (`costCents - budgetCents`).
    const { getByText } = render(
      <GoalTab
        goal={goal({ status: "budget_limited", budgetCents: 500, costCents: 525 })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );

    // 525 - 500 = 25¢ = $0.25 over.
    expect(getByText("$0.25")).toBeTruthy();
    expect(getByText(/over$/)).toBeTruthy();
  });

  test("tiles render exact-equality cap saturation as 'left', not 'over'", () => {
    // At exact `costCents === budgetCents` and `turnsUsed === turnCap`,
    // the goal has REACHED the limit but not exceeded it. Render "0
    // left" — both linguistically more accurate than "0 over" and the
    // expected behavior. The progress bar still uses the
    // at-or-over color so the user sees the visual at-limit signal.
    const { getAllByText, queryByText, getByRole } = render(
      <GoalTab
        goal={goal({
          status: "budget_limited",
          budgetCents: 500,
          costCents: 500,
          turnCap: 10,
          turnsUsed: 10,
        })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );

    // Both Budget and Turns tiles should land in the "left" branch.
    expect(getAllByText(/left$/).length).toBe(2);
    expect(queryByText(/over$/)).toBeNull();
    // Progress bar should be visually full at the cap.
    const bar = getByRole("progressbar", { name: "Budget used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
  });

  test("budget tile does not claim 'over' when budget_limited is caused by the turn cap", () => {
    // `budget_limited` is shared lifecycle for "hit budget OR hit turn
    // cap". The Budget tile must base its over/under-budget rendering
    // on the actual budget numbers, not the lifecycle status — else a
    // goal with $1.25 of $5.00 spent and 10/10 turns used would lie
    // about the money ("$0.00 over") simply because the turn cap was
    // hit.
    // `turnsUsed` is intentionally below `turnCap` so the Turns tile
    // can't independently render "over" — this isolates the assertion
    // to the Budget tile.
    const { getByText, queryByText } = render(
      <GoalTab
        goal={goal({
          status: "budget_limited",
          budgetCents: 500,
          costCents: 125,
          turnCap: 10,
          turnsUsed: 5,
        })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );

    // Budget should show under-budget figures, since $1.25 < $5.00.
    expect(getByText("$1.25")).toBeTruthy();
    expect(getByText("$3.75")).toBeTruthy();
    // Neither tile should render the "over" branch in this state.
    expect(queryByText(/over$/)).toBeNull();
  });

  test("turns tile reports the actual overage when turns exceed the cap", () => {
    // Same defect for the Turns tile: when `turnsUsed > turnCap`, the
    // pre-fix render clamped to `0 over`. Verify the true delta is
    // surfaced.
    const { getByText } = render(
      <GoalTab goal={goal({ turnsUsed: 12, turnCap: 10 })} onSetStatus={mock()} onClear={mock()} />
    );

    expect(getByText("12 / 10")).toBeTruthy();
    // 12 - 10 = 2 over.
    expect(getByText("2")).toBeTruthy();
    expect(getByText(/over$/)).toBeTruthy();
  });

  test("budget tile shows 'no budget' instead of a remaining figure when the cap is unset", () => {
    // When no budget is configured the tile is effectively a Cost
    // card. We must not render a misleading "$0.00 left" or a
    // progress bar.
    const { getByText, queryByRole } = render(
      <GoalTab
        goal={goal({ budgetCents: null, costCents: 125 })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );

    expect(getByText("$1.25")).toBeTruthy();
    expect(getByText("no budget")).toBeTruthy();
    expect(queryByRole("progressbar", { name: "Budget used" })).toBeNull();
  });

  test("renders pending goals read-only until they are saved", () => {
    const { queryByLabelText } = render(
      <GoalTab
        goal={goal({ pendingPersistence: true, budgetCents: 500, turnCap: 10 })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );

    expect(queryByLabelText("Pause goal")).toBeNull();
    expect(queryByLabelText("Mark goal complete")).toBeNull();
    expect(queryByLabelText("Clear goal")).toBeNull();
    expect(queryByLabelText("Edit goal budget")).toBeNull();
    expect(queryByLabelText("Edit goal turn cap")).toBeNull();
  });

  test("edits budget inline and restores focus", async () => {
    const onUpdateBudget = mock(() => Promise.resolve(undefined));
    const { getByLabelText, getByText } = render(
      <GoalTab
        goal={goal({ budgetCents: 500 })}
        onSetStatus={mock()}
        onClear={mock()}
        onUpdateBudget={onUpdateBudget}
      />
    );

    const opener = getByLabelText("Edit goal budget");
    opener.focus();
    fireEvent.click(opener);

    const input = getByLabelText("Goal budget amount");
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.input(input, { target: { value: "$7.50" } });
    fireEvent.click(getByText("Save budget"));

    await waitFor(() => expect(onUpdateBudget).toHaveBeenCalledWith(750));
    expect(document.activeElement).toBe(opener);
  });

  test("edits turn cap inline", async () => {
    const onUpdateTurnCap = mock(() => Promise.resolve(undefined));
    const { getByLabelText, getByText } = render(
      <GoalTab
        goal={goal({ turnCap: 10 })}
        onSetStatus={mock()}
        onClear={mock()}
        onUpdateTurnCap={onUpdateTurnCap}
      />
    );

    fireEvent.click(getByLabelText("Edit goal turn cap"));
    const input = getByLabelText("Goal turn cap");
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.input(input, { target: { value: "15" } });
    fireEvent.click(getByText("Save turn cap"));

    await waitFor(() => expect(onUpdateTurnCap).toHaveBeenCalledWith(15));
  });

  test("opens completion summary input, traps focus, submits, and restores focus", async () => {
    const onSetStatus = mock(() => Promise.resolve(undefined));
    const { getByLabelText, getByText, queryByLabelText } = render(
      <GoalTab goal={goal()} onSetStatus={onSetStatus} onClear={mock()} />
    );

    const opener = getByLabelText("Mark goal complete");
    opener.focus();
    fireEvent.click(opener);

    const input = getByLabelText("Goal completion summary");
    await waitFor(() => expect(document.activeElement).toBe(input));

    const cancel = getByText("Cancel");
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(input);

    (input as HTMLTextAreaElement).value = "Finished with tests passing.";
    fireEvent.input(input);
    fireEvent.click(getByText("Save summary"));

    await waitFor(() => {
      expect(onSetStatus).toHaveBeenCalledWith("complete", "Finished with tests passing.");
    });
    expect(queryByLabelText("Goal completion summary")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("edits goal objective in place and skips no-op edits", async () => {
    const onUpdateObjective = mock(() => Promise.resolve(undefined));
    const { getByLabelText, getByText } = render(
      <GoalTab
        goal={goal({ objective: "Initial objective" })}
        onSetStatus={mock()}
        onClear={mock()}
        onUpdateObjective={onUpdateObjective}
      />
    );

    const opener = getByLabelText("Edit goal objective");
    opener.focus();
    fireEvent.click(opener);

    const input = getByLabelText("Goal objective") as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(input));

    // No-op edit: same value should close the editor without calling the
    // update handler (avoids spurious lifecycle events / IPC churn).
    // The inline editor's save button text is "Save" now (was "Save
    // objective") since the button sits inside the header instead of a
    // standalone panel with its own label.
    fireEvent.click(getByText("Save"));

    // The inline editor replaces the Edit button in the header while
    // editing is open, so the original `opener` DOM node is detached on
    // close. Re-query for the freshly-mounted button and assert focus
    // landed there — that's the user-visible behavior the tab targets.
    await waitFor(() => {
      const restoredOpener = getByLabelText("Edit goal objective");
      expect(document.activeElement).toBe(restoredOpener);
    });
    expect(onUpdateObjective).not.toHaveBeenCalled();

    // Real edit propagates the trimmed objective.
    const reopener = getByLabelText("Edit goal objective");
    fireEvent.click(reopener);
    const reopenedInput = getByLabelText("Goal objective") as HTMLTextAreaElement;
    fireEvent.input(reopenedInput, { target: { value: "  Refined objective  " } });
    fireEvent.click(getByText("Save"));

    await waitFor(() => expect(onUpdateObjective).toHaveBeenCalledWith("Refined objective"));
  });

  test("keeps the objective editor available for completed goals (user revive path)", () => {
    const { getByLabelText } = render(
      <GoalTab
        goal={goal({ status: "complete", completionSummary: "Wrapped up." })}
        onSetStatus={mock()}
        onClear={mock()}
        onUpdateObjective={mock()}
      />
    );

    // Completed goals stay editable now — the user must be able to revive
    // (and possibly rename) a goal the agent declared done too eagerly.
    // The backend's `validateStatusTransition` only blocks non-user
    // initiators from leaving `complete`, so the UI keeps the affordance
    // visible. See workspaceGoalService.test.ts for the backend coverage.
    expect(getByLabelText("Edit goal objective")).toBeTruthy();
  });

  test("active goals expose a de-prominent Clear; completed goals promote Archive as primary", () => {
    const { getByLabelText, getByText, rerender, queryByText } = render(
      <GoalTab goal={goal()} onSetStatus={mock()} onClear={mock()} />
    );

    // Lifecycle-active goals: Clear is rendered as a small chip-style
    // row-action button — explicitly NOT the primary accent button used
    // by Save / Set goal / Archive-on-complete. Keeps a destructive
    // option visible without competing with Pause / Mark complete.
    const clearButton = getByLabelText("Clear goal");
    expect(clearButton.className).not.toContain("bg-accent");
    expect(getByText("Clear goal")).toBeTruthy();

    rerender(
      <GoalTab
        goal={goal({ status: "complete", completionSummary: "Wrapped up." })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );
    // Completed goals: Archive sits next to Reopen as the accent-colored
    // primary action ("file this away" is the obvious next step for a
    // finished goal). Reopen stays available as the secondary recovery
    // path with a neutral border style — the inverse of the previous
    // green Reopen / underlined Archive layout. The "Clear goal" wording
    // disappears entirely for completed goals; Archive routes through
    // the goal-board endpoint instead.
    const archiveButton = getByLabelText("Archive goal");
    expect(archiveButton.className).toContain("bg-accent");
    expect(getByText("Archive")).toBeTruthy();
    const reopenButton = getByLabelText("Reopen goal");
    expect(reopenButton.className).not.toContain("bg-accent");
    expect(getByText("Reopen")).toBeTruthy();
    expect(queryByText("Clear goal")).toBeNull();
  });

  test("empty state shows the create form when onCreate is provided", () => {
    const { getByLabelText, queryByText } = render(
      <GoalTab goal={null} onSetStatus={mock()} onClear={mock()} onCreate={mock()} />
    );

    expect(getByLabelText("Create workspace goal")).toBeTruthy();
    expect(getByLabelText("Goal objective")).toBeTruthy();
    expect(getByLabelText("Goal budget")).toBeTruthy();
    expect(getByLabelText("Goal turn cap")).toBeTruthy();
    expect(getByLabelText("Set goal")).toBeTruthy();
    // The "No goal is set" placeholder is replaced by the form when
    // creation is wired through — keep both states from leaking.
    expect(queryByText("No goal is set for this workspace.")).toBeNull();
  });

  test("create form submits objective with no budget or turn cap by default", async () => {
    const onCreate = mock(() => Promise.resolve(undefined));

    const { getByLabelText } = render(
      <GoalTab goal={null} onSetStatus={mock()} onClear={mock()} onCreate={onCreate} />
    );

    const objective = getByLabelText("Goal objective") as HTMLTextAreaElement;
    fireEvent.input(objective, { target: { value: "Ship the lifecycle slice" } });
    fireEvent.click(getByLabelText("Set goal"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(1);
    });
    // Slash-command parity: blank budget / turn cap fields stay omitted so
    // the parent can apply `goalDefaults` (matching the palette + `/goal`
    // paths). Explicit `null` here would be a "no budget" clear, which is
    // a different intent.
    expect(onCreate).toHaveBeenCalledWith({ objective: "Ship the lifecycle slice" });
  });

  test("create form parses budget and turn cap inputs", async () => {
    const onCreate = mock(() => Promise.resolve(undefined));

    const { getByLabelText } = render(
      <GoalTab goal={null} onSetStatus={mock()} onClear={mock()} onCreate={onCreate} />
    );

    fireEvent.input(getByLabelText("Goal objective") as HTMLTextAreaElement, {
      target: { value: "Spike on lifecycle events" },
    });
    fireEvent.input(getByLabelText("Goal budget") as HTMLInputElement, {
      target: { value: "$3.50" },
    });
    fireEvent.input(getByLabelText("Goal turn cap") as HTMLInputElement, {
      target: { value: "12" },
    });
    fireEvent.click(getByLabelText("Set goal"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(1);
    });
    expect(onCreate).toHaveBeenCalledWith({
      objective: "Spike on lifecycle events",
      budgetCents: 350,
      turnCap: 12,
    });
  });

  test("create form rejects empty objective without calling onCreate", async () => {
    const onCreate = mock(() => Promise.resolve(undefined));

    const { getByLabelText, getByRole } = render(
      <GoalTab goal={null} onSetStatus={mock()} onClear={mock()} onCreate={onCreate} />
    );

    // Submit with the objective left blank. The form must not invoke
    // onCreate, and it must surface a localized error rather than letting
    // the slash-command-equivalent payload (empty objective) hit the
    // backend with `Goal objective cannot be empty`.
    fireEvent.click(getByLabelText("Set goal"));

    await waitFor(() => {
      const alert = getByRole("alert");
      expect(alert.textContent).toContain("Goal objective is required");
    });
    expect(onCreate).not.toHaveBeenCalled();
  });

  test("create form rejects malformed budget without calling onCreate", async () => {
    const onCreate = mock(() => Promise.resolve(undefined));

    const { getByLabelText, getByRole } = render(
      <GoalTab goal={null} onSetStatus={mock()} onClear={mock()} onCreate={onCreate} />
    );

    fireEvent.input(getByLabelText("Goal objective") as HTMLTextAreaElement, {
      target: { value: "Valid objective" },
    });
    fireEvent.input(getByLabelText("Goal budget") as HTMLInputElement, {
      target: { value: "five bucks" },
    });
    fireEvent.click(getByLabelText("Set goal"));

    await waitFor(() => {
      const alert = getByRole("alert");
      expect(alert.textContent).toContain("$5");
    });
    expect(onCreate).not.toHaveBeenCalled();
  });
});
