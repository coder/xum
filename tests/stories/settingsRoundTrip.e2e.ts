/**
 * Story: a chat survives trips through Settings. The user sends a message and gets the reply,
 * then opens Settings, visits Models and Providers, and closes it, once by the agent and three
 * more times by exact steps (no model calls). Closing Settings returns to the route it opened
 * from (RouterContext navigateFromSettings), so the chat, its reply and a working message box
 * must still be there. It replaces the Playwright tests "chat history survives settings
 * navigation" (tests/e2e/scenarios/persistence.spec.ts) and "survives rapid settings navigation"
 * (tests/e2e/scenarios/windowLifecycle.spec.ts).
 */
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials, WORKSPACE_TITLE } from "../bugbash/repros/helpers";

const MESSAGE = "water the herbs";
// The mock AI's default reply (mockAiRouter.ts).
const REPLY = `Mock response: ${MESSAGE}`;

test(
  "a chat survives trips through Settings",
  { tags: ["story"], timeout: 600_000 },
  async ({ app, agent, browser, screen }) => {
    // e2e has no `log` role query, so CSS: the transcript is ChatPane's role="log" element.
    const transcript = browser.locator('[role="log"][aria-label="Conversation transcript"]');
    const settings = screen.getByRole("dialog", "Settings");

    await disableTutorials(app);
    await app.open();
    await agent.act(`open the '${WORKSPACE_TITLE}' workspace in the left sidebar`);
    await agent.act(`send the chat message '${MESSAGE}' and wait for the reply`);
    await expect(transcript).toContainText(REPLY, { timeout: 30_000 });

    await agent.act(
      "open Settings, open its Models section, then its Providers section, then close Settings"
    );
    await expect(settings).not.toBeVisible();
    // The button names of SettingsButton.tsx and SettingsPage.tsx.
    for (let i = 0; i < 3; i++) {
      await screen.getByTestId("settings-button").tap();
      await expect(settings).toBeVisible();
      await settings.getByRole("button", "Providers").tap();
      await settings.getByRole("button", "Models").tap();
      await settings.getByRole("button", "Close settings").tap();
      await expect(settings).not.toBeVisible();
    }

    await expect(transcript).toContainText(REPLY);
    const message = screen.getByRole("textbox", "Message");
    await expect(message).toBeVisible();
    await message.tap();
    await expect(message).toBeFocused();
    await agent.assert(
      `the chat of the '${WORKSPACE_TITLE}' workspace is open and shows the reply '${REPLY}'`
    );
  }
);
