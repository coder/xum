import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { lightweightMeta, PIXEL_DISABLED } from "@/browser/stories/meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { DaytonaAccessForm } from "./DaytonaSettingsForms";
import { SettingsSectionStory } from "./settingsStoryUtils";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/Daytona Settings",
  parameters: {
    ...lightweightMeta.parameters,
    // Interaction contract only: the Pixel snapshot budget has no headroom.
    pixel: PIXEL_DISABLED,
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

/** First setup: paste a key, save it, then test the connection. */
export const SaveKeyAndTest: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        createMockORPCClient({
          daytonaConfig: { apiKeySet: false, apiKeySource: null },
          daytonaTestConnectionResult: { ok: true },
        })
      }
    >
      <div className="bg-background p-4">
        <DaytonaAccessForm />
      </div>
    </SettingsSectionStory>
  ),
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
