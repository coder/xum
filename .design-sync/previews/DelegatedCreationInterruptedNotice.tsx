import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { DelegatedCreationInterruptedNotice } from "@/browser/components/DelegatedCreationInterruptedBanner/DelegatedCreationInterruptedBanner";

// Mirrors the DelegatedCreationInterruptedBanner stories. The notice is presentational:
// confirm/removeWorkspace are injected (the story uses fn() mocks), and "Keep workspace"
// calls the live API, which the shell's mock client provides.
const noticeProps = {
  workspaceId: "orphan",
  workspace: { name: "fix-login-redirect" },
  confirm: () => Promise.resolve(false),
  removeWorkspace: () => Promise.resolve({ success: true }),
};

export const Default = () => (
  <MuxPreviewShell>
    <div className="bg-background text-foreground flex min-h-[180px] items-start p-4">
      <div className="w-full max-w-3xl">
        <DelegatedCreationInterruptedNotice {...noticeProps} />
      </div>
    </div>
  </MuxPreviewShell>
);

/** The actions wrap instead of overflowing on a phone. */
export const Phone = () => (
  <MuxPreviewShell>
    <div className="bg-background text-foreground w-[390px] p-2">
      <DelegatedCreationInterruptedNotice {...noticeProps} />
    </div>
  </MuxPreviewShell>
);
