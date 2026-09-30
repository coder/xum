import type { Meta, StoryObj } from "@storybook/react-vite";
import { HeartbeatToolCall } from "@/browser/features/Tools/HeartbeatToolCall";
import { PIXEL_DISABLED, lightweightMeta, StoryUiShell } from "@/browser/stories/meta.js";
import { HEARTBEAT_DEFAULT_MESSAGE_BODY } from "@/constants/heartbeat";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/Heartbeat",
  component: HeartbeatToolCall,
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
} satisfies Meta<typeof HeartbeatToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const TASK_PROMPT =
  "Check the CI run for the auth refactor. If it's green, open the PR; if it's red, " +
  "summarize the first failure and stop.";

/** set · enabled with a custom task prompt (expanded to show the full schedule). */
export const ScheduledEnabled: Story = {
  args: {
    args: {
      action: "set",
      enabled: true,
      intervalMs: 30 * 60_000,
      contextMode: "normal",
      message: TASK_PROMPT,
    },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      action: "set",
      configured: true,
      settings: {
        enabled: true,
        intervalMs: 30 * 60_000,
        contextMode: "normal",
        message: TASK_PROMPT,
      },
      summary: "Heartbeat is enabled for this workspace at 30 minutes.",
    },
  },
};

/**
 * set · multiline custom message with a long unbroken token. Pinned to a fixed ~360px
 * container (the Storybook test-runner renders at desktop width and ignores viewport /
 * Pixel matrix variants, so the narrow case must be forced with a wrapper) and a play that
 * fails if the prompt body's long URL/path overflows instead of wrapping.
 */
export const CustomMessageWrapping: Story = {
  args: {
    args: { action: "set", enabled: true, intervalMs: 1_800_000 },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      action: "set",
      configured: true,
      settings: {
        enabled: true,
        intervalMs: 1_800_000,
        contextMode: "normal",
        message:
          "Poll the deploy and report status.\n" +
          "Logs: https://ci.example.com/runs/0123456789abcdef0123456789abcdef/jobs/deploy-prod-us-east-1/raw?download=true\n" +
          "If it failed, summarize the first error and stop.",
      },
      summary: "Heartbeat is enabled for this workspace at 30 minutes.",
    },
  },
  decorators: [
    (Story) => (
      <div data-testid="heartbeat-card-container" className="w-[375px]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    // defaultExpanded renders the prompt synchronously; confirm the long token is present.
    if (!canvasElement.textContent?.includes("ci.example.com")) {
      throw new Error("Heartbeat check-in prompt did not render");
    }
    const container = canvasElement.querySelector('[data-testid="heartbeat-card-container"]');
    if (!(container instanceof HTMLElement)) {
      throw new Error("Heartbeat story container not found");
    }
    // Let layout settle before measuring.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    if (container.scrollWidth > container.clientWidth + 1) {
      throw new Error(
        `Heartbeat tool card overflowed its ${container.clientWidth}px container by ` +
          `${container.scrollWidth - container.clientWidth}px`
      );
    }
  },
};

/**
 * set · long cadence that compacts context first, with no custom message — exercises
 * the default-prompt fallback (the common case, since `message` is only stored when set).
 */
export const LongCadenceCompact: Story = {
  args: {
    args: { action: "set", enabled: true, intervalMs: 2 * 3_600_000, contextMode: "compact" },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      action: "set",
      configured: true,
      settings: { enabled: true, intervalMs: 2 * 3_600_000, contextMode: "compact" },
      summary: "Heartbeat is enabled for this workspace at 2 hours.",
    },
  },
};

/** get · reads current settings (reset context mode). */
export const ReadReset: Story = {
  args: {
    args: { action: "get" },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      action: "get",
      configured: true,
      settings: {
        enabled: true,
        intervalMs: 3_600_000,
        contextMode: "reset",
        message: HEARTBEAT_DEFAULT_MESSAGE_BODY,
      },
      summary: "Heartbeat is enabled for this workspace at 1 hour.",
    },
  },
};

/** set · kept but paused (amber). */
export const Paused: Story = {
  args: {
    args: { action: "set", enabled: false },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      action: "set",
      configured: true,
      settings: {
        enabled: false,
        intervalMs: 30 * 60_000,
        contextMode: "normal",
        message: HEARTBEAT_DEFAULT_MESSAGE_BODY,
      },
      summary: "Heartbeat is disabled for this workspace at 30 minutes.",
    },
  },
};

/** get · nothing configured for this workspace. */
export const ReadNotConfigured: Story = {
  args: {
    args: { action: "get" },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      action: "get",
      configured: false,
      settings: null,
      summary: "No heartbeat settings are configured for this workspace.",
    },
  },
};

/** unset · schedule removed. */
export const Cleared: Story = {
  args: {
    args: { action: "unset" },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      action: "unset",
      configured: false,
      settings: null,
      summary: "Heartbeat settings removed for this workspace.",
    },
  },
};

/** Mid-flight, before the result arrives. */
export const Executing: Story = {
  args: {
    args: { action: "set", enabled: true, intervalMs: 30 * 60_000 },
    status: "executing",
    defaultExpanded: true,
  },
};

/**
 * Error · a reachable failure result. Out-of-range intervals are rejected by the tool
 * schema before this card renders (they route to GenericToolCall), so the card's ErrorBox
 * is exercised here with valid args and a server-side failure.
 */
export const ErrorResult: Story = {
  args: {
    args: { action: "set", enabled: true, intervalMs: 30 * 60_000 },
    status: "failed",
    defaultExpanded: true,
    result: {
      success: false,
      error: "Failed to update heartbeat settings: workspace configuration is unavailable.",
    },
  },
};

/**
 * Interrupted before the result arrived (no settings/error/executing state). The expanded
 * body falls back to the requested args instead of going blank — the generic renderer used
 * to surface the args here.
 */
export const Interrupted: Story = {
  args: {
    args: {
      action: "set",
      enabled: true,
      intervalMs: 2 * 3_600_000,
      contextMode: "compact",
      message: "Watch the long-running migration and report when it finishes.",
    },
    status: "interrupted",
    defaultExpanded: true,
  },
};
