import { expect, userEvent, within } from "@storybook/test";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar } from "./helpers/uiState";
import { blurActiveElement, waitForChatInputAutofocusDone } from "./storyPlayHelpers";

export default { ...appMeta, title: "App/Astra Pro" };

const workspaceId = "ws-astra-pro";
const phoneViewport = { name: "Phone", styles: { width: "390px", height: "844px" } };

export const CoderGateway: AppStory = {
  // The test-runner ignores viewport globals, so enforce the narrow container there too.
  decorators: [
    (Story) => (
      <div
        data-testid="astra-pro-phone"
        style={{ width: `min(${phoneViewport.styles.width}, 100%)`, height: "100%" }}
      >
        <Story />
      </div>
    ),
  ],
  globals: { viewport: { value: "astraPhone", isRotated: false } },
  parameters: {
    viewport: { options: { astraPhone: phoneViewport } },
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        return setupSimpleChatStory({
          workspaceId,
          aiSettings: { model: "coder:openai/gpt-6-astra", thinkingLevel: "high" },
          messages: [],
          routePriority: ["coder"],
          providersConfig: {
            coder: {
              apiKeySet: false,
              isEnabled: true,
              isConfigured: true,
              models: ["openai/gpt-6-astra"],
            },
          },
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const root = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(root);
    await waitForChatInputAutofocusDone(root);
    blurActiveElement();
    const trigger = canvas.getByRole("button", { name: /Thinking:/ });
    await userEvent.click(trigger);
    const pro = canvas.getByRole("button", { name: /Pro mode/ });
    await expect(pro).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(pro);
    await expect(pro).toHaveAttribute("aria-pressed", "true");
    await expect(trigger).toHaveAccessibleName("Thinking: high, pro mode");
    // Keyboard activation must also disable Pro without changing reasoning effort.
    pro.focus();
    await userEvent.keyboard(" ");
    await expect(pro).toHaveAttribute("aria-pressed", "false");
    await expect(trigger).toHaveAccessibleName("Thinking: high");
    await userEvent.click(pro);
    const menu = canvas.getByRole("listbox", { name: "Reasoning effort" });
    const bounds = (canvas.queryByTestId("astra-pro-phone") ?? root).getBoundingClientRect();
    await expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(bounds.right);
    await expect(menu.getBoundingClientRect().left).toBeGreaterThanOrEqual(bounds.left);
  },
};

export const Desktop: AppStory = {
  ...CoderGateway,
  decorators: [],
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } } },
  play: async (context) => CoderGateway.play!(context),
};
