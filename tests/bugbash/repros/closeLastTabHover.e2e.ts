// PR #7189 UAT: closing the right sidebar's last tab with the mouse collapses the sidebar, and the
// chat header's buttons slide right under the pointer that rests on the tab's X. Chromium fires
// pointerenter, but no pointermove, on a button that moves under a still pointer, so the skills
// indicator's hover popover opened and took focus from the sidebar toggle.
import type { Browser } from "@e2e-dev/web";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

/** The header toggle's label: "Expand right sidebar" while collapsed, "Collapse ..." while open. */
function toggleLabel(browser: Browser): Promise<string | null> {
  return browser.evaluate(
    () =>
      document
        .querySelector('[data-testid="right-sidebar-toggle-bar"] button')
        ?.getAttribute("aria-label") ?? null
  );
}

test(
  "closing the last sidebar tab with the mouse opens no hover popover under the pointer",
  { tags: ["bugbash", "close-last-tab-hover"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    if ((await toggleLabel(browser)) === "Expand right sidebar") {
      await screen.getByRole("button", "Expand right sidebar").tap();
    }
    // A fresh context's layout is the lone New tab. Its X sits where the skills button slides
    // through when the header widens.
    await screen.getByRole("button", "Close New tab").tap();
    await expect.poll(() => toggleLabel(browser)).toBe("Expand right sidebar");
    // The slide takes 200 ms; a popover it opened takes focus shortly after.
    await browser.evaluate(
      () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 600))
    );
    await expect(screen.getByRole("button", "Expand right sidebar")).toBeFocused();
    expect(await browser.evaluate(() => document.querySelector('[role="dialog"]') === null)).toBe(
      true
    );
  }
);
