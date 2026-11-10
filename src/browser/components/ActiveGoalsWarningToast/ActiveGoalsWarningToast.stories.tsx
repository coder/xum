import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "storybook/test";
import { PIXEL_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";
import { ActiveGoalsWarningToast } from "./ActiveGoalsWarningToast";

const meta = {
  ...lightweightMeta,
  title: "App/Components/ActiveGoalsWarningToast",
  component: ActiveGoalsWarningToast,
  // The snapshot budget is full. .storybook/test-runner.ts checks that the toast keeps clear of a
  // side safe-area inset (the iPhone Duo cover display's status column).
  parameters: { ...lightweightMeta.parameters, layout: "fullscreen", pixel: PIXEL_DISABLED },
  args: { activeGoalCount: 4 },
} satisfies Meta<typeof ActiveGoalsWarningToast>;

export default meta;

export const AboveThreshold: StoryObj<typeof meta> = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("status");
  },
};
