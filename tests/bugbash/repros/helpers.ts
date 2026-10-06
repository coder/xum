/**
 * Shared steps for bug-bash repro tests (tests/bugbash/repros/*.e2e.ts).
 *
 * Repro tests use exact `screen`/`expect` steps only, so they run without a model key and give the
 * same result on every run. startApp.ts seeds one project (demo-app) and one workspace per run.
 */
import type { Browser } from "@e2e-dev/web";
import type { Locator, Screen } from "e2e";
import { expect } from "e2e";
import { TUTORIAL_STATE_KEY } from "../../../src/common/constants/storage";

export const WORKSPACE_TITLE = "Bug bash playground";

/**
 * Switches tutorials off from the next page load on (a fresh context would show one over the
 * workspace). Tutorial repros skip this helper.
 */
export async function disableTutorials(browser: Browser): Promise<void> {
  await browser.addInitScript(
    (key: string) => localStorage.setItem(key, JSON.stringify({ disabled: true, completed: {} })),
    TUTORIAL_STATE_KEY
  );
}

/**
 * Sends `text` from the composer and returns the Edit button of that message. Every repro in one
 * run shares the seeded workspace, so pick a text no other repro sends: other repros' messages
 * have Edit buttons too.
 */
/**
 * Sends a chat message with the Send button and waits until the composer has taken it. Pressing
 * Enter right after `fill` can arrive before the composer is ready (seen on the phone target).
 */
export async function sendMessage(screen: Screen, text: string): Promise<void> {
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill(text);
  await screen.getByRole("button", "Send message").tap();
  await expect(composer).toHaveValue("", { timeout: 15_000 });
}

export async function sendMessageForEdit(
  screen: Screen,
  browser: Browser,
  text: string
): Promise<Locator> {
  await sendMessage(screen, text);
  const edit = browser
    .locator("[data-message-block]")
    .filter({ hasText: text })
    .getByRole("button", "Edit");
  // The Edit action shows once the backend has accepted the send.
  await expect(edit).toBeVisible({ timeout: 20_000 });
  return edit;
}

/** Opens the app with tutorials off and selects the seeded workspace. */
export async function openPlayground(
  app: { open(path?: string): Promise<void> },
  screen: Screen,
  browser: Browser
): Promise<void> {
  await disableTutorials(browser);
  await app.open();
  // A fresh context starts with the project collapsed in the sidebar.
  const expand = screen.getByRole("button", "Expand project demo-app");
  await expect(screen.getByText("demo-app").first()).toBeVisible({ timeout: 15_000 });
  // The phone layout hides the sidebar behind a menu button.
  const sidebarMenu = screen.getByRole("button", "Open sidebar menu");
  if (await sidebarMenu.isVisible()) {
    await sidebarMenu.tap();
    await expect(screen.getByRole("navigation", "Projects").getByText("demo-app")).toBeVisible();
  }
  if (await expand.isVisible()) await expand.tap();
  await screen.getByText(WORKSPACE_TITLE).first().tap();
  await expect(screen.getByRole("button", "Notifications")).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Asserts the "Notify on all responses" setting: opens the bell's settings popover, reads the
 * checkbox, and closes it with Escape. A click on the bell only opens the popover (#5691).
 */
export async function expectNotifyOnAllResponses(
  screen: Screen,
  browser: Browser,
  checked: boolean
): Promise<void> {
  await screen.getByRole("button", "Notifications").tap();
  const setting = screen.getByRole("checkbox", /^Notify on all responses/);
  await expect(setting).toBeVisible();
  if (checked) {
    await expect(setting).toBeChecked();
  } else {
    await expect(setting).not.toBeChecked();
  }
  await browser.keyboard.press("Escape");
  await expect(setting).toBeHidden();
}
