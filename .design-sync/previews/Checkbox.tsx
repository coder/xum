import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { Checkbox } from "@/browser/components/Checkbox/Checkbox";

// Checkbox primitive — mirrors the Checkbox "States" story (uncontrolled via
// defaultChecked so each resting state shows statically).
const Row = (props: { id: string; label: string; children: React.ReactNode }) => (
  <div className="flex items-center gap-2.5">
    {props.children}
    <label htmlFor={props.id} className="text-sm select-none">
      {props.label}
    </label>
  </div>
);

export const States = () => (
  <MuxPreviewShell>
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
  </MuxPreviewShell>
);
