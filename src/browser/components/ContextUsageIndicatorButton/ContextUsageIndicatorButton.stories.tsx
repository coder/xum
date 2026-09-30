import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, waitFor, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { TOKEN_COMPONENT_COLORS, type TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import { ContextUsageIndicatorButton } from "./ContextUsageIndicatorButton.js";

const CONTEXT_METER_DATA: TokenMeterData = {
  totalTokens: 130000,
  maxTokens: 200000,
  totalPercentage: 65,
  segments: [
    {
      type: "input",
      tokens: 124000,
      percentage: 62,
      color: TOKEN_COMPONENT_COLORS.input,
    },
    {
      type: "output",
      tokens: 6000,
      percentage: 3,
      color: TOKEN_COMPONENT_COLORS.output,
    },
  ],
};

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Components/ContextUsageIndicator",
  component: ContextUsageIndicatorButton,
} satisfies Meta<typeof ContextUsageIndicatorButton>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Context meter with high usage and idle compaction enabled.
 * Shows the context usage indicator badge in the chat input area with the
 * hourglass badge indicating idle compaction is configured.
 */
export const ContextMeterWithIdleCompaction: Story = {
  args: {
    data: CONTEXT_METER_DATA,
    autoCompaction: { threshold: 80, setThreshold: fn() },
    idleCompaction: { hours: 4, setHours: fn() },
  },
  render: (args) => (
    <div className="bg-background flex min-h-[180px] items-end p-6">
      <ContextUsageIndicatorButton {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      canvas.getByRole("button", { name: /context usage/i });
    });
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the Context Meter with high usage (~65%) and idle compaction enabled (4h). " +
          "The meter displays an hourglass badge indicating idle compaction is configured.",
      },
    },
  },
};

/** The compact meter opens compaction settings directly without an overlapping hover tooltip. */
export const ContextMeterOpensSettings: Story = {
  args: {
    data: CONTEXT_METER_DATA,
    autoCompaction: { threshold: 80, setThreshold: fn() },
    idleCompaction: { hours: 4, setHours: fn() },
  },
  render: (args) => (
    <div className="bg-background flex min-h-[180px] items-end p-6">
      <ContextUsageIndicatorButton {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const contextButton = await canvas.findByRole("button", { name: /context usage/i });

    await userEvent.click(contextButton);

    await waitFor(() => {
      const dialog = within(document.body).getByRole("dialog");
      within(dialog).getByText("Compaction Settings");
    });
  },
};
