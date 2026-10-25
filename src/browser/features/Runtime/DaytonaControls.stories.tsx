import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, within } from "storybook/test";
import { APIProvider } from "@/browser/contexts/API";
import { lightweightMeta, PIXEL_DISABLED } from "@/browser/stories/meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { DaytonaPublicConfig, DaytonaSandboxConfig } from "@/common/orpc/schemas/daytona";
import { DaytonaCreationForm } from "./DaytonaControls";

const PHONE_VIEWPORT = {
  phone390: {
    name: "Phone 390",
    styles: { width: "390px", height: "844px" },
    type: "mobile",
  },
};

const meta: Meta = {
  ...lightweightMeta,
  title: "App/Runtime/Daytona Controls",
  parameters: {
    ...lightweightMeta.parameters,
    viewport: { options: PHONE_VIEWPORT },
    // Interaction contracts only: the Pixel snapshot budget has no headroom, and the phone
    // stories assert their own no-overflow width instead of relying on a capture.
    pixel: PIXEL_DISABLED,
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

function StatefulForm(props: { initialConfig: DaytonaSandboxConfig; access: DaytonaPublicConfig }) {
  const [client] = useState(() =>
    createMockORPCClient({
      daytonaConfig: props.access,
      daytonaSnapshotsResult: {
        ok: true,
        snapshots: [
          { name: "daytonaio/sandbox:0.4.3" },
          { name: "xum-node-22-with-a-long-snapshot-name" },
        ],
      },
    })
  );
  const [config, setConfig] = useState(props.initialConfig);
  return (
    <APIProvider client={client}>
      {/* The test-runner plays at desktop size: force the phone width here. */}
      <div className="bg-background p-4" style={{ width: 390 }}>
        <DaytonaCreationForm config={config} onConfigChange={setConfig} />
      </div>
    </APIProvider>
  );
}

/** New sandbox at phone width: the long preset label and snapshot must not overflow. */
export const NewSandboxPhone: Story = {
  globals: { viewport: { value: "phone390", isRotated: false } },
  render: () => (
    <StatefulForm
      initialConfig={{
        snapshot: "xum-node-22-with-a-long-snapshot-name",
        cpu: 8,
        memoryGiB: 16,
        diskGiB: 40,
      }}
      access={{ apiKeySet: true, apiKeySource: "settings" }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("combobox", { name: "Daytona snapshot" });
    const form = canvas.getByTestId("daytona-sandbox-form");
    await expect(form.scrollWidth).toBeLessThanOrEqual(form.clientWidth);
  },
};

/** No API key yet: the form points to Settings instead of offering controls that would fail. */
export const NoApiKeyPhone: Story = {
  globals: { viewport: { value: "phone390", isRotated: false } },
  render: () => (
    <StatefulForm initialConfig={{}} access={{ apiKeySet: false, apiKeySource: null }} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/Set a Daytona API key in Settings/);
    await expect(canvas.queryByRole("combobox", { name: "Daytona size" })).toBeNull();
  },
};
