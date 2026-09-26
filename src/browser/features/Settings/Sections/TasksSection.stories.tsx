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
          // Plan defaults to Auto for both dimensions; Exec routes the model with a concrete
          // fallback. Folded into this story to stay inside the Pixel snapshot budget.
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

// Pixel's named phone viewport width. The test-runner ignores viewport globals and plays at
// desktop size, so the decorator forces this width.
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

// Play-only narrow-layout contract: the snapshot budget has no headroom, and the forced
// phone width is asserted here instead of captured.
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
    // The Auto trigger and its Reset button must share the narrow card row without overflow.
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
