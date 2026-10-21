// #5701: Escape did not close the tutorial bubble, and the bubble (with its spotlighted model
// chip) drew on top of a Settings dialog opened while it showed. The bubble now sits under every
// layer the user opens, owns focus while nothing covers it, and closes on its own Escape.
import type { Browser } from "@e2e-dev/web";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials, resetTutorials } from "./helpers";

const FIRST_STEP_TITLE = "Choose Your Model";

/**
 * True when the element that `css` (and, if given, its exact text) matches is the topmost painted
 * element at its own center. Playwright's visibility checks ignore stacking order. Radix turns
 * pointer events off outside an open modal, and hit tests skip such elements, so the probe turns
 * them on for this element during one synchronous check and then restores them.
 */
async function paintsOnTop(browser: Browser, css: string, text?: string): Promise<boolean> {
  return browser.evaluate(
    ([selector, exactText]: [string, string | null]) => {
      const el = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
        (candidate) => exactText === null || candidate.textContent === exactText
      );
      if (!el) throw new Error(`no element matches ${selector} ${exactText ?? ""}`);
      const box = el.getBoundingClientRect();
      const previous = el.style.pointerEvents;
      el.style.pointerEvents = "auto";
      try {
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return top !== null && el.contains(top);
      } finally {
        el.style.pointerEvents = previous;
      }
    },
    [css, text ?? null] as [string, string | null]
  );
}

test(
  "Escape closes the tutorial bubble",
  { tags: ["bugbash", "5701"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    // The app opens on the project's creation form, which starts the creation tutorial.
    await resetTutorials(app);
    try {
      await app.open();
      const title = screen.getByText(FIRST_STEP_TITLE, { exact: true });
      await expect(title).toBeVisible({ timeout: 15_000 });

      await browser.keyboard.press("Escape");
      await expect(title).toBeHidden();
    } finally {
      // Later repros in this run expect no tutorial.
      await disableTutorials(app);
    }
  }
);

test(
  "Settings opened during a tutorial draws over it and takes Escape first",
  { tags: ["bugbash", "5701"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await resetTutorials(app);
    try {
      await app.open();
      const title = screen.getByText(FIRST_STEP_TITLE, { exact: true });
      await expect(title).toBeVisible({ timeout: 15_000 });

      // The bug bash opened Settings with its shortcut and went to Agents (/settings/tasks).
      await browser.keyboard.press("Control+,");
      const settings = screen.getByRole("dialog", "Settings");
      await expect(settings).toBeVisible();
      await settings.getByRole("button", "Agents").tap();

      // Neither the bubble nor the spotlighted model chip may draw over the dialog.
      await expect.poll(() => paintsOnTop(browser, "h3", FIRST_STEP_TITLE)).toBe(false);
      await expect.poll(() => paintsOnTop(browser, '[data-tutorial="model-selector"]')).toBe(false);

      // The first Escape closes Settings and leaves the tutorial, the second closes the tutorial.
      await browser.keyboard.press("Escape");
      await expect(settings).toBeHidden();
      await expect(title).toBeVisible();
      await browser.keyboard.press("Escape");
      await expect(title).toBeHidden();
    } finally {
      await disableTutorials(app);
    }
  }
);
