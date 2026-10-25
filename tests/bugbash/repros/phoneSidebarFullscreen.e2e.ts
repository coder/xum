// Bug bash of the phone full-screen sidebar (the workspace actions menu's Sidebar row shows the
// hidden right sidebar full-screen). Each test fails on the defect the bug bash found.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

test(
  "Tab stays inside the full-screen sidebar at phone width",
  { tags: ["bugbash", "phone-sidebar-fullscreen"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await openPlayground(app, screen, browser);

    await screen.getByRole("button", "Workspace actions").tap();
    await screen.getByRole("button", "Sidebar").tap();
    await expect(screen.getByRole("button", "Close sidebar")).toBeVisible();

    // The view covers the whole page, so every Tab stop must be one of its own controls (or the
    // page itself, between the last control and the browser's own UI). Before the fix only the
    // chat pane went inert, and Tab reached the hidden left sidebar and footer behind the view.
    const escapes: string[] = [];
    for (let i = 0; i < 25; i++) {
      await browser.keyboard.press("Tab");
      const outside = await browser.evaluate(() => {
        const el = document.activeElement;
        if (el == null || el === document.body) return null;
        if (el.closest('[aria-label="Workspace insights"]') != null) return null;
        return `${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? ""}"`;
      });
      if (outside != null) escapes.push(outside);
    }
    expect(escapes).toEqual([]);
  }
);

test(
  "Side chat is reachable from the workspace actions menu at phone width",
  { tags: ["bugbash", "phone-sidebar-fullscreen"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await openPlayground(app, screen, browser);

    // The bug bash found Side chat missing at phone width. The menu's Sidebar row shows the
    // sidebar, and its New tab launcher lists Side chat with the tools.
    await screen.getByRole("button", "Workspace actions").tap();
    await screen.getByRole("button", "Sidebar").tap();
    await screen.getByRole("button", "New tab").tap();
    await expect(screen.getByRole("button", "Side chat")).toBeVisible();
  }
);
