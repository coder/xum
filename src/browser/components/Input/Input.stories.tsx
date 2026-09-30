import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { Input } from "./Input.js";

// Text input primitive. Design-system reference for the field states and input
// types the design agent reaches for in forms.
const meta: Meta<typeof Input> = {
  ...lightweightMeta,
  title: "Components/Input",
  component: Input,
};

export default meta;

type Story = StoryObj<typeof meta>;

const Field = (props: { label: string; children: ReactNode }) => (
  <label className="flex w-72 flex-col gap-1.5">
    <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
      {props.label}
    </span>
    {props.children}
  </label>
);

export const Default: Story = {
  render: () => (
    <div className="bg-background text-foreground flex flex-col gap-5 p-8">
      <Field label="Placeholder">
        <Input placeholder="my-team.example.com" />
      </Field>
      <Field label="With value">
        <Input defaultValue="feature/dark-mode" />
      </Field>
      <Field label="Disabled">
        <Input defaultValue="read-only value" disabled />
      </Field>
    </div>
  ),
};

export const Types: Story = {
  render: () => (
    <div className="bg-background text-foreground flex flex-col gap-5 p-8">
      <Field label="Text">
        <Input type="text" placeholder="Workspace name" />
      </Field>
      <Field label="Password">
        <Input type="password" defaultValue="hunter2" />
      </Field>
      <Field label="Number">
        <Input type="number" defaultValue={100} />
      </Field>
      <Field label="Search">
        <Input type="search" placeholder="Filter…" />
      </Field>
    </div>
  ),
};
