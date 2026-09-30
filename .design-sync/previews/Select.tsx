import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { Select } from "@/browser/components/Select/Select";

// Select primitive — mirrors the Select "Default" story (closed triggers). The
// story's play-driven "Open" variant can't be reproduced in a static preview, so
// it is skipped in config.json (cfg.overrides.Select.skip).
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

export const Default = () => (
  <MuxPreviewShell>
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
  </MuxPreviewShell>
);
