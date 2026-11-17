import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "storybook/test";
import { GeneralSection } from "./GeneralSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/GeneralSection",
  component: GeneralSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const General: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupSettingsStory({})}>
      <GeneralSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/^Theme$/i);
    await canvas.findByText(/^Transcript density$/i);
  },
};
