import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { Checkbox } from "./Checkbox.js";

// Checkbox primitive (Radix-backed). Rendered uncontrolled via defaultChecked so
// the design-system reference shows each resting state statically.
const meta: Meta<typeof Checkbox> = {
  ...lightweightMeta,
  title: "Components/Checkbox",
  component: Checkbox,
};

export default meta;

type Story = StoryObj<typeof meta>;

const Row = (props: { id: string; label: string; children: ReactNode }) => (
  <div className="flex items-center gap-2.5">
    {props.children}
    <label htmlFor={props.id} className="text-sm select-none">
      {props.label}
    </label>
  </div>
);

export const States: Story = {
  render: () => (
    <div className="bg-background text-foreground flex flex-col gap-4 p-8">
      <Row id="cb-unchecked" label="Unchecked">
        <Checkbox id="cb-unchecked" />
      </Row>
      <Row id="cb-checked" label="Checked">
        <Checkbox id="cb-checked" defaultChecked />
      </Row>
      <Row id="cb-disabled" label="Disabled">
        <Checkbox id="cb-disabled" disabled />
      </Row>
      <Row id="cb-disabled-checked" label="Disabled + checked">
        <Checkbox id="cb-disabled-checked" defaultChecked disabled />
      </Row>
    </div>
  ),
};
