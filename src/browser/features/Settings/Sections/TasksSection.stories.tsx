import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor, within } from "@storybook/test";
import { TasksSection } from "./TasksSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/TasksSection",
  component: TasksSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Tasks: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          taskSettings: { maxParallelAgentTasks: 2, maxTaskNestingDepth: 4 },
        })
      }
    >
      <TasksSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/Max Parallel Agent Tasks/i);
    await canvas.findByText(/Max Task Nesting Depth/i);
    await canvas.findByText(/Agent Defaults/i);
    await canvas.findByRole("heading", { name: /UI agents/i });
    await canvas.findByRole("heading", { name: /Sub-agents/i });
    await canvas.findByRole("heading", { name: /Internal/i });

    await canvas.findAllByText(/^Plan$/i);
    await canvas.findAllByText(/^Exec$/i);
    await canvas.findByRole("group", { name: "Exec defaults" });
    await canvas.findAllByText(/^Explore$/i);
    await canvas.findAllByText(/^Compact$/i);

    await waitFor(() => {
      const inputs = canvas.queryAllByRole("spinbutton");
      if (inputs.length !== 2) {
        throw new Error(`Expected 2 task settings inputs, got ${inputs.length}`);
      }
      const maxParallelAgentTasks = (inputs[0] as HTMLInputElement).value;
      const maxTaskNestingDepth = (inputs[1] as HTMLInputElement).value;

      if (maxParallelAgentTasks !== "2") {
        throw new Error(
          `Expected maxParallelAgentTasks=2, got ${JSON.stringify(maxParallelAgentTasks)}`
        );
      }
      if (maxTaskNestingDepth !== "4") {
        throw new Error(
          `Expected maxTaskNestingDepth=4, got ${JSON.stringify(maxTaskNestingDepth)}`
        );
      }
    });
  },
};
