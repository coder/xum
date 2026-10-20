import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { lightweightMeta, PIXEL_DISABLED } from "@/browser/stories/meta.js";
import {
  EMPTY_DAYTONA_RESOURCES,
  type DaytonaResources,
} from "@/browser/hooks/useDaytonaResources";
import type { DaytonaSandboxConfig } from "@/common/orpc/schemas/daytona";
import { DaytonaSandboxForm } from "./DaytonaControls";

const READY_RESOURCES: DaytonaResources = {
  ...EMPTY_DAYTONA_RESOURCES,
  config: {
    apiKeySet: true,
    apiKeySource: "settings",
    apiUrl: "https://app.daytona.io/api",
    target: null,
  },
  snapshots: ["daytonaio/sandbox:0.4.3", "xum-node-22-with-a-long-snapshot-name"],
  sandboxes: [
    { id: "sb-1", name: "shared-build-box", state: "started", cpu: 4, memoryGiB: 8 },
    { id: "sb-2", name: "nightly-ci", state: "stopped" },
  ],
};

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

function StatefulForm(props: {
  initialConfig: DaytonaSandboxConfig;
  resources: DaytonaResources;
  allowExisting: boolean;
  /** Phone stories force the width: the test-runner plays at desktop size. */
  width?: number;
}) {
  const [config, setConfig] = useState(props.initialConfig);
  return (
    <div className="bg-background p-4" style={props.width ? { width: props.width } : undefined}>
      <DaytonaSandboxForm
        config={config}
        onConfigChange={setConfig}
        resources={props.resources}
        allowExisting={props.allowExisting}
      />
    </div>
  );
}

/** New sandbox: snapshot (Daytona default first) and a size preset, as on workspace creation. */
export const NewSandbox: Story = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  render: () => <StatefulForm initialConfig={{}} resources={READY_RESOURCES} allowExisting />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("combobox", { name: "Daytona snapshot" })).toHaveTextContent(
      "Daytona default"
    );
    await expect(canvas.getByRole("combobox", { name: "Daytona size" })).toHaveTextContent(
      "Small (2 vCPU, 4 GiB, 10 GiB disk)"
    );
  },
};

/** The same form at phone width: the long preset label and snapshot must not overflow. */
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
      resources={READY_RESOURCES}
      allowExisting
      width={390}
    />
  ),
  play: async ({ canvasElement }) => {
    const form = within(canvasElement).getByTestId("daytona-sandbox-form");
    await expect(form.scrollWidth).toBeLessThanOrEqual(form.clientWidth);
  },
};

/** Existing: picking a sandbox attaches the workspace to it (shared, never deleted by Xum). */
export const ExistingSandbox: Story = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  render: () => <StatefulForm initialConfig={{}} resources={READY_RESOURCES} allowExisting />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Existing" }));
    await userEvent.click(canvas.getByRole("combobox", { name: "Existing Daytona sandbox" }));
    await userEvent.click(
      await within(document.body).findByRole("option", { name: /shared-build-box/ })
    );
    await expect(
      canvas.getByRole("combobox", { name: "Existing Daytona sandbox" })
    ).toHaveTextContent("shared-build-box");
  },
};

/** No API key yet: the form points to Settings instead of offering controls that would fail. */
export const NoApiKeyPhone: Story = {
  globals: { viewport: { value: "phone390", isRotated: false } },
  render: () => (
    <StatefulForm
      initialConfig={{}}
      resources={{
        ...EMPTY_DAYTONA_RESOURCES,
        config: {
          apiKeySet: false,
          apiKeySource: null,
          apiUrl: "https://app.daytona.io/api",
          target: null,
        },
      }}
      allowExisting
      width={390}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/Set a Daytona API key in Settings/);
    await expect(canvas.queryByRole("combobox", { name: "Daytona size" })).toBeNull();
  },
};

/** Listing failures show the server's message under the field they affect. */
export const ListErrors: Story = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  render: () => (
    <StatefulForm
      initialConfig={{}}
      resources={{
        ...READY_RESOURCES,
        snapshots: [],
        snapshotsError: "Daytona rejected the API key (401: Invalid credentials)",
      }}
      allowExisting
    />
  ),
};
