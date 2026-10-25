import type { TestRunnerConfig } from "@storybook/test-runner";
// This hook is reloaded between Jest suites in the same worker. Importing @playwright/test
// initializes a second test runner and fails on reload; use browser waits and Node assertions.
import assert from "node:assert/strict";
import { MOBILE_TOUCH_TARGET_PX, TABLET_TOUCH_TARGET_PX } from "../src/constants/layout";

// Real :hover for the primary-button contrast stories (#6022). A play runs inside the page and
// cannot set :hover, so only stories under this id prefix get two page-level helpers backed by
// Playwright. All other stories run exactly as before.
const HOVER_STORY_PREFIX = "app-primarybuttoncontrast--";
const hoverReady = new WeakSet<object>();
// The Narrow story's strip scrolls up to 669 px, and the shortest swipe seen moved it 56 px:
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

const TOUCH_RESIZE_STORY = "app-seededworkspacea11y--narrow-sidebar-dark";

/**
 * A finger must drag the right sidebar's resize handle: a touch drag fires no mouse events, and
 * iPads report a coarse pointer even with a trackpad. Plays dispatch synthetic events, so only
 * browser input proves the handle takes a touch drag (and that the page does not pan instead).
 */
async function assertTouchResizesRightSidebar(page: StoryPage) {
  const client = await page.context().newCDPSession(page);
  const viewport = page.viewportSize();
  // The drag persists the new width; restore storage for the stories that run after this one.
  const storage = await page.evaluate(() => Object.entries(localStorage));
  const sidebar = page.getByRole("complementary", { name: "Workspace insights" });
  try {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForFunction(() => matchMedia("(pointer: coarse)").matches, undefined, {
      timeout: 5000,
    });
    const before = await sidebar.boundingBox();
    const handle = await page.locator("[data-sidebar-resize-handle]").boundingBox();
    if (!before || !handle) throw new Error("Right sidebar or its resize handle is missing");
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 4; step++) {
      // A frame per move: the drag listeners attach in an effect after the touch starts.
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      );
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x - 20 * step, y }],
      });
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // Dragging the left-edge handle 80 px left widens the sidebar by as much.
    await page.waitForFunction(
      (start) => {
        const element = document.querySelector('[aria-label="Workspace insights"]');
        return element != null && element.getBoundingClientRect().width >= start + 60;
      },
      before.width,
      { timeout: 5000 }
    );
  } finally {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await client.detach();
    if (viewport) await page.setViewportSize(viewport);
    await page.evaluate((entries) => {
      localStorage.clear();
      for (const [key, value] of entries) localStorage.setItem(key, value);
    }, storage);
  }
}

// The iPhone Duo cover display keeps a status and camera column on its right edge (an 84 px
// right safe-area inset in Apple's simulator) at a width where xum shows its phone layout.
const SIDE_INSET_PX = 84;
const SIDE_INSET_VIEWPORT = { width: 466, height: 700 };
const SIDE_INSET_TARGETS = new Map<string, { sheet: string } | "toast">([
  ["settings-settingspage--phone-full-screen", { sheet: "Settings" }],
  ["app-phoneviewports--i-phone-16-e-analytics-sheet", { sheet: "Analytics" }],
  ["app-components-activegoalswarningtoast--above-threshold", "toast"],
]);

/**
 * Phone sheets and toasts are portaled out of the app shell, which pads the side safe areas, so
 * they must keep their controls clear of a right inset themselves, while a sheet's background
 * still fills the width. Plays cannot set safe-area insets; CDP can (env() reads the override).
 */
