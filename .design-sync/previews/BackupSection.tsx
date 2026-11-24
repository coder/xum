import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { BackupSection } from "@/browser/features/Settings/Sections/BackupSection.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";

// Settings → Backup section — mirrors BackupSection.stories.tsx. The section loads
// api.backup.* from the mock client (configured repo, reachable validation, a full preview).
// The stories' play() clicks "Validate" / "Preview changes"; the preview replays those clicks
// once the buttons are enabled so the validation line and the change lists show statically.

function backupClient() {
  return createMockORPCClient({
    backupSettings: {
      repoUrl: "git@github.com:example/dotfiles.git",
      branch: "main",
      path: "xum/",
    },
    backupValidation: {
      reachable: true,
      empty: false,
      credential: "gh",
    },
    backupPreview: {
      pushChanges: [
        { status: "M", path: "mux/preferences.json" },
        { status: "A", path: "mux/memory/global/preferences.md" },
      ],
      restoreChanges: [
        { status: "M", path: "preferences.json" },
        { status: "A", path: "skills/release/SKILL.md" },
      ],
      localOnlyFiles: ["agents/local-only.md"],
      redactions: ["mcp.jsonc: github.headers.Authorization"],
      commandApprovals: [
        {
          path: "servers.notes.command",
          command: "npx -y @modelcontextprotocol/server-filesystem /home/dev/notes",
          token: "8d2e4787fcc88a36cbd9067997213f1a791ec3999af6e9bf2259f6f3a1a0337e",
        },
      ],
      projectImports: [
        {
          sourcePath: "/home/dev/src/rocket",
          name: "rocket",
          gitRemote: "git@github.com:dev/rocket.git",
          memoryFileCount: 3,
          token: "1f4c9a2b8d6e0f31a5c7e9b2d4f6081a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1e3b",
        },
      ],
      projectBundleSkipped: false,
      pushError: null,
    },
  });
}

/** Clicks each labelled button in order, once it exists and is enabled (stands in for play()). */
function ClickThrough(props: { labels: string[]; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    let step = 0;
    const timer = window.setInterval(() => {
      if (step >= props.labels.length) return window.clearInterval(timer);
      const button = Array.from(ref.current?.querySelectorAll("button") ?? []).find(
        (b) => b.textContent?.trim() === props.labels[step] && !b.disabled
      );
      if (button) {
        button.click();
        step++;
      }
    }, 150);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={ref}>{props.children}</div>;
}

export const Configured = () => (
  <MuxPreviewShell client={backupClient()}>
    <ClickThrough labels={["Validate", "Preview changes"]}>
      <div className="bg-background text-foreground min-h-screen p-4 sm:p-6">
        <BackupSection />
      </div>
    </ClickThrough>
  </MuxPreviewShell>
);

// The story pins the mobile2 viewport (414px); reproduce it with a 414px wrapper.
export const Phone = () => (
  <MuxPreviewShell client={backupClient()}>
    <ClickThrough labels={["Preview changes"]}>
      <div className="bg-background text-foreground min-h-screen p-4" style={{ width: 414 }}>
        <BackupSection />
      </div>
    </ClickThrough>
  </MuxPreviewShell>
);
