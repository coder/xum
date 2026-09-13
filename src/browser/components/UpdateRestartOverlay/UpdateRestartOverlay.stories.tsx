import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "@storybook/test";
import { APIProvider } from "@/browser/contexts/API";
import { lightweightMeta } from "@/browser/stories/meta";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { UpdateRestartOverlay } from "./UpdateRestartOverlay";

function RestartOverlayStory() {
  const [client] = useState(() =>
    createMockORPCClient({ updateStatus: { type: "restarting", info: { version: "0.29.0" } } })
  );
  return (
    <APIProvider client={client}>
      <div className="text-foreground space-y-2 p-6">
        <h1 className="text-lg font-medium">Workspace content</h1>
        <p className="text-muted text-sm">
          Everything here must stay hidden behind the restart screen.
        </p>
      </div>
      <UpdateRestartOverlay />
    </APIProvider>
  );
}

const meta: Meta = {
  ...lightweightMeta,
  title: "Components/UpdateRestartOverlay",
  component: RestartOverlayStory,
};
export default meta;
type Story = StoryObj<typeof meta>;

async function expectOverlayCoversViewport() {
  const overlay = await within(document.body).findByTestId("update-restart-overlay");
  await expect(within(overlay).getByText("Restarting Xum…")).toBeVisible();
  const rect = overlay.getBoundingClientRect();
  await expect(rect.top).toBeLessThanOrEqual(0);
  await expect(rect.left).toBeLessThanOrEqual(0);
  await expect(rect.right).toBeGreaterThanOrEqual(window.innerWidth);
  await expect(rect.bottom).toBeGreaterThanOrEqual(window.innerHeight);
}

export const Restarting: Story = {
  play: expectOverlayCoversViewport,
};

export const RestartingPhone: Story = {
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: expectOverlayCoversViewport,
};
