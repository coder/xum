import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { Input } from "@/browser/components/Input/Input";

// Text input primitive — mirrors the Input stories (field states + input types).
const Field = (props: { label: string; children: React.ReactNode }) => (
  <label className="flex w-72 flex-col gap-1.5">
    <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
      {props.label}
    </span>
    {props.children}
  </label>
);

export const Default = () => (
  <MuxPreviewShell>
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
  </MuxPreviewShell>
);

export const Types = () => (
  <MuxPreviewShell>
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
  </MuxPreviewShell>
);
