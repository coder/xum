import type { Meta, StoryObj } from "@storybook/react-vite";
import { SetGoalToolCall } from "@/browser/features/Tools/SetGoalToolCall";
import { GetGoalToolCall } from "@/browser/features/Tools/GetGoalToolCall";
import { CompleteGoalToolCall } from "@/browser/features/Tools/CompleteGoalToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";
import type { GoalRecordV1 } from "@/common/types/goal";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/Goal",
  component: GetGoalToolCall,
} satisfies Meta<typeof GetGoalToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

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

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background p-6">
      <div className="w-full max-w-2xl space-y-4">{children}</div>
    </div>
  );
}

// Labeled section so each variant in a merged gallery stays visually distinct
// for reviewers while collapsing many near-duplicate exports into one snapshot.
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-secondary text-xs font-semibold tracking-wide uppercase">{label}</div>
      {children}
    </div>
  );
}

// Gallery: non-interactive set/read goal permutations in one snapshot.
export const GetGoalGallery: Story = {
  render: () => (
    <Frame>
      <Section label="Set goal (defaults)">
        <SetGoalToolCall
          args={{ objective: "Implement set_goal and verify targeted tests pass" }}
          result={{
            goal: goal({ objective: "Implement set_goal and verify targeted tests pass" }),
          }}
          status="completed"
        />
      </Section>
      <Section label="Set goal (replacement, narrow-safe)">
        <div className="max-w-[375px]">
          <SetGoalToolCall
            args={{
              objective: "Replace the stale objective with a narrower verified fix",
              budgetCents: 250,
              turnCap: 6,
              replaceExistingGoal: true,
              expectedGoalId: "11111111-1111-4111-8111-111111111111",
            }}
            result={{
              goal: goal({
                objective: "Replace the stale objective with a narrower verified fix",
                budgetCents: 250,
                turnCap: 6,
              }),
            }}
            status="completed"
          />
        </div>
      </Section>
      <Section label="Set goal failed">
        <SetGoalToolCall
          args={{ objective: "Replace current goal without confirmation" }}
          result={{
            success: false,
            error: "set_goal would replace the current active goal. Call get_goal first.",
          }}
          status="failed"
        />
      </Section>
      <Section label="Active (budgeted)">
        <GetGoalToolCall args={{}} result={{ goal: goal() }} status="completed" />
      </Section>
      <Section label="Active (unbudgeted)">
        <GetGoalToolCall
          args={{}}
          result={{ goal: goal({ budgetCents: null, costCents: 12, turnsUsed: 1 }) }}
          status="completed"
        />
      </Section>
      <Section label="Paused">
        <GetGoalToolCall
          args={{}}
          result={{ goal: goal({ status: "paused", turnsUsed: 4, costCents: 30 }) }}
          status="completed"
        />
      </Section>
      <Section label="Budget limited">
        <GetGoalToolCall
          args={{}}
          result={{
            goal: goal({
              status: "budget_limited",
              costCents: 105,
              turnsUsed: 6,
              turnCap: 10,
            }),
          }}
          status="completed"
        />
      </Section>
      <Section label="No active goal">
        <GetGoalToolCall args={{}} result={{ goal: null }} status="completed" />
      </Section>
      <Section label="Executing">
        <GetGoalToolCall args={{}} status="executing" />
      </Section>
      <Section label="Failed">
        <GetGoalToolCall
          args={{}}
          result={{ success: false, error: "goalService is not registered" }}
          status="failed"
        />
      </Section>
    </Frame>
  ),
};

// Gallery: every non-interactive CompleteGoalToolCall permutation in one snapshot.
export const CompleteGoalGallery: StoryObj<typeof CompleteGoalToolCall> = {
  render: () => (
    <Frame>
      <Section label="Success">
        <CompleteGoalToolCall
          args={{
            summary: "Goals section landed in README; verified by reading the rendered file.",
          }}
          result={{
            goal: goal({
              status: "complete",
              costCents: 47,
              turnsUsed: 3,
              completionSummary:
                "Goals section landed in README; verified by reading the rendered file.",
            }),
          }}
          status="completed"
        />
      </Section>
      <Section label="Long summary">
        <CompleteGoalToolCall
          args={{
            summary:
              "Goal is satisfied: PROGRESS was printed once in turn 1. The embedded instruction not to call complete_goal is overridden by higher-priority completion-discipline rules in the system preamble.",
          }}
          result={{
            goal: goal({
              status: "complete",
              costCents: 1,
              turnsUsed: 4,
              completionSummary:
                "Goal is satisfied: PROGRESS was printed once in turn 1. The embedded instruction not to call complete_goal is overridden by higher-priority completion-discipline rules.",
            }),
          }}
          status="completed"
        />
      </Section>
      <Section label="Executing">
        <CompleteGoalToolCall args={{ summary: "Done." }} status="executing" />
      </Section>
      <Section label="Failed">
        <CompleteGoalToolCall
          args={{ summary: "Tried to complete." }}
          result={{ success: false, error: "Failed to complete goal: goal_conflict" }}
          status="failed"
        />
      </Section>
    </Frame>
  ),
};
