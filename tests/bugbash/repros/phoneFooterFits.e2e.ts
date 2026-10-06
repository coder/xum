// #5769: at phone width the workspace footer was wider than the screen, so its right end (the
// branch and "Last prompt") was cut off. Proves the footer row fits its width.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground, sendMessage } from "./helpers";

test(
  "Workspace footer fits a phone-width screen",
  { tags: ["bugbash", "5769"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await openPlayground(app, screen, browser);
    // The footer adds its token count and "Last prompt" once the chat has a message.
    await sendMessage(screen, "Footer width check at phone size");
    await expect(screen.getByText("Last prompt").first()).toBeVisible({ timeout: 20_000 });

    // Overflow in px of the footer's row; -1 while the footer is not rendered yet.
    await expect
      .poll(() =>
        browser.evaluate(() => {
          const row = document.querySelector('[data-testid="workspace-footer-bar"] > div');
          return row ? row.scrollWidth - row.clientWidth : -1;
        })
      )
      .toBe(0);
  }
);
