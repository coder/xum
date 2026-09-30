import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { GeneralSection } from "@/browser/features/Settings/Sections/GeneralSection";

// A settings section: renders inside the shared provider shell (theme, API,
// experiments, policy, settings, tooltip). Reads its values from SettingsContext,
// which initializes from the empty mock client.
export const General = () => (
  <MuxPreviewShell>
    <div className="p-6 max-w-2xl">
      <GeneralSection />
    </div>
  </MuxPreviewShell>
);
