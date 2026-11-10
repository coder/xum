import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { ContextSwitchWarning as ContextSwitchWarningBanner } from "./ContextSwitchWarning.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Components/ContextSwitchWarning",
  component: ContextSwitchWarningBanner,
} satisfies Meta<typeof ContextSwitchWarningBanner>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Context switch warning banner - shows when switching to a model that can't fit current context.
 *
 * Scenario: Workspace has ~150K tokens of context. The user switches from Sonnet (200K+ limit)
 * to GPT-4o (128K limit). Since 150K > 90% of 128K, the warning banner appears.
 */
export const ContextSwitchWarning: Story = {
  args: {
    warning: {
      currentTokens: 150000,
      targetLimit: 128000,
      targetModel: "openai:gpt-4o",
      compactionModel: "anthropic:claude-sonnet-4-5",
      errorMessage: null,
    },
    onCompact: fn(),
    onDismiss: fn(),
  },
  render: (args) => (
    <div className="bg-background flex min-h-[180px] items-start p-4">
      <div className="w-full max-w-3xl">
        <ContextSwitchWarningBanner {...args} />
      </div>
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the context switch warning banner directly from warning props when current context exceeds the target model limit.",
      },
    },
  },
};
