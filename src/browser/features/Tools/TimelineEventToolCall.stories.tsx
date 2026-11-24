import type { Meta, StoryObj } from "@storybook/react-vite";
import { TimelineEventToolCall } from "@/browser/features/Tools/TimelineEventToolCall";
import { PIXEL_DISABLED, lightweightMeta, StoryUiShell } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/TimelineEvent",
  component: TimelineEventToolCall,
  parameters: {
    ...lightweightMeta.parameters,
    // Excluded because the repo-wide Pixel snapshot budget is at its ceiling.
    pixel: PIXEL_DISABLED,
  },
  decorators: [
    (Story) => (
      <StoryUiShell>
        <div className="bg-background p-6">
          <div className="w-full max-w-2xl">
            <Story />
          </div>
        </div>
      </StoryUiShell>
    ),
  ],
} satisfies Meta<typeof TimelineEventToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

// Fixed instant so the preview's day header and time cell are deterministic.
const RECORDED_AT = new Date("2026-07-28T09:42:00").getTime();

/** milestone · work landed, PR opened (expanded to show the feed-row preview). */
export const MilestoneExpanded: Story = {
  args: {
    args: {
      description: "Landed the session-token refactor on main and opened PR #412 for review.",
      category: "milestone",
    },
    status: "completed",
    defaultExpanded: true,
    result: { success: true, recorded: true },
    toolCallTimestamp: RECORDED_AT,
  },
};

/** picked_up · external input pulled in — collapsed, the note itself is the summary. */
export const PickedUpCollapsed: Story = {
  args: {
    args: {
      description:
        "Picked up a review comment on PR #412 asking to gate the new token path behind a flag.",
      category: "picked_up",
    },
    status: "completed",
    result: { success: true, recorded: true },
    toolCallTimestamp: RECORDED_AT,
  },
};

/** decision · approach changed, with the why. */
export const DecisionExpanded: Story = {
  args: {
    args: {
      description:
        "Switched workspace status updates from polling to SSE — polling starved the renderer past ~200 workspaces.",
      category: "decision",
    },
    status: "completed",
    defaultExpanded: true,
    result: { success: true, recorded: true },
    toolCallTimestamp: RECORDED_AT,
  },
};

/** blocker · progress stopped. */
export const Blocker: Story = {
  args: {
    args: {
      description:
        "Blocked on staging migrations — the deploy role lacks ALTER TABLE and needs an infra approval.",
      category: "blocker",
    },
    status: "completed",
    result: { success: true, recorded: true },
    toolCallTimestamp: RECORDED_AT,
  },
};

/** handoff · work passed on. */
export const Handoff: Story = {
  args: {
    args: {
      description:
        "Handed flaky-test triage to the infra workspace with a repro script and the failing seeds.",
      category: "handoff",
    },
    status: "completed",
    result: { success: true, recorded: true },
    toolCallTimestamp: RECORDED_AT,
  },
};

/** No category · the chip and row badge fall back to the feed's generic "Agent". */
export const NoCategory: Story = {
  args: {
    args: {
      description: "Rebased the feature branch onto main after the v0.27.0 release tag.",
    },
    status: "completed",
    defaultExpanded: true,
    result: { success: true, recorded: true },
    toolCallTimestamp: RECORDED_AT,
  },
};

/**
 * Throttled · the tool succeeded but TimelineService dropped the note (duplicate or too
 * many in the window): amber "Not recorded" chip, and no feed-row preview.
 */
export const Throttled: Story = {
  args: {
    args: {
      description: "Landed the session-token refactor on main and opened PR #412 for review.",
      category: "milestone",
    },
    status: "completed",
    defaultExpanded: true,
    result: { success: true, recorded: false },
    toolCallTimestamp: RECORDED_AT,
  },
};

/** Mid-flight, before the result arrives. */
export const Executing: Story = {
  args: {
    args: {
      description: "Landed the session-token refactor on main and opened PR #412 for review.",
      category: "milestone",
    },
    status: "executing",
    defaultExpanded: true,
  },
};

/**
 * Error · the tool rejected the call (whitespace-only description passes the schema's min
 * length but fails the backend's trim check), so the header shows the explicit
 * empty-description placeholder instead of blank text.
 */
export const ErrorEmptyDescription: Story = {
  args: {
    args: { description: "   ", category: "milestone" },
    status: "failed",
    defaultExpanded: true,
    result: { success: false, error: "timeline_event requires a non-empty description" },
  },
};

/**
 * Narrow container · long unbroken token in the description. Pinned to a fixed ~375px
 * wrapper (the Storybook test-runner renders at desktop width and ignores viewport / Pixel
 * matrix variants, so the narrow case must be forced) with a play that fails if the header
 * or the feed-row preview overflows instead of truncating/clamping.
 */
export const NarrowContainer: Story = {
  args: {
    args: {
      description:
        "Deployed preview build https://ci.example.com/runs/0123456789abcdef0123456789abcdef/artifacts/mux-nightly-darwin-arm64.dmg for QA.",
      category: "milestone",
    },
    status: "completed",
    defaultExpanded: true,
    result: { success: true, recorded: true },
    toolCallTimestamp: RECORDED_AT,
  },
  decorators: [
    (Story) => (
      <div data-testid="timeline-event-card-container" className="w-[375px]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    if (!canvasElement.querySelector('[data-testid="timeline-row-preview"]')) {
      throw new Error("Timeline row preview did not render");
    }
    const container = canvasElement.querySelector('[data-testid="timeline-event-card-container"]');
    if (!(container instanceof HTMLElement)) {
      throw new Error("Timeline event story container not found");
    }
    // Let layout settle before measuring.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    if (container.scrollWidth > container.clientWidth + 1) {
      throw new Error(
        `Timeline event tool card overflowed its ${container.clientWidth}px container by ` +
          `${container.scrollWidth - container.clientWidth}px`
      );
    }
  },
};
