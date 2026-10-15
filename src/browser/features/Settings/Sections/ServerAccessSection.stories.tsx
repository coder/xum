import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "storybook/test";
import { ServerAccessSection } from "./ServerAccessSection.js";
import {
  MOCK_SERVER_AUTH_SESSIONS,
  SettingsSectionStory,
  setupSettingsStory,
} from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/ServerAccessSection",
  component: ServerAccessSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const ServerAccess: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          serverAuthSessions: MOCK_SERVER_AUTH_SESSIONS,
        })
      }
    >
      <ServerAccessSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/Server access sessions/i);
    await canvas.findByText(/Safari on iPhone \(Current\)/i);
    await canvas.findByText(/Chrome on Mac/i);
    await canvas.findByText(/Firefox on Android/i);
    await canvas.findByRole("button", { name: /^Refresh$/i });
    await canvas.findByRole("button", { name: /Revoke other sessions/i });
  },
};
