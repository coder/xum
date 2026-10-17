import type { TestRunnerConfig } from "@storybook/test-runner";
// This hook is reloaded between Jest suites in the same worker. Importing @playwright/test
// initializes a second test runner and fails on reload; use browser waits and Node assertions.
import assert from "node:assert/strict";
import { MOBILE_TOUCH_TARGET_PX } from "../src/constants/layout";

// Real :hover for the primary-button contrast stories (#6022). A play runs inside the page and
// cannot set :hover, so only stories under this id prefix get two page-level helpers backed by
// Playwright. All other stories run exactly as before.
const HOVER_STORY_PREFIX = "app-primarybuttoncontrast--";
const hoverReady = new WeakSet<object>();
// The Narrow story's strip scrolls up to 621 px, and the shortest swipe seen moved it 56 px:
// 16 swipes cover it with room to spare.
const MAX_TOUCH_SWIPES = 16;

type StoryPage = Parameters<NonNullable<TestRunnerConfig["postVisit"]>>[0];

const PHONE_FOOTER_TOUCH_STORY = "app-phoneviewports-overflow--footer-touch-targets";

/**
 * On a phone with a coarse pointer, globals.css raises every footer control to a touch target,
 * and the branch gets only the width the rest of the row leaves. A full row on the narrowest
 * phone must truncate labels, never clip a control: a clipped target is hidden or partly hidden
 * but still takes taps. Plays cannot emulate the pointer.
 */
async function assertPhoneFooterTouchTargets(page: StoryPage) {
  const client = await page.context().newCDPSession(page);
  const viewport = page.viewportSize();
  try {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await page.setViewportSize({ width: 320, height: 700 });
    await page.waitForFunction(() => matchMedia("(pointer: coarse)").matches, undefined, {
      timeout: 5000,
    });
    const row = page.locator('[data-testid="workspace-footer-bar"] > div');
    // Phones drop the drift mode label, so once it is gone the row has its phone layout.
    await row
      .getByRole("button", { name: "Lines", exact: true })
      .waitFor({ state: "detached", timeout: 5000 });
    const problems = await row.evaluate((rowElement, minTarget) => {
      const found: string[] = [];
      for (const target of rowElement.querySelectorAll<HTMLElement>("button, a")) {
        const box = target.getBoundingClientRect();
        // Not displayed at this width.
        if (box.width === 0) continue;
        const name = target.getAttribute("aria-label") ?? target.textContent ?? target.tagName;
        if (box.width < minTarget) found.push(`${name} is ${Math.round(box.width)}px wide`);
        let left = box.left;
        let right = box.right;
        for (let el = target.parentElement; el; el = el.parentElement) {
          if (getComputedStyle(el).overflowX !== "visible") {
            const clip = el.getBoundingClientRect();
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
          }
          if (el === rowElement) break;
        }
        const visible = Math.max(0, right - left);
        if (visible < box.width - 0.5) {
          found.push(`${name} shows ${Math.round(visible)} of ${Math.round(box.width)}px`);
        }
      }
      return found;
    }, MOBILE_TOUCH_TARGET_PX);
    // Compare a string: the page's array has another realm's prototype, so deepEqual always fails.
    assert.equal(problems.join("; "), "", "Footer touch targets must stay whole on a small phone");
  } finally {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await client.detach();
    if (viewport) await page.setViewportSize(viewport);
  }
}

