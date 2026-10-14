import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor } from "@storybook/test";
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

const OVERLOADED: StreamErrorRow = {
  type: "stream-error",
  id: "error-overloaded",
  historyId: "error-overloaded",
  error: "Anthropic is temporarily overloaded (HTTP 529). Please try again later.",
  errorType: "server_error",
  historySequence: 2,
  timestamp: STABLE_TIMESTAMP,
  model: "anthropic:claude-sonnet-4-5",
};

// The widest header: a repeat count, the Add credits link and the debug button.
const REPEATED_QUOTA: StreamErrorRow = {
  type: "stream-error",
  id: "error-quota",
  historyId: "error-quota",
  error: "Insufficient balance. Please add credits to continue.",
  errorType: "quota",
  historySequence: 3,
  timestamp: STABLE_TIMESTAMP,
  model: "mux-gateway:anthropic/claude-sonnet-4",
  routedThroughGateway: true,
  errorCount: 3,
};

function NarrowPane() {
  const [client] = useState(() => createMockORPCClient());
  return (
    <APIProvider client={client}>
      <div data-narrow-pane style={{ width: NARROW_PANE_WIDTH, padding: 0 }}>
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
 * Narrow-pane contract (#5151): the error cards' header actions and the retry card's Retry wrap
 * instead of overflowing a VS Code sidebar-sized pane. The pane has a fixed width, so the fit
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
    for (const element of pane.querySelectorAll<HTMLElement>("*")) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.right > paneRect.right + 0.5) {
        throw new Error(
          `<${element.tagName.toLowerCase()} class="${element.className.toString()}"> ends at ` +
            `${rect.right}px, past the ${NARROW_PANE_WIDTH}px pane (right edge ${paneRect.right}px)`
        );
      }
    }
  },
};
