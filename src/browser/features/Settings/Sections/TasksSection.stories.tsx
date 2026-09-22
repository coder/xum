import type { ComponentType } from "react";
import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "@storybook/test";
import { TasksSection } from "./TasksSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/TasksSection",
  component: TasksSection,
  parameters: {
    ...lightweightMeta.parameters,
    viewport: {
      options: {
        // Mirrors Pixel's named `phone` viewport (390px) so local inspection and
        // CI snapshots exercise the same width.
        phone390: {
          name: "Phone 390",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const EVALUATION_PROVIDERS_CONFIG = {
  openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
  anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
};

/**
 * The Workflow Evaluation card with a persisted default. The route hint stays
 * hidden because OpenAI is configured directly; see `EvaluationModelPhone` for
 * the 390px layout contract.
 */
export const EvaluationModel: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          providersConfig: EVALUATION_PROVIDERS_CONFIG,
          evaluationDefaultModel: "openai:gpt-5",
        })
      }
    >
      <TasksSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = await canvas.findByRole("group", { name: "Evaluation model" });
    // The persisted default loads asynchronously; the Clear action proves it arrived.
    await expect(
      await within(card).findByRole("button", { name: "Clear evaluation model" })
    ).toBeVisible();
    await expect(within(card).queryByRole("note")).not.toBeInTheDocument();
  },
};

// The test-runner plays at desktop window size, so pin the width ourselves.
function PhoneWidthDecorator(Story: ComponentType) {
  return (
    <div style={{ width: 390, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

export const EvaluationModelPhone: Story = {
  ...EvaluationModel,
  decorators: [PhoneWidthDecorator],
  globals: { viewport: { value: "phone390", isRotated: false } },
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
  play: async ({ canvasElement, parameters, globals }) => {
    const canvas = within(canvasElement);
    await expect(parameters).toMatchObject({ pixel: { matrix: { viewports: ["phone"] } } });
    await expect(globals).toMatchObject({ viewport: { value: "phone390" } });
    const card = await canvas.findByRole("group", { name: "Evaluation model" });
    await expect(
      await within(card).findByRole("button", { name: "Clear evaluation model" })
    ).toBeVisible();
    // The selector and Clear action must share the 390px row without pushing off-screen.
    await expect(card.getBoundingClientRect().width).toBeLessThanOrEqual(390);
    await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  },
};

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