const config: TestRunnerConfig = {
  async preVisit(page, context) {
    // exposeFunction throws on a second registration, so register once per Playwright page.
    if (!context.id.startsWith(HOVER_STORY_PREFIX) || hoverReady.has(page)) return;
    hoverReady.add(page);
    await page.exposeFunction("__storybookHover", (selector: string) => page.hover(selector));
    await page.exposeFunction("__storybookUnhover", () => page.mouse.move(0, 0));
  },
  async postVisit(page, context) {
    if (context.id === PHONE_FOOTER_TOUCH_STORY) {
      if (page.context().browser()?.browserType().name() === "chromium") {
        await assertPhoneFooterTouchTargets(page);
      }
      return;
    }
    if (context.id === "app-rightsidebar-stable-tab-controls--wide") {
      if (page.context().browser()?.browserType().name() !== "chromium") return;
      // A tablet (coarse pointer above the phone breakpoint) gets no global 44px button floor,
      // so the collapse button must size itself for touch. Plays cannot emulate the pointer.
      const client = await page.context().newCDPSession(page);
      const viewport = page.viewportSize();
      try {
        await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
        await page.setViewportSize({ width: 1200, height: 900 });
        await page.waitForFunction(() => matchMedia("(pointer: coarse)").matches, undefined, {
          timeout: 5000,
        });
        const box = await page.getByRole("button", { name: "Collapse sidebar" }).boundingBox();
        if (!box) throw new Error("Collapse sidebar button is missing");
        assert(
          box.width >= 44 && box.height >= 44,
          `Collapse target is ${box.width}x${box.height}`
        );
      } finally {
        await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
        await client.detach();
        if (viewport) await page.setViewportSize(viewport);
      }
      return;
    }
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
        await page.waitForFunction(() => matchMedia("(pointer: coarse)").matches, undefined, {
          timeout: 5000,
        });
        await tabs.first().click();
        await tabs.first().and(page.locator('[aria-selected="true"]')).waitFor({ timeout: 5000 });
        const before = await row.evaluate((el) => el.scrollLeft);
        // Wait for native scroll completion: a tap during inertial scrolling cancels the
        // scroll instead of selecting the tab, especially under parallel CI load.
        // Swipe until the last tab is reachable. How far one swipe scrolls depends on the
        // runner: Chromium adds a fling only when the moves arrive fast. Without one, the phone
        // width needed all four swipes of the old fixed count, so one disturbed swipe failed the
        // check (#6476). A strip that does not pan still fails at its first swipe: no scrollend.
        for (let swipe = 0; swipe < MAX_TOUCH_SWIPES; swipe++) {
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
          await row.evaluate((el) => {
            el.removeAttribute("data-scroll-settled");
            el.addEventListener("scrollend", () => el.setAttribute("data-scroll-settled", ""), {
              once: true,
            });
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
            await page.evaluate(
              () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
            );
          }
          await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await row.and(page.locator("[data-scroll-settled]")).waitFor({ timeout: 5000 });
          const reachedLastTab = await row.evaluate((el) => {
            const last = Array.from(el.querySelectorAll('[role="tab"]')).at(-1);
            if (!last) return false;
            const bounds = el.getBoundingClientRect();
            const tapX = last.getBoundingClientRect().left + 20;
            return tapX >= bounds.left && tapX < bounds.right;
          });
          if (reachedLastTab) break;
        }
        await page.waitForFunction(
          (start) => (document.querySelector('[role="tablist"]')?.scrollLeft ?? 0) > start + 50,
          before,
          { timeout: 5000 }
        );
        assert.deepEqual(
          await tabs.evaluateAll((elements) => elements.map((el) => el.id)),
          initialOrder,
          "Touch panning must not reorder tabs"
        );
        // An initially offscreen tab is now hit-testable and selectable without programmatic scrolling.
        const last = await tabs.last().boundingBox();
        const bounds = await row.boundingBox();
        if (!last || !bounds) throw new Error("Scrolled tab is missing");
        assert(last.x + 20 >= bounds.x, "Last tab must be inside the left edge");
        assert(last.x + 20 < bounds.x + bounds.width, "Last tab must be inside the right edge");
        await client.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: last.x + 20, y: last.y + last.height / 2 }],
        });
        await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await tabs.last().and(page.locator('[aria-selected="true"]')).waitFor({ timeout: 5000 });
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
      await page.waitForFunction(
        (expected) => {
          const actual = Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]'));
          return (
            actual.length === expected.length && actual.every((tab, i) => tab.id === expected[i])
          );
        },
        [initialOrder[1], initialOrder[0], ...initialOrder.slice(2)],
        { timeout: 5000 }
      );
    } finally {
      await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await client.detach();
      if (viewport) await page.setViewportSize(viewport);
    }
  },
};

export default config;
