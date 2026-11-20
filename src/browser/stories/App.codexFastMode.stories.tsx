import { expect, userEvent, waitFor, within } from "storybook/test";
import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar } from "./helpers/uiState";
import { waitForChatInputAutofocusDone } from "./storyPlayHelpers";

export default { ...appMeta, title: "App/Codex Fast Mode" };

function setupCodexFastMode() {
  collapseLeftSidebar();
  const client = setupSimpleChatStory({
    workspaceId: "ws-codex-fast-mode",
    aiSettings: { model: "openai:gpt-6.2-astra", thinkingLevel: "high" },
    messages: [],
    routePriority: ["direct"],
    providersConfig: {
      openai: { apiKeySet: false, codexOauthSet: true, isEnabled: true, isConfigured: true },
    },
  });
  client.workspace.setActiveTurnServiceTier = () =>
    Promise.resolve({ success: true, data: { accepted: false } });
  return client;
}

export const Toggle: AppStory = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={setupCodexFastMode} />,
  play: async ({ canvasElement }) => {
    const root = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(root);
    await waitForChatInputAutofocusDone(root);
    const thinking = canvas.getByRole("button", { name: /Thinking:/ });
    await userEvent.click(thinking);
    const fast = canvas.getByRole("button", { name: /^Fast mode/ });
    await expect(fast).toHaveAttribute("aria-pressed", "false");
    await expect(canvas.queryByRole("button", { name: /Ultrafast mode/ })).not.toBeInTheDocument();

    await userEvent.click(fast);
    await waitFor(() => expect(fast).toHaveAttribute("aria-pressed", "true"));
    await expect(thinking).toHaveAccessibleName("Thinking: high, fast mode");

    await userEvent.click(fast);
    await waitFor(() => expect(fast).toHaveAttribute("aria-pressed", "false"));
    await expect(thinking).toHaveAccessibleName("Thinking: high");
  },
};
