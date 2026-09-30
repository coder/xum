import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { Button } from "./Button.js";

// Foundational action primitive. These stories double as the design-system
// reference: each renders the real Button so the variant/size vocabulary the
// design agent composes with is visible at a glance.
const meta: Meta<typeof Button> = {
  ...lightweightMeta,
  title: "Components/Button",
  component: Button,
};

export default meta;

type Story = StoryObj<typeof meta>;

const Section = (props: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-2">
    <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
      {props.label}
    </span>
    <div className="flex flex-wrap items-center gap-3">{props.children}</div>
  </div>
);

export const Variants: Story = {
  render: () => (
    <div className="bg-background text-foreground flex flex-col gap-6 p-8">
      <Section label="Variants">
        <Button variant="default">Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
      </Section>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="bg-background text-foreground flex flex-col gap-6 p-8">
      <Section label="Sizes">
        <Button size="xs">Extra small</Button>
        <Button size="sm">Small</Button>
        <Button size="default">Default</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" tooltip="Add">
          <Plus />
        </Button>
      </Section>
    </div>
  ),
};

export const WithIcons: Story = {
  render: () => (
    <div className="bg-background text-foreground flex flex-col gap-6 p-8">
      <Section label="With icons">
        <Button>
          <Plus />
          New workspace
        </Button>
        <Button variant="outline">
          Continue
          <ArrowRight />
        </Button>
        <Button variant="destructive">
          <Trash2 />
          Delete
        </Button>
        <Button variant="ghost" size="icon" tooltip="Delete">
          <Trash2 />
        </Button>
      </Section>
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="bg-background text-foreground flex flex-col gap-6 p-8">
      <Section label="Disabled">
        <Button disabled>Default</Button>
        <Button variant="outline" disabled>
          Outline
        </Button>
        <Button variant="destructive" disabled>
          Destructive
        </Button>
      </Section>
    </div>
  ),
};
