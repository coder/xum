import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor } from "storybook/test";
import { APIProvider } from "@/browser/contexts/API";
import { RetryBarrierContent } from "@/browser/features/Messages/ChatBarrier/RetryBarrier";
import { StreamErrorMessage } from "@/browser/features/Messages/StreamErrorMessage";
import { lightweightMeta } from "@/browser/stories/meta";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";
import type { DisplayedMessage } from "@/common/types/message";

type StreamErrorRow = Extract<DisplayedMessage, { type: "stream-error" }>;

/** About the narrowest VS Code sidebar the webview transcript was measured at (#5151). */
const NARROW_PANE_WIDTH = 200;
/** VS Code's minimum sidebar width: the narrowest pane the webview can get (#5645). */
const VSCODE_MIN_SIDEBAR_WIDTH = 170;

// The widest header: a repeat count, the Status link and the debug button.
const OVERLOADED: StreamErrorRow = {
  type: "stream-error",
  id: "error-overloaded",
  historyId: "error-overloaded",
  error: "Anthropic is temporarily overloaded (HTTP 529). Please try again later.",
  errorType: "server_error",
  historySequence: 2,
  timestamp: STABLE_TIMESTAMP,
  model: "anthropic:claude-sonnet-4-5",
  errorCount: 3,
};

const REPEATED_QUOTA: StreamErrorRow = {
  type: "stream-error",
  id: "error-quota",
  historyId: "error-quota",
  error: "You exceeded your current quota. Check your plan and billing details.",
  errorType: "quota",
  historySequence: 3,
  timestamp: STABLE_TIMESTAMP,
  model: "openai:gpt-5",
  errorCount: 3,
};

function NarrowPane() {
  const [client] = useState(() => createMockORPCClient());
  return (
    <APIProvider client={client}>
      {/* p-3: the VS Code webview transcript's padding (vscode/src/webview/App.tsx), so the cards
          get the width they have there (#5645). */}
      <div data-narrow-pane className="p-3" style={{ width: NARROW_PANE_WIDTH }}>
        <StreamErrorMessage message={OVERLOADED} />
        <StreamErrorMessage message={REPEATED_QUOTA} />
        <RetryBarrierContent
          workspaceId="ws-narrow"
          messages={[REPEATED_QUOTA]}
          autoRetryStatus={null}
          isStreamStarting={false}
          canInterrupt={false}
        />
      </div>
    </APIProvider>
  );
}

const meta = {
  ...lightweightMeta,
  title: "Features/Messages/StreamErrorMessage",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Narrow-pane contract (#5151, #5645): the error cards' header actions and the retry card's Retry
 * wrap instead of overflowing a VS Code sidebar-sized pane with the transcript's padding. The pane has a fixed width, so the fit
 * holds at any window size, including the desktop-sized test-runner; Pixel pins the phone viewport.
 */
export const NarrowPane200: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: {
    pixel: { matrix: { themes: ["dark"], viewports: ["phone"] } },
  },
  render: () => <NarrowPane />,
  play: async ({ canvasElement }) => {
    const pane = canvasElement.querySelector<HTMLElement>("[data-narrow-pane]");
    if (!pane) throw new Error("Narrow pane did not render");
    await waitFor(() => {
      if (!pane.textContent?.includes("Retry")) throw new Error("Retry barrier did not render");
    });
    const paneRect = pane.getBoundingClientRect();
    if (paneRect.width !== NARROW_PANE_WIDTH) {
      throw new Error(`Pane is ${paneRect.width}px wide; expected ${NARROW_PANE_WIDTH}px`);
    }
    // Nothing may reach into its parent's right padding. In the webview, Retry with its shortcut
    // hint ran into the retry card's padding in a narrow sidebar (#5645), so the retry card is also
    // checked at the narrowest sidebar; then the width is restored for the snapshot.
    const retryCard = [...pane.children].at(-1);
    if (!(retryCard instanceof HTMLElement) || !retryCard.textContent?.includes("Retry")) {
      throw new Error("The retry card is not the pane's last child");
    }
    const overflows = (root: HTMLElement) => {
      for (const element of root.querySelectorAll<HTMLElement>("*")) {
        const rect = element.getBoundingClientRect();
        const parent = element.parentElement;
        if (rect.width === 0 || !parent) continue;
        const parentStyle = getComputedStyle(parent);
        const contentRight =
          parent.getBoundingClientRect().right -
          parseFloat(parentStyle.paddingRight) -
          parseFloat(parentStyle.borderRightWidth);
        if (rect.right > contentRight + 0.5) {
          return (
            `${pane.style.width} pane: <${element.tagName.toLowerCase()} ` +
            `class="${element.className.toString()}"> ends at ${rect.right}px, past its parent's ` +
            `content box (right edge ${contentRight}px)`
          );
        }
      }
      return null;
    };
    try {
      for (const [width, root] of [
        [NARROW_PANE_WIDTH, pane],
        [VSCODE_MIN_SIDEBAR_WIDTH, retryCard],
      ] as const) {
        pane.style.width = `${width}px`;
        const overflow = overflows(root);
        if (overflow) throw new Error(overflow);
      }
    } finally {
      pane.style.width = `${NARROW_PANE_WIDTH}px`;
    }
  },
};
