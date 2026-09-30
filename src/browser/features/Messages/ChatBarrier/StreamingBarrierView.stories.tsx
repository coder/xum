import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { StreamingBarrierView } from "./StreamingBarrierView";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Barriers/Streaming",
  component: StreamingBarrierView,
  render: (args) => (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div className="w-full max-w-3xl rounded-md border border-[var(--color-border-medium)] bg-[var(--color-card)] p-4">
        <StreamingBarrierView {...args} />
      </div>
    </div>
  ),
} satisfies Meta<typeof StreamingBarrierView>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Frontend display for the first-init SSH diagnostic state while the workspace
 * is still waiting for initialization to complete.
 */
export const WaitingForWorkspaceInitialization: Story = {
  args: {
    statusText: "Waiting for workspace initialization...",
    cancelText: "hit Esc to cancel",
    cancelShortcutText: "Esc",
    onCancel: fn(),
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the startup diagnostic users see when an SSH workspace is still in first-init setup and the frontend is waiting for workspace initialization.",
      },
    },
  },
};

/**
 * Frontend display for the later startup diagnostic state after runtime
 * readiness, when the request is still assembling tools.
 */
export const LoadingToolsDiagnostic: Story = {
  args: {
    statusText: "Loading tools...",
    cancelText: "hit Esc to cancel",
    cancelShortcutText: "Esc",
    onCancel: fn(),
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the more specific startup diagnostic text after runtime readiness succeeds but request startup is still blocked on tool assembly.",
      },
    },
  },
};

/**
 * Active streaming state with the token-stats slot revealed. The slot is reserved
 * (rendered but hidden) during startup, so the row geometry is identical across the
 * starting -> streaming transition — compare against the startup stories above to
 * confirm the status text and stop control do not shift when stats appear.
 */
export const Streaming: Story = {
  args: {
    statusText: "claude-opus-4 streaming...",
    cancelText: "hit Esc to cancel",
    cancelShortcutText: "Esc",
    onCancel: fn(),
    tokenCount: 12_840,
    tps: 73,
  },
};

/**
 * Idle turn that is waiting on an armed background bash monitor. There is no
 * active stream, so the stop control is replaced by an informational hint and
 * the token-stats slot is not rendered.
 */
export const WaitingOnBackgroundBashMonitor: Story = {
  args: {
    statusText: "Waiting on background bash monitor...",
    cancelText: "agent wakes on matching output",
    reserveStatsSlot: false,
    hideHintOnNarrow: true,
  },
};

/**
 * Same waiting state in a phone-width pane: the low-priority hint hides via the
 * barrier's own container query so the row cannot overflow horizontally. The
 * fixed-width wrapper drives the container query directly, so this contract
 * holds in the Storybook test-runner and Pixel without viewport variants.
 */
export const WaitingOnBackgroundBashMonitorNarrow: Story = {
  args: {
    statusText: "Waiting on background bash monitor...",
    cancelText: "agent wakes on matching output",
    reserveStatsSlot: false,
    hideHintOnNarrow: true,
  },
  render: (args) => (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div className="w-[320px] rounded-md border border-[var(--color-border-medium)] bg-[var(--color-card)] p-4">
        <StreamingBarrierView {...args} />
      </div>
    </div>
  ),
};
