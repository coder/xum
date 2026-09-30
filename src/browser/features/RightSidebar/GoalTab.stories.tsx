import type { Meta, StoryObj } from "@storybook/react-vite";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { PIXEL_DUAL_THEME } from "@/browser/stories/meta";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type {
  GoalBoardEntry,
  GoalBoardSnapshot,
  GoalRecordV1,
  GoalSnapshot,
} from "@/common/types/goal";

import { GoalTab } from "./GoalTab";

const meta: Meta<typeof GoalTab> = {
  title: "Features/RightSidebar/GoalTab",
  component: GoalTab,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

// ─────────────────────────────────────────────────────────────────────────
// States — composite gallery of the non-interactive GoalTab permutations.
// Each section is the same component fed a different `goal` arg (empty
// states, active, paused, budget-limited, complete, accounting/budget
// variants). Stacking them in one story keeps every visual permutation
// under review while collapsing eight near-duplicate snapshots into one.
// Interaction coverage continues to live in `GoalTab.test.tsx`; this
// gallery is intentionally `play`-free.
// ─────────────────────────────────────────────────────────────────────────

interface GalleryVariant {
  label: string;
  goal: GoalSnapshot | null;
  onCreate?: () => void;
}

const STATE_VARIANTS: GalleryVariant[] = [
  {
    // Empty-state surface that wires the in-tab create form. Mirrors the
    // slash-command `goal-set` shape (objective + optional budget + turn
    // cap). The `onCreate` mock keeps the form interactive in Storybook
    // without hitting a backend.
    label: "Empty · with create form",
    goal: null,
    onCreate: () => undefined,
  },
  {
    // Read-only fallback when no create callback is wired. Asserts the
    // empty-state gracefully degrades instead of crashing.
    label: "Empty · read-only",
    goal: null,
  },
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
  {
    label: "Active · with budget",
    goal: {
      goalId: "66666666-6666-4666-8666-666666666666",
      status: "active",
      objective: "Ship the goal budget UX iteration",
      budgetCents: 1000,
      costCents: 150,
      turnsUsed: 2,
      turnCap: null,
      startedAtMs: Date.now() - 30_000,
    },
  },
];

export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-6 p-3">
      {STATE_VARIANTS.map((variant) => (
        <section key={variant.label} className="flex flex-col gap-2">
          <div className="text-xs font-medium tracking-wide uppercase opacity-60">
            {variant.label}
          </div>
          <GoalTab goal={variant.goal} onCreate={variant.onCreate} />
        </section>
      ))}
    </div>
  ),
};

// ─────────────────────────────────────────────────────────────────────────
// CompleteWithBoard — full tab populated with Upcoming / Completed /
// Archived sections so the Archive row button (Completed → Archive),
// Revive (Archived), Promote / Remove / Edit (Upcoming), and the
// de-emphasized "Archive this goal" link on the active complete card all
// render in one screenshot. Required visual coverage for the row-action
// button restyle, which `GoalTab.test.tsx` cannot see (it mocks
// `GoalBoardSections` away).
//
// `GoalBoardSections` only mounts when `workspaceId` is provided, and
// the populated board reaches it through `useGoalBoard → api.workspace
// .getGoalBoard`. The decorator below mounts the story under an
// `APIProvider` backed by the mock client, with a seeded snapshot keyed
// by the story's workspaceId.
// ─────────────────────────────────────────────────────────────────────────

const STORY_WORKSPACE_ID = "ws-story-goaltab";
const NOW = Date.UTC(2026, 4, 20, 12, 0, 0);

function makeBoardGoal(
  overrides: Partial<GoalRecordV1> & Pick<GoalRecordV1, "goalId">
): GoalRecordV1 {
  return {
    version: 1,
    goalId: overrides.goalId,
    objective: overrides.objective ?? "Untitled goal",
    status: overrides.status ?? "paused",
    budgetCents: overrides.budgetCents ?? null,
    turnCap: overrides.turnCap ?? null,
    costCents: overrides.costCents ?? 0,
    turnsUsed: overrides.turnsUsed ?? 0,
    attributedChildren: overrides.attributedChildren ?? [],
    budgetLimitInjectedForGoalId: overrides.budgetLimitInjectedForGoalId ?? null,
    requireUserAcknowledgmentSinceMs: overrides.requireUserAcknowledgmentSinceMs ?? null,
    createdAtMs: overrides.createdAtMs ?? NOW,
    updatedAtMs: overrides.updatedAtMs ?? NOW,
    ...(overrides.completionSummary != null
      ? { completionSummary: overrides.completionSummary }
      : {}),
  };
}

function boardEntry(
  section: GoalBoardEntry["section"],
  goal: GoalRecordV1,
  endedAtMs?: number
): GoalBoardEntry {
  return endedAtMs != null ? { section, goal, endedAtMs } : { section, goal };
}

const FULL_BOARD: GoalBoardSnapshot = {
  entries: [
    boardEntry(
      "upcoming",
      makeBoardGoal({
        goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        objective: "Wire goal-board reorder to the keyboard",
        budgetCents: 500,
      })
    ),
    boardEntry(
      "upcoming",
      makeBoardGoal({
        goalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        objective: "Audit goal continuation telemetry",
      })
    ),
    boardEntry(
      "complete",
      makeBoardGoal({
        goalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        objective: "Ship the goal primitive vertical slice",
        status: "complete",
        budgetCents: 500,
        costCents: 412,
        turnsUsed: 8,
        completionSummary: "Lifecycle controls shipped with persistence and tests.",
      }),
      NOW - 60_000
    ),
    boardEntry(
      "archived",
      makeBoardGoal({
        goalId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        objective: "Sketch goal-board mobile layout",
      }),
      NOW - 3_600_000
    ),
  ],
};

export const CompleteWithBoard: Story = {
  args: {
    workspaceId: STORY_WORKSPACE_ID,
    goal: {
      goalId: "33333333-3333-4333-8333-333333333333",
      status: "complete",
      objective: "Ship the goal primitive vertical slice",
      budgetCents: null,
      costCents: 250,
      turnsUsed: 5,
      turnCap: null,
      completionSummary: "The lifecycle controls shipped with persistence and tests.",
      startedAtMs: NOW,
    },
  },
  // Dual-theme smoke coverage: the row-action button restyle should not
  // regress in either light or dark mode.
  parameters: {
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  decorators: [
    (Story) => (
      <APIProvider
        client={createMockORPCClient({
          goalBoardSnapshots: new Map([[STORY_WORKSPACE_ID, FULL_BOARD]]),
        })}
      >
        <TooltipProvider>
          <div className="max-w-md p-3">
            <Story />
          </div>
        </TooltipProvider>
      </APIProvider>
    ),
  ],
};
