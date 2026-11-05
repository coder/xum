import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { AboutDialog } from "@/browser/features/About/AboutDialog";
import { useAboutDialog } from "@/browser/contexts/AboutDialogContext";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { UpdateStatus } from "@/common/orpc/types";

// About dialog with server-update states — mirrors AboutDialog.stories.tsx ("Server updates").
// The story opens the dialog via a play() click on "Open About"; here a tiny child calls the
// harness's AboutDialogProvider open() on mount so the modal shows statically. Overlay → "single".
// RestartingClosesDialog is skipped: the dialog closes itself as soon as that status lands.

function OpenOnMount() {
  const about = useAboutDialog();
  React.useEffect(() => {
    about.open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

const Shell = (props: { status: UpdateStatus }) => (
  <MuxPreviewShell
    client={createMockORPCClient({
      updateStatus: props.status,
      updateChannel: "nightly",
      updateChannels: ["stable", "nightly", "npm"],
    })}
  >
    <div className="bg-background text-foreground min-h-screen">
      <OpenOnMount />
      <AboutDialog />
    </div>
  </MuxPreviewShell>
);

export const Unsupported = () => (
  <Shell
    status={{
      type: "unsupported",
      reason: "Server updates require a supervisor configured to restart after exit",
    }}
  />
);

export const Downloading = () => <Shell status={{ type: "downloading", percent: null }} />;

export const BlockedPhone = () => (
  <Shell
    status={{
      type: "install-blocked",
      info: { version: "0.28.4-next.123.g123456789" },
      blockers: [
        { kind: "pending-turns", count: 2 },
        { kind: "terminals", count: 1 },
        {
          kind: "held-inputs",
          count: 4,
          workspaceNames: [
            "Archived: migrate the storage layer to…",
            "Fix settings validation",
            "Rename the CLI flags",
            "Update docs",
          ],
        },
      ],
    }}
  />
);

export const BlockedDuplicateNames = () => (
  <Shell
    status={{
      type: "install-blocked",
      info: { version: "0.28.4-next.123.g123456789" },
      blockers: [
        {
          kind: "held-inputs",
          count: 2,
          workspaceNames: [
            "Migrate the storage layer to the new sc… (a1b2c3d4e5)",
            "Migrate the storage layer to the new sc… (f6a7b8c9d0)",
          ],
        },
      ],
    }}
  />
);
