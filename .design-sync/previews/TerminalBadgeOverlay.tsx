import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { TerminalBadgeOverlay } from "@/browser/components/TerminalView/TerminalBadgeOverlay";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import {
  DEFAULT_TERMINAL_BADGE_CONFIG,
  type TerminalBadgeConfig,
} from "@/common/constants/storage";

// Isolated previews of the terminal badge watermark — one export per story in
// TerminalBadgeOverlay.stories.tsx. The overlay reads its config from the global
// AppConfigStore singleton, so the preview seeds it before first read (like the story's
// BadgeStory wrapper) — and also serves the same preferences from the mock client, because
// the harness's APIProvider attaches the store to that client and refetches config. Because the store is shared by every mount on the page, the card
// renders one variant at a time (cardMode "single"; pick others with ?story=).

const FAKE_OUTPUT = Array.from(
  { length: 14 },
  (_, i) => `$ build step ${i + 1} … ok (${(i + 1) * 137}ms)`
).join("\n");

const BadgeSurface = (props: {
  config: Partial<TerminalBadgeConfig>;
  workspaceName?: string;
  tabName?: string;
  width?: number;
}) => {
  const [client] = React.useState(() => {
    const userPreferences = {
      appearance: {
        terminalBadgeConfig: { ...DEFAULT_TERMINAL_BADGE_CONFIG, enabled: true, ...props.config },
      },
    };
    getAppConfigStore().updateOptimistically({ userPreferences });
    return createMockORPCClient({ userPreferences });
  });
  return (
    <MuxPreviewShell client={client}>
      <div
        className="bg-background text-foreground p-4"
        style={{ width: props.width, maxWidth: "100%" }}
      >
        <div
          className="border-border-medium relative h-64 overflow-hidden rounded border"
          style={{ backgroundColor: "var(--color-terminal-bg)" }}
        >
          <pre className="p-2 text-xs" style={{ color: "var(--color-terminal-fg)" }}>
            {FAKE_OUTPUT}
          </pre>
          <TerminalBadgeOverlay
            workspaceName={props.workspaceName ?? "fix-3607-terminal-badge"}
            projectName="xum"
            tabName={props.tabName ?? "Terminal"}
            tabIndex={0}
          />
        </div>
      </div>
    </MuxPreviewShell>
  );
};

export const TopRightDefault = () => <BadgeSurface config={{}} />;

export const BottomLeft = () => <BadgeSurface config={{ position: "bottom-left" }} />;

export const HighOpacityLargeFont = () => (
  <BadgeSurface
    config={{ opacity: 0.9, fontSize: 28, template: "{project}/{workspace} · {tab}" }}
  />
);

// Story pins the phone viewport (mobile1, 375px in .storybook/preview.tsx) and the surface fills
// it; the preview pins that width instead. The badge truncates relative to the surface width.
export const LongNamesTruncatePhone = () => (
  <BadgeSurface
    config={{}}
    width={375}
    workspaceName="extremely-long-workspace-branch-name-that-should-truncate"
    tabName="very-long-osc-title-from-a-build-process"
  />
);
