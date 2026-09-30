import { PIXEL_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, waitFor, within } from "@storybook/test";
import { ProvidersSection } from "./ProvidersSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/ProvidersSection",
  component: ProvidersSection,
  parameters: {
    pixel: PIXEL_DISABLED,
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const ProvidersEmpty: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupSettingsStory({ providersConfig: {} })}>
      <ProvidersSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        if (canvas.queryAllByText(/No providers are currently enabled\./i).length === 0) {
          throw new Error("Expected empty providers message to render");
        }
      },
      { timeout: 5000 }
    );
  },
};

export const ProvidersConfigured: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true, baseUrl: "" },
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "https://custom.openai.com/v1",
            },
            xai: { apiKeySet: false, isEnabled: true, isConfigured: false, baseUrl: "" },
          },
        })
      }
    >
      <ProvidersSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findAllByTitle(/^Configured$/i, {}, { timeout: 5000 });
  },
};

export const ProvidersEnvSourced: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            openai: {
              apiKeySet: false,
              apiKeySource: "env",
              isEnabled: true,
              isConfigured: true,
              baseUrlSource: "env",
              baseUrlResolved: "https://env.openai.test/v1",
            },
          },
        })
      }
    >
      <ProvidersSection />
    </SettingsSectionStory>
  ),
  parameters: {
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const openaiButton = await canvas.findByRole("button", { name: /openai/i });
    await userEvent.click(openaiButton);

    await canvas.findByText("https://env.openai.test/v1");
    await waitFor(() => {
      if (canvas.queryAllByText(/Set by env vars\./i).length < 2) {
        throw new Error("Expected env source labels for OpenAI key and base URL");
      }
    });
  },
};

export const XAIProcessingMode: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            xai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              serviceTier: "priority",
            },
          },
        })
      }
    >
      <ProvidersSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const xaiButton = await canvas.findByRole("button", { name: /xAI/i });
    await userEvent.click(xaiButton);
    await canvas.findByText("fast (priority)");
  },
};

export const ProvidersExpanded: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true, baseUrl: "" },
            openai: { apiKeySet: false, isEnabled: true, isConfigured: false, baseUrl: "" },
            xai: { apiKeySet: false, isEnabled: true, isConfigured: false, baseUrl: "" },
          },
        })
      }
    >
      <ProvidersSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const openaiButton = await canvas.findByRole("button", { name: /openai/i });
    await userEvent.click(openaiButton);

    await canvas.findByRole("link", { name: /get api key/i });
  },
};
