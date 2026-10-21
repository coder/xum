/**
 * Exact steps that the stories share, on web and on Electron. On Electron every attempt starts a
 * new Xum Electron on the one seeded XUM_ROOT, so the UI state that an earlier story left (an
 * expanded project, an open page) is still there. On web a fresh context starts with the project
 * collapsed, and a story can expand it. These steps work from either state.
 */
import type { Screen } from "e2e";
import { expect } from "e2e";
import { WORKSPACE_TITLE } from "../bugbash/repros/helpers";

/** Waits until the sidebar lists the seeded project: the app has loaded its projects. */
export async function waitForProjects(screen: Screen): Promise<void> {
  await expect(
    screen.getByRole("navigation", "Projects").getByText("demo-app").first()
  ).toBeVisible({ timeout: 30_000 });
}

/** Opens the seeded workspace, and waits until its header shows. */
export async function openPlayground(screen: Screen): Promise<void> {
  await waitForProjects(screen);
  // A fresh root starts with the project collapsed; an earlier story can leave it expanded.
  const expand = screen.getByRole("button", "Expand project demo-app");
  if (await expand.isVisible()) await expand.tap();
  await screen.getByRole("navigation", "Projects").getByText(WORKSPACE_TITLE).first().tap();
  // The workspace header's bell shows only once a workspace is open (repros/helpers.ts).
  await expect(screen.getByRole("button", "Notifications")).toBeVisible({ timeout: 15_000 });
}
