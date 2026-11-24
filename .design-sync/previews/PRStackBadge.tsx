import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { PRStackBadge } from "@/browser/components/PRStackBadge/PRStackBadge";
import type { WorkspaceStackInfo } from "@/common/types/links";

// PR stack badge from the workspace header — one cell per story in PRStackBadge.stories.tsx.
// Both stories' play() opens the stack menu; the component has no `defaultOpen`, so the
// preview clicks its trigger once on mount (the menu is portaled to <body>, fixed-positioned
// under the trigger). Pure props: no API data.

const STACK: WorkspaceStackInfo = {
  trunk: "main",
  branches: [
    {
      branch: "mike/stack-foundation",
      isCurrent: false,
      needsRebase: false,
      pr: {
        number: 28051,
        url: "https://github.com/coder/mux/pull/28051",
        state: "MERGED",
        title: "feat: add the stack foundation",
      },
    },
    {
      branch: "mike/stack-store",
      isCurrent: false,
      needsRebase: false,
      pr: {
        number: 28052,
        url: "https://github.com/coder/mux/pull/28052",
        state: "OPEN",
        title: "feat: cache stack metadata for visible workspaces",
      },
    },
    {
      branch: "mike/stack-menu",
      isCurrent: true,
      needsRebase: false,
      pr: {
        number: 28053,
        url: "https://github.com/coder/mux/pull/28053",
        state: "OPEN",
        title: "feat: add a pull request stack dropdown with long titles",
        isDraft: true,
      },
    },
    {
      branch: "mike/stack-responsive",
      isCurrent: false,
      needsRebase: true,
      pr: {
        number: 28054,
        url: "https://github.com/coder/mux/pull/28054",
        state: "OPEN",
        title: "fix: keep the stack menu inside narrow viewports",
      },
    },
    {
      branch: "mike/stack-submit",
      isCurrent: false,
      needsRebase: false,
    },
    {
      branch: "mike/stack-queue",
      isCurrent: false,
      needsRebase: false,
      pr: {
        number: 28056,
        url: "https://github.com/coder/mux/pull/28056",
        state: "QUEUED",
        title: "feat: finish stack awareness",
      },
    },
  ],
};

// Stand-in for the stories' play(): click the stack trigger once it is in the DOM.
function OpenOnMount(props: {
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const timer = setTimeout(() => {
      ref.current?.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']")?.click();
    }, 50);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div ref={ref} className={props.className} style={props.style}>
      {props.children}
    </div>
  );
}

export const SixLayerStack = () => (
  <MuxPreviewShell>
    <OpenOnMount className="bg-background text-foreground min-h-96 p-6">
      <div className="flex justify-end">
        <PRStackBadge stack={STACK} menuDirection="down" />
      </div>
    </OpenOnMount>
  </MuxPreviewShell>
);

// The story pins Storybook's mobile1 viewport (375px); the preview pins the frame instead.
export const PhoneWidth = () => (
  <MuxPreviewShell>
    <OpenOnMount
      className="bg-background text-foreground min-h-96 w-full p-2"
      style={{ width: 375 }}
    >
      <div className="flex justify-end">
        <PRStackBadge stack={STACK} menuDirection="down" />
      </div>
    </OpenOnMount>
  </MuxPreviewShell>
);
