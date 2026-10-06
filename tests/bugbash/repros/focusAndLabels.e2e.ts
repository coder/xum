// #5681, #5687, #5688, #5693: keyboard focus, labels and shortcut feedback. Each test fails on
// the old code.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials, openPlayground } from "./helpers";

test(
  "Ctrl+I focuses the composer on the new-workspace screen",
  { tags: ["bugbash", "5687"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await disableTutorials(browser);
    await app.open();
    const composer = screen.getByRole("textbox", "Message");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    // The screen opens with the composer focused, so move focus away first.
    await browser.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      return null;
    });
    await expect(composer).not.toBeFocused();

    await browser.keyboard.press("Control+i");
    await expect(composer).toBeFocused();
  }
);

test(
  "The right sidebar's collapse button shows a focus ring",
  { tags: ["bugbash", "5688"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    const collapse = screen
      .getByRole("complementary", "Workspace insights")
      .getByRole("button", "Collapse sidebar");
    await expect(collapse).toBeVisible();
    // A key press first, so the browser treats the next focus as keyboard focus (:focus-visible).
    await browser.keyboard.press("Shift");
    await collapse.focus();

    await expect
      .poll(() =>
        browser.evaluate(() => {
          const el = document.activeElement;
          if (!(el instanceof HTMLElement) || !el.matches(":focus-visible"))
            return "no focus-visible";
          return getComputedStyle(el).boxShadow;
        })
      )
      .not.toMatch(/^(none|no focus-visible)$/);
  }
);

test(
  "The workspace actions tooltip uses the button's accessible name",
  { tags: ["bugbash", "5681"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    await screen.getByRole("button", "Workspace actions").hover();

    await expect(screen.getByRole("tooltip")).toHaveText("Workspace actions");
  }
);

test(
  "The fast mode shortcut explains why fast mode is unavailable",
  { tags: ["bugbash", "5693"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    // The seeded Anthropic provider uses a loopback base URL, so fast mode is unavailable.
    await openPlayground(app, screen, browser);
    await screen.getByRole("textbox", "Message").tap();

    await browser.keyboard.press("Control+Shift+F");
    await expect(screen.getByText(/^Fast mode is not available/)).toBeVisible();
  }
);
