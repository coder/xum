import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { Button } from "@/browser/components/Button/Button";
import { ArrowRight, Plus, Trash2 } from "lucide-react";

// Action primitive — mirrors the Button stories (variants, sizes, icons,
// disabled). Renders the real Button directly; only theme + tooltip are needed.
const Section = (props: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-2">
    <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
      {props.label}
    </span>
    <div className="flex flex-wrap items-center gap-3">{props.children}</div>
  </div>
);

export const Variants = () => (
  <MuxPreviewShell>
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
  </MuxPreviewShell>
);

export const Sizes = () => (
  <MuxPreviewShell>
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
  </MuxPreviewShell>
);

export const WithIcons = () => (
  <MuxPreviewShell>
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
  </MuxPreviewShell>
);

export const Disabled = () => (
  <MuxPreviewShell>
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
  </MuxPreviewShell>
);
