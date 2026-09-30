import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { Button } from "@/browser/components/Button/Button";
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/Popover/Popover";

// Popover primitive — mirrors the Popover "Default" story. defaultOpen shows the
// panel; overlay/portal component → cardMode "single" in config.
export const Default = () => (
  <MuxPreviewShell>
    <div className="bg-background text-foreground flex min-h-[320px] items-start justify-center p-10">
      <Popover defaultOpen>
        <PopoverTrigger asChild>
          <Button variant="outline">Workspace actions</Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="p-1">
          <div className="flex flex-col">
            <button className="hover:bg-hover rounded px-2.5 py-1.5 text-left text-sm">
              Open in editor
            </button>
            <button className="hover:bg-hover rounded px-2.5 py-1.5 text-left text-sm">
              Duplicate workspace
            </button>
            <button className="text-error hover:bg-hover rounded px-2.5 py-1.5 text-left text-sm">
              Archive
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  </MuxPreviewShell>
);
