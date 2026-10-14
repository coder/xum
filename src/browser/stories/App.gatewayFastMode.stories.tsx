import { expect, userEvent, waitFor, within } from "@storybook/test";
import { getPendingAiSelection } from "@/browser/utils/aiSelectionIntent";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import assert from "@/common/utils/assert";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar } from "./helpers/uiState";
import { blurActiveElement, waitForChatInputAutofocusDone } from "./storyPlayHelpers";

export default { ...appMeta, title: "App/Gateway Fast Mode" };

const workspaceId = "ws-gateway-fast-mode";
const phoneViewport = { name: "Phone", styles: { width: "390px", height: "844px" } };

function setupGatewayFastMode() {
  collapseLeftSidebar();
  // An unconfigured provider still exposes preferences.
  const providersConfig: ProvidersConfigMap = {
    coder: {
      apiKeySet: false,
      isEnabled: true,
      isConfigured: true,
      models: ["openai/gpt-6-astra"],
    },
    openai: { apiKeySet: false, isEnabled: true, isConfigured: false },
  };
  const client = setupSimpleChatStory({
    workspaceId,
    aiSettings: { model: "coder:openai/gpt-6-astra", thinkingLevel: "high" },
    messages: [],
    routePriority: ["coder"],
    providersConfig,
  });
  // Coder supplies credentials, but speed is still this chat's choice, never global config.
  client.providers.setProviderConfig = () => {
    throw new Error("Chat speed must not write provider config");
  };
  client.workspace.sendMessage = () => {
    throw new Error("Speed commands must not send a chat message");
  };
  client.workspace.setActiveTurnServiceTier = () =>
    Promise.resolve({ success: true, data: { accepted: false } });
  return client;
}

export const Desktop: AppStory = {
  render: () => <AppWithMocks setup={setupGatewayFastMode} />,
  parameters: {
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } },
  },
  play: async ({ canvasElement }) => {
    const root = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(root);
    await waitForChatInputAutofocusDone(root);
    blurActiveElement();
    const trigger = canvas.getByRole("button", { name: /Thinking:/ });

    const composer = canvas.getByRole("textbox", { name: "Message" });
    for (const [command, tier, label] of [
      ["/fast", "priority", "Thinking: high, fast mode"],
      ["/ultrafast", "ultrafast", "Thinking: high, ultrafast mode"],
      ["/ultrafast", "default", "Thinking: high"],
    ] as const) {
      await userEvent.type(composer, command);
      await userEvent.click(canvas.getByRole("button", { name: "Send message" }));
      await waitFor(async () => {
        await expect(composer).toHaveValue("");
        await expect(getPendingAiSelection(workspaceId, "exec", "serviceTier")).toBe(tier);
        await expect(trigger).toHaveAccessibleName(label);
      });
    }
    blurActiveElement();

    await userEvent.hover(trigger);
    const tooltip = await within(document.body).findByRole("tooltip");
    const shortcutHint = tooltip.querySelector<HTMLElement>(".mobile-hide-shortcut-hints");
    assert(shortcutHint, "Thinking shortcuts must opt into mobile hint hiding");
    // Pixel does not emulate touch. Real touch runs additionally exercise the CSS hiding rule.
    if (window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches) {
      await expect(shortcutHint).not.toBeVisible();
    }
    await userEvent.unhover(trigger);
    await userEvent.click(trigger);
    const fast = canvas.getByRole("button", { name: /Fast mode/ });
    const effort = canvas.getByRole("option", { name: "High" });
    await expect(fast).toHaveAttribute("aria-pressed", "false");
    await expect(effort).toHaveAttribute("aria-selected", "true");

    await userEvent.click(fast);
    await waitFor(async () => {
      await expect(fast).toBeEnabled();
      await expect(fast).toHaveAttribute("aria-pressed", "true");
      await expect(trigger).toHaveAccessibleName("Thinking: high, fast mode");
      await expect(within(trigger).getByLabelText("Fast mode enabled")).toBeVisible();
    });

    // The same control must be keyboard-operable and restore the original non-Fast tier.
    fast.focus();
    await userEvent.keyboard(" ");
    await waitFor(async () => {
      await expect(fast).toBeEnabled();
      await expect(fast).toHaveAttribute("aria-pressed", "false");
      await expect(getPendingAiSelection(workspaceId, "exec", "serviceTier")).toBe("default");
      await expect(trigger).toHaveAccessibleName("Thinking: high");
      await expect(within(trigger).queryByLabelText("Fast mode enabled")).not.toBeInTheDocument();
    });
    await userEvent.click(fast);
    await waitFor(async () => {
      await expect(fast).toBeEnabled();
      await expect(fast).toHaveAttribute("aria-pressed", "true");
      await expect(effort).toHaveAttribute("aria-selected", "true");
      await expect(canvas.getByRole("button", { name: /Pro mode/ })).toHaveAttribute(
        "aria-pressed",
        "false"
      );
    });

    const frame = canvas.queryByTestId("gateway-fast-phone") ?? root;
    const bounds = frame.getBoundingClientRect();
    if (frame !== root) await expect(bounds.width).toBe(390);
    const expectFitsFrame = async (component: string) => {
      await waitFor(async () => {
        const element = root.querySelector<HTMLElement>(`[data-component="${component}"]`);
        assert(element, `${component} must be rendered`);
        await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
        await expect(element.getBoundingClientRect().left).toBeGreaterThanOrEqual(bounds.left);
        await expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(bounds.right);
      });
    };
    // The absolute menu can extend into the composer's padding without clipping, so measure
    // the closed control row separately from the open menu's own content and frame bounds.
    await userEvent.click(trigger);
    await expectFitsFrame("ComposerControlRow");
    await userEvent.click(trigger);
    await expectFitsFrame("ThinkingSelectorMenu");
    await expect(canvas.getByRole("button", { name: /Fast mode/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    blurActiveElement();
  },
};

export const Phone: AppStory = {
  ...Desktop,
  // The test-runner ignores viewport globals; keep its layout assertions genuinely narrow.
  decorators: [
    (Story) => (
      <div data-testid="gateway-fast-phone" style={{ width: 390, height: 844 }}>
        <Story />
      </div>
    ),
  ],
  globals: { viewport: { value: "gatewayFastPhone", isRotated: false } },
  parameters: {
    viewport: { options: { gatewayFastPhone: phoneViewport } },
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  play: async (context) => Desktop.play!(context),
};
