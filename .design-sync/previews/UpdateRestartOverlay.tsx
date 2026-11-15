import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { UpdateRestartOverlay } from "@/browser/components/UpdateRestartOverlay/UpdateRestartOverlay";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";

// Isolated preview of the full-viewport "Restarting Xum…" cover. The overlay subscribes to
// api.update.onStatus, so the mock client yields a "restarting" status (mirrors the story).
// It portals to <body> as a fixed cover → cardMode "single". The card captures RestartingPhone
// at its mobile1 viewport (config.json): an inner width wrapper can't size a fixed inset-0 cover.

export const Restarting = () => {
  const [client] = React.useState(() =>
    createMockORPCClient({ updateStatus: { type: "restarting", info: { version: "0.29.0" } } })
  );
  return (
    <MuxPreviewShell client={client}>
      <div className="bg-background text-foreground space-y-2 p-6">
        <h1 className="text-lg font-medium">Workspace content</h1>
        <p className="text-muted text-sm">
          Everything here must stay hidden behind the restart screen.
        </p>
      </div>
      <UpdateRestartOverlay />
    </MuxPreviewShell>
  );
};

// Same render as the story; only the viewport differs (pinned in config.json).
export const RestartingPhone = Restarting;
