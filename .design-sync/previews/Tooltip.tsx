import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { Button } from "@/browser/components/Button/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";

// Tooltip primitive — mirrors the Tooltip "Default" story. MuxPreviewShell
// already provides TooltipProvider. defaultOpen shows the surface; overlay/portal
// component → cardMode "single" in config.
export const Default = () => (
  <MuxPreviewShell>
    <div className="bg-background text-foreground flex min-h-[240px] items-center justify-center p-10">
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <Button variant="outline">Hover me</Button>
        </TooltipTrigger>
        <TooltipContent>Open the command palette (⌘⇧P)</TooltipContent>
      </Tooltip>
    </div>
  </MuxPreviewShell>
);
