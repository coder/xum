import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { TitleBar } from "@/browser/components/TitleBar/TitleBar";

// App title bar. The story renders the full app; here we render it directly.
// Mirrors the `MacOSDesktop` primary variant by seeding `window.api` (the
// presence of `getIsRosetta` flips `isDesktopMode()` → true, giving the
// traffic-light inset + stacked layout).
//
// RISK: TitleBar calls `useAboutDialog()`, which THROWS unless wrapped in
// `AboutDialogProvider`. That provider is not part of the preview harness and
// is not exported on `window.Mux`, so it cannot be supplied here. This preview
// will likely crash at render until the harness/barrel provides AboutDialog.
function seedDesktopApi() {
  (window as unknown as { api: unknown }).api = {
    platform: "darwin",
    versions: { node: "20.0.0", chrome: "120.0.0", electron: "28.0.0" },
    // Presence of this function triggers isDesktopMode() → true.
    getIsRosetta: () => Promise.resolve(false),
  };
}

export const MacOSDesktop = () => {
  seedDesktopApi();
  return (
    <MuxPreviewShell>
      <div className="bg-background">
        <TitleBar />
      </div>
    </MuxPreviewShell>
  );
};