async function assertClearsRightInset(page: StoryPage, target: { sheet: string } | "toast") {
  const client = await page.context().newCDPSession(page);
  const viewport = page.viewportSize();
  try {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await client.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 0, right: SIDE_INSET_PX, bottom: 34, left: 0 },
    });
    await page.setViewportSize(SIDE_INSET_VIEWPORT);
    await page.waitForFunction(
      (width) => matchMedia("(pointer: coarse)").matches && innerWidth === width,
      SIDE_INSET_VIEWPORT.width,
      { timeout: 5000 }
    );
    const root =
      target === "toast"
        ? page.getByRole("status").locator("..")
        : page.getByRole("dialog", { name: target.sheet });
    if (target !== "toast") {
      // The md+ dialog turns into the full-width phone sheet once the new width lays out.
      await page.waitForFunction(
        (dialog) => dialog?.getBoundingClientRect().left === 0,
        await root.elementHandle({ timeout: 5000 }),
        { timeout: 5000 }
      );
    }
    const problems = await root.evaluate(
      (element, args) => {
        const found: string[] = [];
        const limit = innerWidth - args.inset;
        const box = element.getBoundingClientRect();
        if (args.toast) {
          // max(1rem, inset) on each side: the toast's left edge stays on screen as well.
          if (box.right > limit + 0.5) found.push(`toast ends at ${Math.round(box.right)}px`);
          if (box.left < 16 - 0.5) found.push(`toast starts at ${Math.round(box.left)}px`);
          return found;
        }
        if (Math.round(box.right) !== innerWidth) {
          found.push(`sheet background ends at ${Math.round(box.right)}px`);
        }
        const controls = element.querySelectorAll<HTMLElement>(
          "button, a[href], input, select, textarea, [role=combobox], [role=switch], [role=tab]"
        );
        for (const control of controls) {
          const rect = control.getBoundingClientRect();
          if (rect.width === 0 || getComputedStyle(control).visibility === "hidden") continue;
          let left = rect.left;
          let right = rect.right;
          for (let el = control.parentElement; el; el = el.parentElement) {
            if (getComputedStyle(el).overflowX !== "visible") {
              const clip = el.getBoundingClientRect();
              left = Math.max(left, clip.left);
              right = Math.min(right, clip.right);
            }
            if (el === element) break;
          }
          // Scrolled out of its container: not on screen.
          if (right <= left) continue;
          if (right > limit + 0.5) {
            const name =
              control.getAttribute("aria-label") ?? control.textContent ?? control.tagName;
            found.push(`${name.trim().slice(0, 40)} ends at ${Math.round(right)}px`);
          }
        }
        return found;
      },
      { inset: SIDE_INSET_PX, toast: target === "toast" }
    );
    // Compare a string: the page's array has another realm's prototype, so deepEqual always fails.
    assert.equal(
      problems.join("; "),
      "",
      `Nothing may sit under a ${SIDE_INSET_PX}px right safe-area inset (limit ${
        SIDE_INSET_VIEWPORT.width - SIDE_INSET_PX
      }px)`
    );
  } finally {
    await client.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await client.detach();
    if (viewport) await page.setViewportSize(viewport);
  }
}

const MENU_INSET_STORY = "components-projectpage--create-workspace-many-projects";
// The iPhone Duo cover display draws its 21 px top inset as an opaque status band. A short
// viewport (as when the software keyboard is up) leaves the project switcher too little room
// below, so its list opens upward and Radix fits it to the top edge.
const MENU_INSETS = { top: 21, right: SIDE_INSET_PX, bottom: 0, left: 0 };
const MENU_INSET_VIEWPORT = { width: SIDE_INSET_VIEWPORT.width, height: 220 };

/**
 * Radix fits a menu to the viewport edge, but menus portal out of the app shell that pads the
 * safe areas, so a list fitted to the edge drew rows under the top band and the right column.
 */
