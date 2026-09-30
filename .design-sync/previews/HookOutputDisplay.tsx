import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { HookOutputDisplay } from "@/browser/features/Tools/Shared/HookOutputDisplay";

// Subtle expandable hook-output display attached below tool results. Mirrors the
// story's primary "ToolHooksOutput" args (plain text output + duration).
export const ToolHooksOutput = () => (
  <MuxPreviewShell>
    <div className="bg-background p-6">
      <div className="w-full max-w-2xl">
        <HookOutputDisplay
          output={"prettier: reformatted src/app.ts\neslint: auto-fixed 2 issues"}
          durationMs={145}
        />
      </div>
    </div>
  </MuxPreviewShell>
);
