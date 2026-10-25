// Bug bash (artifact versions branch): after Reload artifact, an HTML page restarted with the
// window.xum.state of the panel's last load, so a pick made since then was lost (and a cleared
// one came back). Proves Reload hands the frame the state the page saved last.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

/** startApp.ts seeds options.html with stored versions; its checkboxes call setState. */
const FRAME = 'iframe[data-testid="artifact-frame"]';

test(
  "Reload artifact keeps the state the page saved last",
  { tags: ["bugbash", "artifact-state-reload"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    await screen.getByRole("textbox", "Message").tap();
    await browser.keyboard.press("Control+Shift+K");
    await screen.getByRole("combobox", "Artifact").tap();
    await screen.getByRole("option", "options.html").tap();

    const page = browser.frameLocator(FRAME);
    await expect(page.getByText("Options v2")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("saved: null")).toBeVisible();
    await page.getByText("LRU").tap();
    await expect(page.getByText('saved: {"lru":true,"ttl":false}')).toBeVisible();

    await screen.getByRole("button", "Reload artifact").tap();
    await expect(page.getByText("Options v2")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('saved: {"lru":true,"ttl":false}')).toBeVisible();
  }
);
