import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { lightweightMeta, PIXEL_DISABLED } from "@/browser/stories/meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { DaytonaPublicConfig } from "@/common/orpc/schemas/daytona";
import { DaytonaAccessForm, DaytonaDefaultsForm } from "./DaytonaSettingsForms";
import { SettingsSectionStory } from "./settingsStoryUtils";

const PROJECT_PATH = "/Users/test/my-app";

const NO_KEY: DaytonaPublicConfig = {
  apiKeySet: false,
  apiKeySource: null,
  apiUrl: "https://app.daytona.io/api",
  target: null,
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
  title: "Settings/Sections/Daytona Settings",
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

function renderForms(options: {
  daytonaConfig: DaytonaPublicConfig;
  testError?: string;
  /** Phone stories force the width: the test-runner plays at desktop size. */
  width?: number;
}) {
  return (
    <SettingsSectionStory
      setup={() =>
        createMockORPCClient({
          daytonaConfig: options.daytonaConfig,
          daytonaTestConnectionResult: options.testError
            ? { ok: false, kind: "unauthorized", error: options.testError }
            : { ok: true },
          daytonaSnapshotsResult: { ok: true, snapshots: [{ name: "daytonaio/sandbox:0.4.3" }] },
        })
      }
    >
      <div
        className="bg-background p-4"
        style={options.width ? { width: options.width } : undefined}
      >
        <DaytonaAccessForm />
        <DaytonaDefaultsForm projectPath={PROJECT_PATH} />
      </div>
    </SettingsSectionStory>
  );
}

/** First setup: paste a key, save it, then test the connection. */
export const SaveKeyAndTest: Story = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  render: () => renderForms({ daytonaConfig: NO_KEY }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Not set");
    await userEvent.type(canvas.getByLabelText("API key"), "dtn-story-key");
    await userEvent.click(canvas.getByRole("button", { name: "Save" }));
    await canvas.findByText("Key set (settings)");
    // The status sits beside the label: the field's name stays "API key".
    await expect(canvas.getByLabelText("API key")).toHaveAccessibleDescription(
      "Key set (settings)"
    );
    await expect(canvas.getByLabelText("API key")).toHaveValue("");
    await userEvent.click(canvas.getByRole("button", { name: "Test connection" }));
    await canvas.findByText(/Connected/);
  },
};

/** A key from the environment: no Remove button, and a failed test shows the server's reason. */
export const EnvKeyTestFailsPhone: Story = {
  globals: { viewport: { value: "phone390", isRotated: false } },
  render: () =>
    renderForms({
      daytonaConfig: { ...NO_KEY, apiKeySet: true, apiKeySource: "env" },
      testError: "Daytona rejected the API key (401: Invalid credentials)",
      width: 390,
    }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Key set (env)");
    await expect(canvas.queryByRole("button", { name: "Remove key" })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Test connection" }));
    await canvas.findByText(/401: Invalid credentials/);
    const form = canvas.getByTestId("daytona-access-form");
    await expect(form.scrollWidth).toBeLessThanOrEqual(form.clientWidth);
  },
};
