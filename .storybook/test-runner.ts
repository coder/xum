import type { TestRunnerConfig } from "@storybook/test-runner";
import { expect } from "@playwright/test";

// Real :hover for the primary-button contrast stories (#6022). A play runs inside the page and
// cannot set :hover, so only stories under this id prefix get two page-level helpers backed by
// Playwright. All other stories run exactly as before.
const HOVER_STORY_PREFIX = "app-primarybuttoncontrast--";
const hoverReady = new WeakSet<object>();

const config: TestRunnerConfig = {
  async preVisit(page, context) {
    // exposeFunction throws on a second registration, so register once per Playwright page.
    if (!context.id.startsWith(HOVER_STORY_PREFIX) || hoverReady.has(page)) return;
    hoverReady.add(page);
    await page.exposeFunction("__storybookHover", (selector: string) => page.hover(selector));
    await page.exposeFunction("__storybookUnhover", () => page.mouse.move(0, 0));
  },
  async postVisit(page, context) {
    if (context.id !== "app-rightsidebar-stable-tab-controls--narrow") return;
    if (page.context().browser()?.browserType().name() !== "chromium") return;
    // Story plays dispatch synthetic events: only browser input can exercise native touch
    // panning (and catch touch-action or drag listeners swallowing a swipe over a tab label).
    const client = await page.context().newCDPSession(page);
    const viewport = page.viewportSize();
    const row = page.getByRole("tablist");
    const tabs = row.getByRole("tab");
    const initialOrder = await tabs.evaluateAll((elements) => elements.map((el) => el.id));
    try {
      await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      for (const width of [1200, 375]) {
        // A visible-sidebar tablet and a phone viewport, both with a narrow overflowing strip.
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches))
          .toBe(true);
        await tabs.first().click();
        await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
        const before = await row.evaluate((el) => el.scrollLeft);
        // Two short gestures normally reveal the last tab; bound retries without panning all
        // the way to the strip's end, keeping this regression inside the normal CI timeout.
        for (let swipe = 0; swipe < 4; swipe++) {
          const point = await row.evaluate((el) => {
            const r = el.getBoundingClientRect();
            for (const tab of Array.from(el.querySelectorAll('[role="tab"]')).reverse()) {
              const label = tab.querySelector("span.truncate") ?? tab.firstElementChild!;
              const b = label.getBoundingClientRect();
              const left = Math.max(b.left, r.left + 24);
              const right = Math.min(b.right, r.right - 24);
              if (right - left > 30) {
                const x = (left + right) / 2;
                return { x, y: b.top + b.height / 2, xDistance: -Math.min(180, x - r.left - 8) };
              }
            }
            throw new Error("No tab label available to swipe");
          });
          await client.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x: point.x, y: point.y }],
          });
          for (let step = 1; step <= 3; step++) {
            await client.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: point.x + (point.xDistance * step) / 3, y: point.y }],
            });
            // Deliver moves across rendered frames, like a finger, without time-based sleeps.
            await page.evaluate(
              () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
            );
          }
          await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          const reachedLastTab = await row.evaluate((el) => {
            const last = Array.from(el.querySelectorAll('[role="tab"]')).at(-1);
            if (!last) return false;
            const bounds = el.getBoundingClientRect();
            const tapX = last.getBoundingClientRect().left + 20;
            return tapX >= bounds.left && tapX < bounds.right;
          });
          if (reachedLastTab) break;
        }
        await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before + 50);
        await expect(tabs.evaluateAll((elements) => elements.map((el) => el.id))).resolves.toEqual(
          initialOrder
        );
        // An initially offscreen tab is now hit-testable and selectable without programmatic scrolling.
        const last = await tabs.last().boundingBox();
        const bounds = await row.boundingBox();
        if (!last || !bounds) throw new Error("Scrolled tab is missing");
        expect(last.x + 20).toBeGreaterThanOrEqual(bounds.x);
        expect(last.x + 20).toBeLessThan(bounds.x + bounds.width);
        await client.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: last.x + 20, y: last.y + last.height / 2 }],
        });
        await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
      }

      // The same surface must still support the existing distance-activated mouse reorder.
      await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await page.setViewportSize({ width: 1200, height: 900 });
      await tabs.first().click();
      const first = await tabs.first().boundingBox();
      const second = await tabs.nth(1).boundingBox();
      if (!first || !second) throw new Error("Reorder targets missing");
      await page.mouse.move(first.x + 20, first.y + first.height / 2);
      await page.mouse.down();
      await page.mouse.move(first.x + 32, first.y + first.height / 2, { steps: 3 });
      await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, {
        steps: 12,
      });
      await page.mouse.up();
      await expect
        .poll(() => tabs.evaluateAll((elements) => elements.map((el) => el.id)))
        .toEqual([initialOrder[1], initialOrder[0], ...initialOrder.slice(2)]);
    } finally {
      await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await client.detach();
      if (viewport) await page.setViewportSize(viewport);
    }
  },
};

export default config;
