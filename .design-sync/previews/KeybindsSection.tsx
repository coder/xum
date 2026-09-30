import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { KeybindsSection } from "@/browser/features/Settings/Sections/KeybindsSection";

// Keybinds reference: a pure presentational section that derives its rows from
// the KEYBINDS constant and reads only ExperimentsContext (from the shell) to
// gate the heartbeat row. No props or mock backend data needed (mirrors the
// story's `render: () => <KeybindsSection />`).
export const Keybinds = () => (
  <MuxPreviewShell>
    <div className="p-6 max-w-2xl">
      <KeybindsSection />
    </div>
  </MuxPreviewShell>
);
