/**
 * Recipient consent for cross-tree agent messaging: the "Messages from other workspaces" dialog
 * reached from the workspace actions menu. The switch mirrors published metadata, so the play
 * toggles it through the mock client's metadata push (same shape as the backend's ack) and
 * asserts the switch only moves once that metadata arrives.
 */

import type { ComponentType } from "react";
import { userEvent, waitFor, within } from "@storybook/test";

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar, collapseRightSidebar } from "./helpers/uiState";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";

const CONSENT_SWITCH_NAME = /allow messages from unrelated workspaces/i;

const WORKSPACE_ID = "ws-unrelated-messaging-consent";

function setupConsentStory() {
  collapseLeftSidebar();
  collapseRightSidebar();
  return setupSimpleChatStory({
    workspaceId: WORKSPACE_ID,
    workspaceName: "release-coordinator",
    projectName: "mux",
    messages: [
      createUserMessage("consent-user", "Let the other release chats reach this one.", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 60_000,
      }),
      createAssistantMessage(
        "consent-assistant",
        "Only you can allow that: open Workspace actions → Messages from other workspaces.",
        { historySequence: 2, timestamp: STABLE_TIMESTAMP }
      ),
    ],
  });
}

/** Opens the consent dialog from the workspace actions menu; the dialog portals to document.body. */
async function openConsentDialog(canvasElement: HTMLElement): Promise<HTMLElement> {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByTestId("workspace-more-actions"));
  await userEvent.click(
    await waitFor(() => within(document.body).getByTestId("workspace-unrelated-messaging-button"))
  );
  const dialog = await waitFor(
    () => within(document.body).getByRole("dialog", { name: "Messages from other workspaces" }),
    { timeout: 10_000 }
  );
  const descriptionId = dialog.getAttribute("aria-describedby");
  if (!descriptionId || !document.getElementById(descriptionId)?.textContent?.trim()) {
    throw new Error("Consent dialog must expose a readable accessible description");
  }
  return dialog;
}

export default {
  ...appMeta,
  title: "App/UnrelatedMessagingConsent",
};

export const Desktop: AppStory = {
  render: () => <AppWithMocks setup={setupConsentStory} />,
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } },
  },
  play: async ({ canvasElement }) => {
    const dialog = await openConsentDialog(canvasElement);
    const toggle = within(dialog).getByRole("switch", { name: CONSENT_SWITCH_NAME });
    // A workspace without a generation (created before the on-by-default change, or turned off)
    // starts off.
    if (toggle.getAttribute("aria-checked") !== "false") {
      throw new Error("consent switch must start off for a workspace without a generation");
    }

    await userEvent.click(toggle);
    // The mock acks like the backend does — by publishing metadata — and only then may the
    // switch report "on". Asserting through waitFor keeps the contract: no optimistic flip.
    await waitFor(() => {
      if (
        within(dialog)
          .getByRole("switch", { name: CONSENT_SWITCH_NAME })
          .getAttribute("aria-checked") !== "true"
      ) {
        throw new Error("switch did not follow the published consent metadata");
      }
    });
    if (
      within(dialog).getByRole("switch", { name: CONSENT_SWITCH_NAME }).hasAttribute("disabled")
    ) {
      throw new Error("switch stayed locked after the backend acknowledged");
    }
    // Leave the dialog open (switch on) for the visual baseline.
  },
};

const PHONE_WIDTH = 390;

function PhoneDecorator(Story: ComponentType) {
  return (
    <div
      data-consent-phone-width={PHONE_WIDTH}
      style={{ width: PHONE_WIDTH, height: 844, overflow: "hidden" }}
    >
      <Story />
    </div>
  );
}

/**
 * Phone-width contract: the disclosure copy wraps inside a 390px dialog with the switch still
 * reachable. Pinned to the Pixel phone viewport with a matching 390px viewport; the dialog
 * portals to document.body, so containment is measured against the window rather than the
 * decorator frame, after checking the rendered frame width.
 */
export const Phone390: AppStory = {
  ...Desktop,
  globals: { viewport: { value: "consentPhone", isRotated: false } },
  decorators: [PhoneDecorator],
  parameters: {
    ...appMeta.parameters,
    viewport: {
      options: {
        consentPhone: {
          name: "Phone 390",
          styles: { width: `${PHONE_WIDTH}px`, height: "844px" },
          type: "mobile",
        },
      },
    },
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  play: async (context) => {
    await Desktop.play?.(context);
    const frame = context.canvasElement.querySelector<HTMLElement>("[data-consent-phone-width]");
    if (!frame) throw new Error("phone frame decorator did not render");
    if (frame.getBoundingClientRect().width !== PHONE_WIDTH) {
      throw new Error(
        `phone frame is ${frame.getBoundingClientRect().width}px wide; expected ${PHONE_WIDTH}px`
      );
    }
    // Only a genuinely narrow viewport (manager/Pixel phone) constrains the portaled dialog;
    // the desktop-sized test-runner cannot, so the fit assertion is guarded on it.
    if (window.innerWidth <= PHONE_WIDTH) {
      const dialog = within(document.body).getByRole("dialog", {
        name: "Messages from other workspaces",
      });
      for (const element of [dialog, ...dialog.querySelectorAll<HTMLElement>("*")]) {
        const rect = element.getBoundingClientRect();
        if (rect.right > window.innerWidth + 1 || rect.left < -1) {
          throw new Error(
            `consent dialog content overflowed the ${window.innerWidth}px viewport (${Math.round(rect.left)}..${Math.round(rect.right)})`
          );
        }
      }
    }
  },
};
