import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { RosettaBanner } from "@/browser/components/RosettaBanner/RosettaBanner";

// RosettaBanner only renders when running under Rosetta — seed window.api so the
// banner is visible, and clear its dismissal flag (mirrors the story decorator).
function seedRosetta() {
  if (typeof localStorage !== "undefined") localStorage.removeItem("rosettaBannerDismissedAt");
  (window as unknown as { api: unknown }).api = {
    platform: "darwin",
    versions: { node: "20.0.0", chrome: "120.0.0", electron: "28.0.0" },
    isRosetta: true,
  };
}

export const BannerVisible = () => {
  seedRosetta();
  return (
    <MuxPreviewShell>
      <div className="bg-background p-6">
        <RosettaBanner />
      </div>
    </MuxPreviewShell>
  );
};
