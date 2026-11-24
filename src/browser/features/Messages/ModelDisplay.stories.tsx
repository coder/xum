import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import { PIXEL_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";
import {
  SettingsSectionStory,
  setupSettingsStory,
} from "../Settings/Sections/settingsStoryUtils.js";
import { ModelDisplay } from "./ModelDisplay";

const meta: Meta = {
  ...lightweightMeta,
  title: "Features/Messages/ModelDisplay",
  component: ModelDisplay,
  parameters: {
    pixel: PIXEL_DISABLED,
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

function customProvider(baseUrl: string, model: string) {
  return {
    apiKeySet: false,
    isEnabled: true,
    isConfigured: true,
    isCustom: true,
    providerType: "openai-compatible" as const,
    baseUrl,
    models: [model],
  };
}

export const CustomProviderIcons: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            "lm-studio": customProvider("http://localhost:1234/v1", "gemma-3-12b"),
            "mac-studio": customProvider("http://192.168.1.20:8000/v1", "qwen3-32b"),
          },
        })
      }
    >
      <div data-testid="brand">
        <ModelDisplay modelString="lm-studio:gemma-3-12b" />
      </div>
      <div data-testid="fallback">
        <ModelDisplay modelString="mac-studio:qwen3-32b" />
      </div>
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const fillOf = async (testId: string, selector: string) => {
      const container = await canvas.findByTestId(testId);
      return waitFor(() => {
        const shape = container.querySelector(selector);
        if (shape == null) {
          throw new Error(`Expected ${selector} in ${testId}`);
        }
        return getComputedStyle(shape).fill;
      });
    };

    // Brand logos are drawn with fill; the lucide fallback is drawn with stroke, and filling
    // its shapes turns it into a solid blob.
    await expect(await fillOf("brand", "svg path")).not.toBe("none");
    await expect(await fillOf("fallback", "svg.lucide-cpu path")).toBe("none");
  },
};
