import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { LegacyPlanImportNotice } from "@/browser/components/LegacyPlanImportBanner/LegacyPlanImportBanner";

// Mirrors the LegacyPlanImportBanner stories: an SSH workspace offered the explicit
// import of a plan left at the shared pre-#5174 path. "Import plan" calls the live API
// (the shell's mock client).
const noticeProps = {
  workspaceId: "older-ssh-row",
  legacyPlanPath: "/home/dev/.mux/plans/checkout-service/feature-login-x7k2.md",
  onSettled: () => undefined,
};

export const Default = () => (
  <MuxPreviewShell>
    <div className="bg-background text-foreground flex min-h-[160px] items-start p-4">
      <div className="w-full max-w-3xl">
        <LegacyPlanImportNotice {...noticeProps} />
      </div>
    </div>
  </MuxPreviewShell>
);

/** The long host path wraps instead of overflowing on a phone. */
export const Phone = () => (
  <MuxPreviewShell>
    <div className="bg-background text-foreground w-[375px] p-2">
      <LegacyPlanImportNotice {...noticeProps} />
    </div>
  </MuxPreviewShell>
);
