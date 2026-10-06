// #5767: at phone width the right sidebar is hidden, and with it the only way to open Stats.
// Proves the workspace actions menu opens Stats in a dialog there.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

test(
  "Stats opens from the workspace actions menu at phone width",
  { tags: ["bugbash", "5767"] },
  async ({ app, screen, browser }) => {
    // The phone target's width, set here so the repro runs the same on every target: on a wide
    // screen Stats is a tab of the visible sidebar.
    await browser.setViewport({ width: 390, height: 844 });
    await openPlayground(app, screen, browser);

    await screen.getByRole("button", "Workspace actions").tap();
    // Its name includes the shortcut where shortcuts show, e.g. "Stats (Shift+S)".
    const stats = screen.getByRole("button", /^Stats\b/);
    await expect(stats).toBeVisible();
    await stats.tap();
    await expect(screen.getByRole("dialog", "Stats")).toBeVisible();
  }
);
