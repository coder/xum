import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { GetGoalToolCall } from "@/browser/features/Tools/GetGoalToolCall";
import type { GoalRecordV1 } from "@/common/types/goal";

// A tool-call card rendered with inline mock args/result/status (mirrors the
// "Active (budgeted)" permutation from the GetGoalGallery story).
const NOW_MS = 1_750_000_000_000;
const TWO_MIN_AGO = NOW_MS - 2 * 60_000;

function goal(overrides: Partial<GoalRecordV1> = {}): GoalRecordV1 {
  return {
    version: 1,
    goalId: "11111111-1111-4111-8111-111111111111",
    objective:
      "Add a one-paragraph Goals section to the README explaining how the new /goal command works",
    status: "active",
    budgetCents: 100,
    turnCap: null,
    costCents: 25,
    turnsUsed: 2,
    attributedChildren: [],
    budgetLimitInjectedForGoalId: null,
    requireUserAcknowledgmentSinceMs: null,
    lastContinuationFiredAtMs: TWO_MIN_AGO,
    createdAtMs: TWO_MIN_AGO,
    updatedAtMs: NOW_MS,
    ...overrides,
  };
}

export const ActiveBudgeted = () => (
  <MuxPreviewShell>
    <div className="bg-background p-6">
      <div className="w-full max-w-2xl">
        <GetGoalToolCall args={{}} result={{ goal: goal() }} status="completed" />
      </div>
    </div>
  </MuxPreviewShell>
);

export const NoActiveGoal = () => (
  <MuxPreviewShell>
    <div className="bg-background p-6">
      <div className="w-full max-w-2xl">
        <GetGoalToolCall args={{}} result={{ goal: null }} status="completed" />
      </div>
    </div>
  </MuxPreviewShell>
);
