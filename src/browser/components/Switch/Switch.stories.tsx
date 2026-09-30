import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { Switch } from "./Switch.js";

// Toggle switch primitive. Switch is controlled, so each demo holds its own
// state and stays interactive in Storybook while the initial state is what the
// design-system capture records.
const meta: Meta<typeof Switch> = {
  ...lightweightMeta,
  title: "Components/Switch",
  component: Switch,
};

export default meta;

type Story = StoryObj<typeof meta>;

interface DemoProps {
  label: string;
  initial?: boolean;
  size?: "default" | "sm";
  disabled?: boolean;
}

const Toggle = (props: DemoProps) => {
  const [on, setOn] = React.useState(props.initial ?? false);
  return (
    <div className="flex items-center gap-2.5">
      <Switch
        checked={on}
        onCheckedChange={setOn}
        size={props.size}
        disabled={props.disabled}
        aria-label={props.label}
      />
      <span className="text-sm select-none">{props.label}</span>
    </div>
  );
};

export const States: Story = {
  render: () => (
    <div className="bg-background text-foreground flex flex-col gap-4 p-8">
      <Toggle label="Off" initial={false} />
      <Toggle label="On" initial={true} />
      <Toggle label="Small / off" size="sm" initial={false} />
      <Toggle label="Small / on" size="sm" initial={true} />
      <Toggle label="Disabled" disabled initial={false} />
      <Toggle label="Disabled / on" disabled initial={true} />
    </div>
  ),
};
