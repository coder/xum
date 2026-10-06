/**
 * Shared steps for bug-bash repro tests (tests/bugbash/repros/*.e2e.ts).
 *
 * Repro tests use exact `screen`/`expect` steps only, so they run without a model key and give the
 * same result on every run. startApp.ts seeds one project (demo-app) and one workspace per run.
 */
import type { Browser } from "@e2e-dev/web";
import type { Screen } from "e2e";
import { expect } from "e2e";
import { TUTORIAL_STATE_KEY } from "../../../src/common/constants/storage";

export const WORKSPACE_TITLE = "Bug bash playground";

/**
 * Opens the app and selects the seeded workspace. Tutorials are switched off before the page
 * loads (a fresh context would show one over the workspace); tutorial repros skip this helper.
 */
export async function openPlayground(
  app: { open(path?: string): Promise<void> },
  screen: Screen,
  browser: Browser
): Promise<void> {
  await browser.addInitScript(
    (key: string) => localStorage.setItem(key, JSON.stringify({ disabled: true, completed: {} })),
    TUTORIAL_STATE_KEY
  );
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
  await expect(screen.getByRole("button", "Notify on all responses")).toBeVisible({
    timeout: 15_000,
  });
}
