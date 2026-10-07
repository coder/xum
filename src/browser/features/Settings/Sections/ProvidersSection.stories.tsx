import { PIXEL_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "@storybook/test";
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

/**
 * Pinned phone viewport for the rows that overflowed at narrow widths: the OpenAI
 * default-auth toggle must wrap inside the card, and the custom-provider "Add provider"
 * button must keep its label width (AGENTS.md Storybook responsive rule).
 */
export const ProvidersPhoneViewport: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    layout: "fullscreen",
    // No Pixel snapshot: the suite sits at its snapshot budget. The play's
    // geometry assertions guard the regression in the Storybook test-runner instead.
    pixel: PIXEL_DISABLED,
  },
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
      {/* Fixed phone width so the play's overflow assertions hold in the CI
          test-runner too, which ignores viewport globals (AGENTS.md). */}
      <div data-testid="phone-frame" style={{ width: 390 }}>
        <ProvidersSection />
      </div>
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const frame = canvas.getByTestId("phone-frame").getBoundingClientRect();

    await userEvent.click(await canvas.findByRole("button", { name: /openai/i }));
    const apiKeyOption = await canvas.findByText("Use OpenAI API key by default");
    const toggle = apiKeyOption.closest("[role='group']");
    if (!(toggle instanceof HTMLElement)) {
      throw new Error("Expected the default-auth toggle group");
    }
    await expect(toggle.getBoundingClientRect().right).toBeLessThanOrEqual(frame.right);

    const addProvider = await canvas.findByRole("button", { name: "Add provider" });
    await expect(addProvider.getBoundingClientRect().right).toBeLessThanOrEqual(frame.right);
    await expect(addProvider.scrollWidth).toBeLessThanOrEqual(addProvider.clientWidth);
    // Chromium never shrinks a nowrap button below its label, but iOS Safari did:
    // the button must opt out of flex shrinking for the label to stay inside it.
    await expect(getComputedStyle(addProvider).flexShrink).toBe("0");
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

export const OpenAICyberModelEnabled: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              cyberModelEnabled: true,
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
    await userEvent.click(await canvas.findByRole("button", { name: /openai/i }));
    await expect(await canvas.findByRole("switch", { name: "Enable cyber model" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
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

export const CoderModelRouting: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            coder: {
              apiKeySet: false,
              isEnabled: true,
              isConfigured: true,
              deploymentUrl: "https://coder.example.com",
              coderOauthSet: true,
              discoveredProviders: [
                { name: "anthropic", type: "anthropic" },
                { name: "anthropic-bedrock", type: "anthropic" },
                { name: "openai", type: "openai" },
              ],
              canonicalRoutes: { anthropic: "anthropic-bedrock", openai: "openai-removed" },
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
    await userEvent.click(await canvas.findByRole("button", { name: /^Coder/ }));
    await canvas.findByText("Model routing");
    await canvas.findByText(/openai-removed is not a known OpenAI provider/);
  },
};

/** The Bash commands switch saves through the API and stays on. */
export const BashCommandsSwitch: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupSettingsStory({ providersConfig: {} })}>
      <ProvidersSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      "switch",
      { name: "Count AI calls from bash commands" },
      { timeout: 5000 }
    );
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    await userEvent.click(toggle);
    // A failed save rolls the switch back.
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  },
};
