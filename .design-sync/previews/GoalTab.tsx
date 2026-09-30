import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { GoalTab } from "@/browser/features/RightSidebar/GoalTab";
import type { GoalSnapshot } from "@/common/types/goal";

// Right-sidebar Goal tab. Mirrors the story's `States` gallery — the same
// component fed different `goal` snapshots (empty / active / paused / budget /
// complete). The read-only `States` variants pass NO `workspaceId`, so the
// board (`GoalBoardSections`, which fetches via API) never mounts; GoalTab only
// reads APIContext, available from the shell.
interface GalleryVariant {
  label: string;
  goal: GoalSnapshot | null;
  onCreate?: () => void;
}

const STATE_VARIANTS: GalleryVariant[] = [
  { label: "Empty · with create form", goal: null, onCreate: () => undefined },
  { label: "Empty · read-only", goal: null },
  {
    label: "Active",
    goal: {
      goalId: "11111111-1111-4111-8111-111111111111",
      status: "active",
      objective: "Ship the goal primitive vertical slice",
      budgetCents: null,
      costCents: 0,
      turnsUsed: 0,
      turnCap: null,
      startedAtMs: Date.now(),
    },
  },
  {
    label: "Active · with accounting",
    goal: {
      goalId: "44444444-4444-4444-8444-444444444444",
      status: "active",
      objective: "Ship the cost accumulator vertical slice",
      budgetCents: 500,
      costCents: 125,
      turnsUsed: 3,
      turnCap: 10,
      startedAtMs: Date.now() - 90_000,
    },
  },
  {
    label: "Paused",
    goal: {
      goalId: "22222222-2222-4222-8222-222222222222",
      status: "paused",
      objective: "Ship the goal primitive vertical slice",
      budgetCents: null,
      costCents: 125,
      turnsUsed: 3,
      turnCap: null,
      startedAtMs: Date.now(),
    },
  },
  {
    label: "Budget limited",
    goal: {
      goalId: "55555555-5555-4555-8555-555555555555",
      status: "budget_limited",
      objective: "Ship the budget-limited transition slice",
      budgetCents: 500,
      costCents: 525,
      turnsUsed: 4,
      turnCap: 10,
      startedAtMs: Date.now() - 120_000,
    },
  },
  {
    label: "Complete",
    goal: {
      goalId: "33333333-3333-4333-8333-333333333333",
      status: "complete",
      objective: "Ship the goal primitive vertical slice",
      budgetCents: null,
      costCents: 250,
      turnsUsed: 5,
      turnCap: null,
      completionSummary: "The lifecycle controls shipped with persistence and tests.",
      startedAtMs: Date.now(),
    },
  },
];

export const States = () => (
  <MuxPreviewShell>
    <div className="bg-background flex flex-col gap-6 p-3">
      {STATE_VARIANTS.map((variant) => (
        <section key={variant.label} className="flex flex-col gap-2">
          <div className="text-xs font-medium tracking-wide uppercase opacity-60">
            {variant.label}
          </div>
          <GoalTab goal={variant.goal} onCreate={variant.onCreate} />
        </section>
      ))}
    </div>
  </MuxPreviewShell>
);
