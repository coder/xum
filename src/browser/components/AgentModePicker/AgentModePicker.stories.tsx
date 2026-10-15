import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, waitFor, within } from "storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { MODEL_ABBREVIATION_EXAMPLES } from "@/common/constants/knownModels";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import {
  HelpIndicator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/browser/components/Tooltip/Tooltip";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Components/AgentModePicker",
  component: HelpIndicator,
} satisfies Meta<typeof HelpIndicator>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Mode selector with HelpIndicator tooltip - verifies props forwarding for Radix asChild.
 *
 * Regression test: HelpIndicator must spread rest props so TooltipTrigger's asChild
 * can attach event handlers for tooltip triggering.
 *
 * The fix ensures HelpIndicator forwards props (like onPointerEnter, onFocus) that
 * Radix TooltipTrigger needs when using asChild. Without the fix, the tooltip
 * would never appear on hover/focus.
 */
export const ModeHelpTooltip: Story = {
  render: () => (
    <div className="bg-background flex min-h-[180px] items-start p-6">
      <Tooltip>
        <TooltipTrigger asChild>
          <HelpIndicator data-testid="mode-help-indicator">?</HelpIndicator>
        </TooltipTrigger>
        <TooltipContent align="start" className="max-w-80 whitespace-normal">
          <strong>Click to edit</strong>
          <br />
          <strong>{formatKeybind(KEYBINDS.CYCLE_MODEL)}</strong> to cycle models
          <br />
          <br />
          <strong>Abbreviations:</strong>
          {MODEL_ABBREVIATION_EXAMPLES.map((ex) => (
            <span key={ex.abbrev}>
              <br />• <code>/model {ex.abbrev}</code> - {ex.displayName}
            </span>
          ))}
          <br />
          <br />
          <strong>Full format:</strong>
          <br />
          <code>/model provider:model-name</code>
          <br />
          (e.g., <code>/model anthropic:claude-sonnet-4-5</code>)
        </TooltipContent>
      </Tooltip>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const helpIndicator = await canvas.findByTestId("mode-help-indicator");

    await userEvent.hover(helpIndicator);

    await waitFor(
      () => {
        const tooltip = document.querySelector('[role="tooltip"]');
        if (!(tooltip instanceof HTMLElement)) {
          throw new Error("Tooltip not visible");
        }
        if (!tooltip.textContent?.includes("Click to edit")) {
          throw new Error("Expected model help tooltip content to be visible");
        }
      },
      { interval: 50, timeout: 5000 }
    );
  },

  parameters: {
    docs: {
      description: {
        story:
          "Verifies the model help tooltip trigger works and renders the shortcut/abbreviation guidance content.",
      },
    },
  },
};
