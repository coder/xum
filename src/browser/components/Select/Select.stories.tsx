import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { Select } from "./Select.js";

// Select primitive (Radix-backed dropdown with a simplified value/options API).
// Select is controlled, so each demo holds its own state.
const meta: Meta<typeof Select> = {
  ...lightweightMeta,
  title: "Components/Select",
  component: Select,
};

export default meta;

type Story = StoryObj<typeof meta>;

const MODELS = [
  { value: "opus", label: "Claude Opus 4.8" },
  { value: "sonnet", label: "Claude Sonnet 4.6" },
  { value: "haiku", label: "Claude Haiku 4.5" },
];

const SelectDemo = (props: { initial: string; disabled?: boolean }) => {
  const [value, setValue] = React.useState(props.initial);
  return (
    <Select
      value={value}
      options={MODELS}
      onChange={setValue}
      disabled={props.disabled}
      aria-label="Model"
      className="w-64"
    />
  );
};

export const Default: Story = {
  render: () => (
    <div className="bg-background text-foreground flex flex-col gap-5 p-8">
      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Default
        </span>
        <SelectDemo initial="opus" />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Disabled
        </span>
        <SelectDemo initial="sonnet" disabled />
      </div>
    </div>
  ),
};

// Opened via the trigger so the listbox is visible in the capture. Verifies the
// dropdown actually opens and renders its options.
export const Open: Story = {
  render: () => (
    <div className="bg-background text-foreground p-8">
      <SelectDemo initial="opus" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("combobox"));
    // Options render in a portal at the document root, not inside canvasElement.
    await within(document.body).findByText("Claude Sonnet 4.6");
  },
};
