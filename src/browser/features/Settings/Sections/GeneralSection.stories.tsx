import { PIXEL_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";
import {
  DEFAULT_TERMINAL_BADGE_CONFIG,
  DEFAULT_TERMINAL_FONT_CONFIG,
} from "@/common/constants/storage";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
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
    await canvas.findByText(/^Terminal Font$/i);
    await canvas.findByText(/^Terminal Font Size$/i);
  },
};

/**
 * Phone-width contract for the Terminal Font row (#5814): the row wraps, so the fixed-width
 * input moves below its label instead of running past the screen edge (#5813). A play only, no
 * Pixel snapshot. The fixed 375px frame makes the check hold in the CI test-runner too, which
 * ignores viewport globals (AGENTS.md).
 */
export const TerminalFontPhoneWidth: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: { pixel: PIXEL_DISABLED },
  render: () => (
    <SettingsSectionStory setup={() => setupSettingsStory({})}>
      <div data-testid="phone-frame" style={{ width: 375, maxWidth: "100%" }}>
        <GeneralSection />
      </div>
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const frame = canvas.getByTestId("phone-frame").getBoundingClientRect();
    const input = await canvas.findByPlaceholderText(DEFAULT_TERMINAL_FONT_CONFIG.fontFamily);
    await expect(input.getBoundingClientRect().right).toBeLessThanOrEqual(frame.right);
  },
};

export const TerminalBadgeEnabledPhone: Story = {
  render: () => (
    <SettingsSectionStory
      // Enabled so the enabled-only badge rows render; the phone Pixel snapshot guards their
      // narrow-width wrapping.
      setup={() =>
        setupSettingsStory({
          userPreferences: {
            appearance: {
              terminalBadgeConfig: { ...DEFAULT_TERMINAL_BADGE_CONFIG, enabled: true },
            },
          },
        })
      }
    >
      <GeneralSection />
    </SettingsSectionStory>
  ),
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    pixel: { matrix: { viewports: ["phone"] } },
    docs: {
      description: {
        story:
          "Pins the phone-width contract for the enabled badge settings rows (template/position/opacity/font size), which only render when the badge is on.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Static contract: the enabled-only rows must be present, otherwise the
    // phone snapshot would silently capture the collapsed (disabled) UI.
    await canvas.findByLabelText("Terminal Badge Template");
    await canvas.findByLabelText("Terminal Badge Opacity");
    await canvas.findByLabelText("Terminal Badge Font Size");
  },
};