async function assertMenuClearsSafeArea(page: StoryPage) {
  const client = await page.context().newCDPSession(page);
  const viewport = page.viewportSize();
  try {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await client.send("Emulation.setSafeAreaInsetsOverride", { insets: MENU_INSETS });
    await page.setViewportSize(MENU_INSET_VIEWPORT);
    await page.waitForFunction(
      (size) =>
        matchMedia("(pointer: coarse)").matches &&
        innerWidth === size.width &&
        innerHeight === size.height,
      MENU_INSET_VIEWPORT,
      { timeout: 5000 }
    );
    // A touch tap opens Radix Select on click; a hidden copy of the trigger can exist.
    await page.locator("[data-testid=project-selector]:visible").evaluate((el) => {
      (el as HTMLElement).click();
    });
    const listbox = page.getByRole("listbox");
    await listbox.waitFor({ timeout: 5000 });
    // Radix positions the list a frame after it mounts; wait until it stops moving.
    const box = await listbox.evaluate(async (element) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      let last = "";
      for (let i = 0; i < 60; i++) {
        await frame();
        const r = element.getBoundingClientRect();
        const next = `${r.top},${r.right},${r.bottom}`;
        if (next === last && r.height > 0) break;
        last = next;
      }
      const r = element.getBoundingClientRect();
      return { top: r.top, right: r.right, side: element.getAttribute("data-side") };
    });
    // Below the heading the list has room to start below any inset, so only the upward case checks.
    assert.equal(box.side, "top", "The project list must open above its trigger on a short phone");
    const limit = MENU_INSET_VIEWPORT.width - MENU_INSETS.right;
    const problems: string[] = [];
    if (box.top < MENU_INSETS.top - 0.5) problems.push(`list starts at ${Math.round(box.top)}px`);
    if (box.right > limit + 0.5) problems.push(`list ends at ${Math.round(box.right)}px`);
    assert.equal(
      problems.join("; "),
      "",
      `The project list must clear a ${MENU_INSETS.top}px top and ${MENU_INSETS.right}px right inset`
    );
  } finally {
    await page.keyboard.press("Escape");
    await client.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    });
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
    const insetTarget = SIDE_INSET_TARGETS.get(context.id);
    if (insetTarget) {
      if (page.context().browser()?.browserType().name() === "chromium") {
        await assertClearsRightInset(page, insetTarget);
      }
      return;
    }
    if (context.id === MENU_INSET_STORY) {
      if (page.context().browser()?.browserType().name() === "chromium") {
        await assertMenuClearsSafeArea(page);
      }
      return;
    }
    if (context.id === PHONE_FOOTER_TOUCH_STORY) {
      if (page.context().browser()?.browserType().name() === "chromium") {
        await assertPhoneFooterTouchTargets(page);
      }
      return;
    }
    if (context.id === TOUCH_RESIZE_STORY) {
      if (page.context().browser()?.browserType().name() === "chromium") {
        await assertTouchResizesRightSidebar(page);
      }
      return;
    }
    if (context.id === "app-rightsidebar-stable-tab-controls--wide") {
      if (page.context().browser()?.browserType().name() !== "chromium") return;
      // A tablet (coarse pointer above the phone breakpoint) gets no global 44px button floor.
      // Its strip keeps the desktop height (44px rows made it far taller than the header), so
      // the controls must size themselves to the 24px minimum. Plays cannot emulate the pointer.
      const client = await page.context().newCDPSession(page);
      const viewport = page.viewportSize();
      // The row sits in a wrapper that holds its desktop no-drag region.
      const strip = page.getByRole("tablist").locator("../..");
      try {
        await page.setViewportSize({ width: 1200, height: 900 });
        const desktop = await strip.boundingBox();
        await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
        await page.waitForFunction(() => matchMedia("(pointer: coarse)").matches, undefined, {
          timeout: 5000,
        });
        const tablet = await strip.boundingBox();
        if (!desktop || !tablet) throw new Error("Tab strip is missing");
        assert.equal(tablet.height, desktop.height, "Touch must not grow the tablet tab strip");
        // The strip's room for the right sidebar toggle is inert; the toggle itself (in
        // WorkspaceShell) is a fixed 24px button.
        for (const name of ["Close New tab", "Close Instructions", "New tab", "All tabs"]) {
          const box = await page.getByRole("button", { name, exact: true }).boundingBox();
          if (!box) throw new Error(`${name} button is missing`);
          assert(
            box.width >= TABLET_TOUCH_TARGET_PX && box.height >= TABLET_TOUCH_TARGET_PX,
            `${name} target is ${box.width}x${box.height}`
          );
        }
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
          // The tap below lands 20 px into the last tab's visible part: on a phone, a long title
          // can be wider than the row, so the tab's own left edge never scrolls into view.
          const reachedLastTab = await row.evaluate((el) => {
            const last = Array.from(el.querySelectorAll('[role="tab"]')).at(-1);
            if (!last) return false;
            const bounds = el.getBoundingClientRect();
            return Math.max(last.getBoundingClientRect().left, bounds.left) + 20 < bounds.right;
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
        const tapX = Math.max(last.x, bounds.x) + 20;
        assert(tapX < bounds.x + bounds.width, "Last tab must be inside the right edge");
        await client.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: tapX, y: last.y + last.height / 2 }],
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
      // dnd-kit's PointerSensor stops every click on the page (a capture listener on document)
      // from drag start until 50 ms after the drag ends (setTimeout in
      // @dnd-kit/core/dist/core.esm.js:1476-1479, v6.3.1). The next story in this file
      // (SingleTab) clicks All tabs about 15 ms after it renders, so that click was lost (#6999).
      // Wait until a probe click on the body reaches the body again.
      await page.waitForFunction(
        () => {
          let reached = false;
          const mark = () => (reached = true);
          document.body.addEventListener("click", mark, { once: true });
          document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          document.body.removeEventListener("click", mark);
          return reached;
        },
        undefined,
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
