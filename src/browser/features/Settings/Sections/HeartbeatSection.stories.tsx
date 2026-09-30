import { expect, waitFor, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HeartbeatSection } from "./HeartbeatSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/HeartbeatSection",
  component: HeartbeatSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Heartbeats: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          heartbeatDefaultIntervalMs: 45 * 60_000,
          heartbeatDefaultPrompt: "Review pending work before continuing.",
        })
      }
    >
      <HeartbeatSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const heartbeatThresholdInput = await canvas.findByLabelText(
      "Default heartbeat threshold in minutes"
    );
    await waitFor(() => expect(heartbeatThresholdInput).toHaveValue(45));
    const heartbeatPrompt = await canvas.findByLabelText("Default heartbeat prompt");
    await waitFor(() =>
      expect(heartbeatPrompt).toHaveValue("Review pending work before continuing.")
    );
  },
};
