// #6102: at phone width, the collapsed left sidebar is moved off-screen, but its "Expand sidebar"
// button still took a Tab stop: keyboard focus landed on a button nobody could see.
// Proves that Tab from the composer, past the footer and around to "Open sidebar menu", never
// focuses an element outside the screen.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

/** The focused element: its accessible label and whether most of it lies outside the screen. */
interface FocusStop {
  // browser.evaluate() returns JSON values only, and a JSON object needs an index signature.
  [key: string]: string | boolean;
  label: string;
  offScreen: boolean;
}

test(
  "Tab at phone width never focuses the off-screen collapsed sidebar",
  { tags: ["bugbash", "6102"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    // At phone width, picking the workspace closes the sidebar drawer again.
    await openPlayground(app, screen, browser);
    const menu = screen.getByRole("button", "Open sidebar menu");
    await expect(menu).toBeVisible();
    // Wait until the closed drawer is fully off the screen and no transition runs in it or its
    // controls: closing during the opening slide shortens the slide but not a delayed change, and
    // a control with `transition-all` also animates the visibility it inherits.
    await expect
      .poll(() =>
        browser.evaluate(() => {
          const drawer = document.querySelector('[data-testid="left-sidebar"]');
          if (drawer?.getAnimations({ subtree: true }).length !== 0)
            return Number.POSITIVE_INFINITY;
          return drawer.getBoundingClientRect().right;
        })
      )
      .toBeLessThanOrEqual(0);

    await screen.getByRole("textbox", "Message").focus();
    const stops: FocusStop[] = [];
    // The Tab order from the composer runs through the composer controls and the footer, then
    // wraps to the start of the page. Stop at the menu button, the first expected stop there.
    for (let i = 0; i < 60; i++) {
      await browser.keyboard.press("Tab");
      const stop = await browser.evaluate((): FocusStop => {
        const el = document.activeElement;
        if (!(el instanceof HTMLElement) || el === document.body) {
          return { label: "(body)", offScreen: false };
        }
        const box = el.getBoundingClientRect();
        const shown = Math.min(box.right, window.innerWidth) - Math.max(box.left, 0);
        return {
          label: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? el.tagName,
          offScreen: box.width > 0 && shown < box.width / 2,
        };
      });
      stops.push(stop);
      if (stop.label === "Open sidebar menu") break;
    }
    const labels = stops.map((s) => s.label);
    expect(labels, JSON.stringify(labels)).toContain("Open sidebar menu");
    expect(stops.filter((s) => s.offScreen).map((s) => s.label)).toEqual([]);
  }
);
