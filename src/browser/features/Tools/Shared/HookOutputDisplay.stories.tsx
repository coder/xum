import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { HookOutputDisplay } from "./HookOutputDisplay";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/HookOutput",
  component: HookOutputDisplay,
} satisfies Meta<typeof HookOutputDisplay>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Tool hooks output - shows subtle expandable hook output on tool results */
export const ToolHooksOutput: Story = {
  args: {
    output: "prettier: reformatted src/app.ts\neslint: auto-fixed 2 issues",
    durationMs: 145,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows tool hook output as a subtle expandable section below tool results. " +
          "Hook output appears when a hook produced non-empty output.",
      },
    },
  },
};

/** Tool hooks output expanded - shows hook output in expanded state */
export const ToolHooksOutputExpanded: Story = {
  args: {
    output:
      "post-hook: git status check\nM  src/app.ts\nM  src/utils.ts\nM  src/config.ts\n\n3 files modified by formatter",
    durationMs: 85,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const hookButton = await canvas.findByText("hook output");
    await userEvent.click(hookButton);
    await canvas.findByText(/post-hook: git status check/);
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the hook output display in its expanded state, revealing the full hook output.",
      },
    },
  },
};
