import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { ServerAccessSection } from "@/browser/features/Settings/Sections/ServerAccessSection";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";

// Server access sessions: the section calls api.serverAuth.listSessions(), so we
// seed the mock client with a current + two remote sessions (mirrors the story's
// MOCK_SERVER_AUTH_SESSIONS). lastUsedAtMs is far in the future so the relative
// time reads "just now" deterministically regardless of when the preview renders.
export const ServerAccess = () => (
  <MuxPreviewShell
    client={createMockORPCClient({
      serverAuthSessions: [
        {
          id: "session-current",
          label: "Safari on iPhone",
          createdAtMs: 1_735_689_600_000,
          lastUsedAtMs: 4_102_444_800_000,
          isCurrent: true,
        },
        {
          id: "session-macbook",
          label: "Chrome on Mac",
          createdAtMs: 1_735_776_000_000,
          lastUsedAtMs: 4_102_444_800_000,
          isCurrent: false,
        },
        {
          id: "session-tablet",
          label: "Firefox on Android",
          createdAtMs: 1_735_862_400_000,
          lastUsedAtMs: 4_102_444_800_000,
          isCurrent: false,
        },
      ],
    })}
  >
    <div className="p-6 max-w-2xl">
      <ServerAccessSection />
    </div>
  </MuxPreviewShell>
);
