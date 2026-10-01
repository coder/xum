import { lightweightMeta } from "@/browser/stories/meta.js";
import type { ComponentType } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "@storybook/test";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { TasksSection } from "./TasksSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/TasksSection",
  component: TasksSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

function findAutoModelTriggers(canvasElement: HTMLElement): HTMLElement[] {
  return within(canvasElement)
    .getAllByRole("combobox")
    .filter((trigger) => trigger.textContent?.trim() === "Auto");
}

export const Tasks: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          taskSettings: { maxParallelAgentTasks: 2, maxTaskNestingDepth: 4 },
          // Reuse this story because the Pixel snapshot budget has no headroom.
          experiments: { [EXPERIMENT_IDS.AUTO_MODEL_ROUTING]: true },
          agentAiDefaults: {
            plan: { autoModelRouting: true, autoThinkingLevel: true },
            exec: { modelString: "anthropic:claude-opus-4-6", autoModelRouting: true },
          },
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
    await waitFor(async () => {
      await expect(findAutoModelTriggers(canvasElement)).toHaveLength(2);
    });

    await waitFor(() => {
      const inputs = canvas
        .queryAllByRole("spinbutton")
        .filter((input) => !input.getAttribute("aria-label")?.startsWith("Advisor"));
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

// The test runner ignores viewport globals, so the decorator enforces Pixel's 390px phone width.
const PHONE_VIEWPORT_WIDTH = 390;

function PhoneWidthDecorator(Story: ComponentType) {
  return (
    <div
      data-phone-frame
      style={{ width: `min(100vw, ${PHONE_VIEWPORT_WIDTH}px)`, overflow: "hidden" }}
    >
      <Story />
    </div>
  );
}

// The snapshot budget has no headroom, so play assertions enforce the narrow layout.
export const TasksPhone: Story = {
  render: Tasks.render,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { exclude: true } },
  decorators: [PhoneWidthDecorator],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: /UI agents/i });
    const frame = canvasElement.querySelector("[data-phone-frame]");
    if (!(frame instanceof HTMLElement)) throw new Error("Phone frame did not render");
    const frameRight = frame.getBoundingClientRect().right;
    await waitFor(async () => {
      const autoTriggers = findAutoModelTriggers(canvasElement);
      await expect(autoTriggers).toHaveLength(2);
      for (const trigger of autoTriggers) {
        const column = trigger.closest(".space-y-1");
        if (!(column instanceof HTMLElement)) throw new Error("Model column did not render");
        const reset = within(column).getByRole("button", { name: "Reset" });
        await expect(reset.getBoundingClientRect().right).toBeLessThanOrEqual(frameRight + 1);
      }
    });
  },
};
