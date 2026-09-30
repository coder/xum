import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentReportToolCall } from "@/browser/features/Tools/AgentReportToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/AgentReport",
  component: AgentReportToolCall,
} satisfies Meta<typeof AgentReportToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

/** agent_report tool call with an incremental markdown update */
export const AgentReportWithMarkdown: Story = {
  args: {
    args: {
      title: "Agent update",
      reportMarkdown: `## Summary

- Converted deleted app-level stories to lightweight component-level stories.
- Preserved representative task and bash mock states for visual regression coverage.

## Notes

<details>
<summary>Implementation details</summary>

- Stories now render direct tool components in a lightweight shell.
- No App-level wrappers are used.

</details>`,
    },
    result: { success: true },
    status: "completed",
  },
  render: (args) => (
    <div className="bg-background p-6">
      <div className="w-full max-w-2xl">
        <AgentReportToolCall {...args} />
      </div>
    </div>
  ),
};
