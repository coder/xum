import { getStoryContext, type TestRunnerConfig } from "@storybook/test-runner";
// This hook is reloaded between Jest suites in the same worker. Importing @playwright/test
// initializes a second test runner and fails on reload; use browser waits and Node assertions.
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  IOS_STATUS_BAND_HEIGHT_PX,
  MOBILE_TOUCH_TARGET_PX,
  SIDE_INSET_PX,
  SIDE_INSET_VIEWPORT,
  TABLET_TOUCH_TARGET_PX,
} from "../src/constants/layout";
import {
  MERMAID_ERROR_SELECTOR,
  MERMAID_PAGE_DIAGRAM_SELECTOR,
  MERMAID_PAGE_FRAME_SELECTOR,
  PAINT_CHECK_RENDER_TIMEOUT_ENV,
  PAINT_CHECK_WAIT_EVENT,
} from "../src/constants/mermaid";

// Real :hover for the primary-button contrast stories (#6022). A play runs inside the page and
// cannot set :hover, so only stories under this id prefix get two page-level helpers backed by
// Playwright. All other stories run exactly as before.
const HOVER_STORY_PREFIX = "app-primarybuttoncontrast--";
const hoverReady = new WeakSet<object>();
const paintHookReady = new WeakSet<object>();
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

const AGENT_INTERFACE_TOUCH_STORY = "app-agentinterface--touch-toggle";
// The gap the header's own side padding (px-2) gives while the left sidebar is open. The story
// collapses the sidebar, which drops that padding, so the toggle must keep the gap itself.
const PHONE_EDGE_GAP_PX = 8;

/**
 * On a touch phone the Status / Chat toggle starts the header's actions row. globals.css raises
 * its buttons to touch targets, so the group (which clips its overflow) must grow to show them
 * whole, and it must not sit flush against the screen edge. Plays cannot emulate the pointer.
 */
async function assertAgentInterfaceToggleTouchTargets(page: StoryPage) {
  const client = await page.context().newCDPSession(page);
  const viewport = page.viewportSize();
  try {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const toggle = page.locator('[data-testid="agent-interface-view-toggle"]');
    // The phone header moves the actions to their own sideways-scrolling row.
    await page.waitForFunction(
      () => {
        const row = document.querySelector(
          '[data-testid="agent-interface-view-toggle"]'
        )?.parentElement;
        return row != null && getComputedStyle(row).overflowX === "auto";
      },
      undefined,
      { timeout: 5000 }
    );
    // The resize to phone width slides the left sidebar drawer out over the header; let it and
    // the other layout transitions finish before hit-testing.
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const transitions = document.getAnimations().filter((a) => a instanceof CSSTransition);
      // allSettled: a transition the resize cancels rejects `finished` with an AbortError.
      await Promise.allSettled(transitions.map((transition) => transition.finished));
    });
    const geometry = await toggle.evaluate((group) => {
      const groupBox = group.getBoundingClientRect();
      const buttons = Array.from(group.querySelectorAll("button"), (button) => {
        const box = button.getBoundingClientRect();
        let { left, right, top, bottom } = box;
        // Clip by every ancestor that clips its overflow, then by the screen.
        for (let el = button.parentElement; el; el = el.parentElement) {
          const style = getComputedStyle(el);
          const clip = el.getBoundingClientRect();
          if (style.overflowX !== "visible") {
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
          }
          if (style.overflowY !== "visible") {
            top = Math.max(top, clip.top);
            bottom = Math.min(bottom, clip.bottom);
          }
        }
        left = Math.max(left, 0);
        top = Math.max(top, 0);
        right = Math.min(right, window.innerWidth);
        bottom = Math.min(bottom, window.innerHeight);
        // A tap at the center must reach the button, not a header control drawn over it.
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          name: button.textContent ?? "",
          tappable: hit != null && button.contains(hit),
          width: box.width,
          height: box.height,
          visibleWidth: Math.max(0, right - left),
          visibleHeight: Math.max(0, bottom - top),
        };
      });
      return { left: groupBox.left, buttons };
    });
    const problems: string[] = [];
    if (geometry.left < PHONE_EDGE_GAP_PX) {
      problems.push(`toggle starts ${Math.round(geometry.left)}px from the screen edge`);
    }
    for (const button of geometry.buttons) {
      if (button.height < MOBILE_TOUCH_TARGET_PX) {
        problems.push(`${button.name} is ${Math.round(button.height)}px tall`);
      }
      if (button.visibleWidth < button.width - 0.5 || button.visibleHeight < button.height - 0.5) {
        problems.push(
          `${button.name} shows ${Math.round(button.visibleWidth)}x${Math.round(button.visibleHeight)} of ${Math.round(button.width)}x${Math.round(button.height)}px`
        );
      }
      if (!button.tappable) problems.push(`${button.name} is covered at its center`);
    }
    assert.equal(problems.join("; "), "", "Status / Chat touch targets must stay whole on a phone");
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

// iOS 27.1 reports the Duo cover display's status and camera column as a right safe-area inset.
const RIGHT_COLUMN_INSETS = { top: 0, right: SIDE_INSET_PX, bottom: 34, left: 0 };
const MERMAID_SIDE_INSET_STORY =
  "app-chat-messages-markdownrenderer--mermaid-state-dialog-side-inset";
const SIDE_INSET_TARGETS = new Map<string, { sheet: string } | "toast" | "mermaid-dialog">([
  ["settings-settingspage--phone-full-screen", { sheet: "Settings" }],
  ["app-phoneviewports--i-phone-16-e-analytics-sheet", { sheet: "Analytics" }],
  ["app-components-activegoalswarningtoast--above-threshold", "toast"],
  [MERMAID_SIDE_INSET_STORY, "mermaid-dialog"],
]);

const RIGHT_INSET_LIMIT_PX = SIDE_INSET_VIEWPORT.width - SIDE_INSET_PX;
const RIGHT_INSET_MESSAGE = `Nothing may sit under a ${SIDE_INSET_PX}px right safe-area inset (limit ${RIGHT_INSET_LIMIT_PX}px)`;
const MERMAID_DIALOG_DRAWING = ".mermaid-modal > svg.pele";

/**
 * The story's play closed the dialog, so open it again under the inset. The dialog is the frame
 * around the drawing's container.
 */
async function openMermaidDialog(page: StoryPage) {
  await page.getByRole("button", { name: "⤢", exact: true }).click({ timeout: 5000 });
}

async function mermaidDialogInsetProblems(page: StoryPage) {
  // The drawing starts at its full size, and shrinks to the dialog's room once it has measured it.
  await page.waitForFunction(
    (selector) => {
      const drawing = document.querySelector(selector);
      const room = drawing?.parentElement;
      if (!drawing || !room) return false;
      const box = drawing.getBoundingClientRect();
      return box.width <= room.clientWidth + 1 && box.height <= room.clientHeight + 1;
    },
    MERMAID_DIALOG_DRAWING,
    { timeout: 10_000 }
  );
  const drawing = page.locator(MERMAID_DIALOG_DRAWING);
  const parts = [
    ["dialog", drawing.locator("xpath=../..")],
    ["drawing", drawing],
    ["Close button", page.getByRole("button", { name: "Close", exact: true })],
  ] as const;
  const problems: string[] = [];
  for (const [name, part] of parts) {
    const box = await part.boundingBox({ timeout: 5000 });
    if (!box) throw new Error(`The ${name} has no box`);
    if (box.x + box.width > RIGHT_INSET_LIMIT_PX + 0.5) {
      problems.push(`${name} ends at ${Math.round(box.x + box.width)}px`);
    }
  }
  return problems;
}

/** Finds what a phone sheet or a toast puts under the right inset, once the sheet has laid out. */
async function sheetOrToastProblemFinder(
  page: StoryPage,
  target: { sheet: string } | "toast"
): Promise<() => Promise<string[]>> {
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
  return () =>
    root.evaluate(
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
}

/**
 * Phone sheets and toasts (portaled) and the Mermaid expand dialog (fixed) escape the app shell,
 * which pads the side safe areas, so they must keep their controls clear of a right inset
 * themselves, while a sheet's background still fills the width. Plays cannot set safe-area
 * insets; CDP can (env() reads the override).
 */
async function assertClearsRightInset(
  page: StoryPage,
  target: { sheet: string } | "toast" | "mermaid-dialog"
) {
  const client = await page.context().newCDPSession(page);
  const viewport = page.viewportSize();
  try {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await client.send("Emulation.setSafeAreaInsetsOverride", { insets: RIGHT_COLUMN_INSETS });
    await page.setViewportSize(SIDE_INSET_VIEWPORT);
    await page.waitForFunction(
      (width) => matchMedia("(pointer: coarse)").matches && innerWidth === width,
      SIDE_INSET_VIEWPORT.width,
      { timeout: 5000 }
    );
    let findProblems: () => Promise<string[]>;
    if (target === "mermaid-dialog") {
      await openMermaidDialog(page);
      findProblems = () => mermaidDialogInsetProblems(page);
    } else {
      findProblems = await sheetOrToastProblemFinder(page, target);
    }
    // Compare a string: the page's array has another realm's prototype, so deepEqual always fails.
    assert.equal((await findProblems()).join("; "), "", RIGHT_INSET_MESSAGE);
    // iOS 27.2 reports no inset for the Duo's column; iosCoverColumn.ts sets its width instead.
    await client.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { ...RIGHT_COLUMN_INSETS, right: 0 },
    });
    await page.evaluate(
      (width) => document.documentElement.style.setProperty("--ios-cover-column", `${width}px`),
      SIDE_INSET_PX
    );
    try {
      // The safe-area probes report the change from a ResizeObserver, after a frame.
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );
      assert.equal(
        (await findProblems()).join("; "),
        "",
        `Nothing may sit under an ${SIDE_INSET_PX}px --ios-cover-column (limit ${RIGHT_INSET_LIMIT_PX}px)`
      );
    } finally {
      await page.evaluate(() =>
        document.documentElement.style.removeProperty("--ios-cover-column")
      );
    }
  } finally {
    await client.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await client.detach();
    if (viewport) await page.setViewportSize(viewport);
  }
}

// The folded iPhone Duo cover display keeps its status and camera column on its right edge. iOS
// 27.1 reports it as a right safe-area inset; on iOS 27.2 iosCoverColumn.ts measures it and sets
// --ios-cover-column. On a narrow portrait viewport xum reserves only the band the OS draws in, so
// the page still uses the whole width (the `body::after` rule in globals.css); elsewhere the inset
// keeps padding the shell.
const DUO_BAND_STORY = "app-phoneviewports--duo-cover-display";
const DUO_BAND_VIEWPORT = { width: SIDE_INSET_VIEWPORT.width, height: 678 };
// Measured on a folded Duo at 2.95 px per pt: the glyphs sit at x 398..437, y 87..151 of the 466x678
// cover display. Keep in sync with the rule's top and height.
const DUO_BAND = {
  left: SIDE_INSET_VIEWPORT.width - SIDE_INSET_PX,
  top: 0,
  height: IOS_STATUS_BAND_HEIGHT_PX,
};
// The phone header's own right padding (px-2), which the column's width adds to.
const HEADER_GUTTER_PX = 8;
const DUO_INSETS = { top: 0, right: SIDE_INSET_PX, bottom: 34, left: 0 };
const NO_SIDE_INSET = { top: 0, right: 0, bottom: 34, left: 0 };

/** The app shell's right reserve: what it pads, and the band it paints instead. */
async function measureRightReserve(page: StoryPage) {
  const shell = page.locator(".mobile-layout").first();
  await shell.waitFor({ state: "attached", timeout: 5000 });
  return shell.evaluate((element) => {
    const band = getComputedStyle(document.body, "::after");
    const header = document.querySelector(".mobile-sticky-header");
    return {
      innerWidth,
      padding: getComputedStyle(element).paddingRight,
      headerRight: header ? Math.round(header.getBoundingClientRect().right) : null,
      headerPadding: header ? getComputedStyle(header).paddingRight : null,
      background: getComputedStyle(element).backgroundColor,
      shellRight: Math.round(element.getBoundingClientRect().right),
      content: band.content,
      width: band.width,
      top: band.top,
      height: band.height,
      right: band.right,
      pointerEvents: band.pointerEvents,
      bandBackground: band.backgroundColor,
    };
  });
}

/** Asserts the narrow-portrait reserve for an 84px status column, whichever way iOS reports it. */
function assertColumnReserve(
  reserve: Awaited<ReturnType<typeof measureRightReserve>>,
  how: string
) {
  assert.equal(reserve.padding, "0px", `${how}: a narrow portrait shell keeps no right padding`);
  assert.equal(reserve.shellRight, reserve.innerWidth, `${how}: the shell spans the whole width`);
  assert.equal(reserve.width, `${SIDE_INSET_PX}px`, `${how}: the band is as wide as the column`);
  assert.equal(reserve.right, "0px", `${how}: the band ends at the screen edge`);
  assert.equal(
    reserve.innerWidth - SIDE_INSET_PX,
    DUO_BAND.left,
    `${how}: the band starts at the OS column's x ${DUO_BAND.left}`
  );
  assert.equal(reserve.top, `${DUO_BAND.top}px`, `${how}: the band starts at the top edge`);
  assert.equal(
    reserve.height,
    `${DUO_BAND.height}px`,
    `${how}: the band covers the OS glyphs to y ${DUO_BAND.top + DUO_BAND.height}`
  );
  assert.equal(
    reserve.pointerEvents,
    "none",
    `${how}: the band takes no touches, as the OS band above it takes none`
  );
  assert.equal(
    reserve.bandBackground,
    reserve.background,
    `${how}: the band paints the shell's own background`
  );
  assert.equal(
    reserve.headerRight,
    reserve.innerWidth,
    `${how}: the header's background spans the display`
  );
  assert.equal(
    reserve.headerPadding,
    `${HEADER_GUTTER_PX + SIDE_INSET_PX}px`,
    `${how}: the header keeps its controls left of the column`
  );
}

/**
 * A Duo's cover display draws its status column over web content. iOS 27.1 reports it as
 * `env(safe-area-inset-right)`; iOS 27.2 reports nothing, and iosCoverColumn.ts lays the page out
 * across the column and sets `--ios-cover-column`. Padding the shell by the column gives up 84 of the
 * 466 px width for the whole page, so in narrow portrait the shell pads nothing and paints only the
 * band the OS draws in. Where there is no column (every other phone in portrait) the band may paint
 * nothing, and sideways a side inset is a full-height notch, so the padding must stay.
 */
async function assertBandOnlyRightReserve(page: StoryPage) {
  const client = await page.context().newCDPSession(page);
  const viewport = page.viewportSize();
  const settle = async (
    size: { width: number; height: number },
    insets: typeof DUO_INSETS
  ): Promise<void> => {
    await page.setViewportSize(size);
    await client.send("Emulation.setSafeAreaInsetsOverride", { insets });
    await page.waitForFunction((width) => innerWidth === width, size.width, { timeout: 5000 });
  };
  try {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });

    await settle(DUO_BAND_VIEWPORT, DUO_INSETS);
    assertColumnReserve(await measureRightReserve(page), "iOS 27.1, inset reported");

    // iOS 27.2: no inset, the page laid out across the column, and the column's width measured.
    await settle(DUO_BAND_VIEWPORT, NO_SIDE_INSET);
    await page.evaluate(
      (width) => document.documentElement.style.setProperty("--ios-cover-column", `${width}px`),
      SIDE_INSET_PX
    );
    try {
      assertColumnReserve(await measureRightReserve(page), "iOS 27.2, column measured");
    } finally {
      await page.evaluate(() =>
        document.documentElement.style.removeProperty("--ios-cover-column")
      );
    }

    // No column: every other phone in portrait.
    const flush = await measureRightReserve(page);
    assert.equal(flush.padding, "0px", "a flush shell keeps its full width either way");
    assert.equal(flush.width, "0px", "with no column the band paints nothing on any other phone");
    assert.equal(flush.shellRight, flush.innerWidth, "a flush shell still spans the whole width");
    assert.equal(
      flush.headerPadding,
      `${HEADER_GUTTER_PX}px`,
      "with no column the header keeps its own gutter"
    );

    // Sideways the same inset is a full-height notch, so nothing may shift into it.
    await settle({ width: DUO_BAND_VIEWPORT.height, height: DUO_BAND_VIEWPORT.width }, DUO_INSETS);
    const landscape = await measureRightReserve(page);
    assert.equal(landscape.padding, `${SIDE_INSET_PX}px`, "a landscape shell still pads the notch");
    assert.equal(landscape.content, "none", "landscape paints no band");
  } finally {
    await client.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await client.detach();
    if (viewport) await page.setViewportSize(viewport);
  }
}

const MENU_INSET_STORY = "components-projectpage--create-workspace-multiple-projects";
// The iPhone Duo cover display draws its 21 px top inset as an opaque status band. A short
// viewport (as when the software keyboard is up) leaves the project switcher too little room
// below, so its list opens upward and Radix fits it to the top edge.
const MENU_INSETS = { top: 21, right: SIDE_INSET_PX, bottom: 0, left: 0 };
// A taller top band that appears while the list is open.
const RAISED_MENU_INSETS = { ...MENU_INSETS, top: 40 };
const MENU_INSET_VIEWPORT = { width: SIDE_INSET_VIEWPORT.width, height: 220 };

/** Waits until a Radix menu stops moving, then returns its top edge and side. */
async function settledMenuBox(menu: ReturnType<StoryPage["getByRole"]>) {
  return menu.evaluate(async (element) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    let last = "";
    for (let i = 0; i < 60; i++) {
      await frame();
      const r = element.getBoundingClientRect();
      const next = `${r.top},${r.bottom}`;
      if (next === last && r.height > 0) break;
      last = next;
    }
    return { top: element.getBoundingClientRect().top, side: element.getAttribute("data-side") };
  });
}

/**
 * Counts the browser's "ResizeObserver loop" errors until the returned function runs. A menu that
 * re-renders inside the safe-area probes' observer callback resizes during the observer loop.
 */
async function countResizeObserverLoopErrors(page: StoryPage): Promise<() => Promise<number>> {
  const stop = await page.evaluateHandle(() => {
    let count = 0;
    const onError = (event: ErrorEvent) => {
      if (event.message.includes("ResizeObserver loop")) count += 1;
    };
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("error", onError);
      return count;
    };
  });
  return async () => {
    const count = await stop.evaluate((stopCounting) => stopCounting());
    await stop.dispose();
    return count;
  };
}

/**
 * Radix fits a menu to the viewport edge, but menus portal out of the app shell that pads the
 * safe areas, so a list fitted to the top edge drew its first rows under the top band.
 */
async function assertMenuClearsSafeArea(page: StoryPage) {
  const client = await page.context().newCDPSession(page);
  const viewport = page.viewportSize();
  const loopErrors = await countResizeObserverLoopErrors(page);
  // The probes' ResizeObserver reports new insets in the next frame; menus hear of them in the one
  // after.
  const setInsets = async (insets: typeof MENU_INSETS) => {
    await client.send("Emulation.setSafeAreaInsetsOverride", { insets });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
  };
  try {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await page.setViewportSize(MENU_INSET_VIEWPORT);
    await page.waitForFunction(
      (size) =>
        matchMedia("(pointer: coarse)").matches &&
        innerWidth === size.width &&
        innerHeight === size.height,
      MENU_INSET_VIEWPORT,
      { timeout: 5000 }
    );
    // The insets come after the resize, with no resize of their own, as they can when a folding
    // phone switches displays.
    await setInsets(MENU_INSETS);
    // A touch tap opens Radix Select on click; a hidden copy of the trigger can exist.
    await page.locator("[data-testid=project-selector]:visible").evaluate((el) => {
      (el as HTMLElement).click();
    });
    const listbox = page.getByRole("listbox");
    await listbox.waitFor({ timeout: 5000 });
    // Radix positions the list a frame after it mounts.
    const box = await settledMenuBox(listbox);
    // Below the heading the list has room to start below any inset, so only the upward case checks.
    assert.equal(box.side, "top", "The project list must open above its trigger on a short phone");
    assert(
      box.top >= MENU_INSETS.top - 0.5,
      `The project list starts at ${Math.round(box.top)}px, under the ${MENU_INSETS.top}px top inset`
    );
    await setInsets(RAISED_MENU_INSETS);
    const raised = await settledMenuBox(listbox);
    assert(
      raised.top >= RAISED_MENU_INSETS.top - 0.5,
      `The open list stays at ${Math.round(raised.top)}px, under a ${RAISED_MENU_INSETS.top}px top inset`
    );
    assert.equal(await loopErrors(), 0, "Menus must not resize inside a ResizeObserver callback");
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

const LANDSCAPE_SHEET_STORY = "app-composeractivityline--worst-case-phone";

/**
 * The live line's activity sheet on a touch phone, upright and in landscape. Landscape is wider
 * than globals.css's touch-size rule (up to 768px) but short, so the sheet opens there too, and its
 * Close button and tabs must still be 44px touch targets. Upright, four tabs do not fit: each must
 * keep its label and count (the strip scrolls), though that rule's 44px min-width would let a tab
 * shrink below them. Plays cannot emulate the pointer.
 */
async function assertSheetTouchTargets(page: StoryPage) {
  const client = await page.context().newCDPSession(page);
  const viewport = page.viewportSize();
  const problems: string[] = [];
  try {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    for (const size of [
      { width: 844, height: 390 },
      { width: 375, height: 667 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForFunction(
        (width) => matchMedia("(pointer: coarse)").matches && innerWidth === width,
        size.width,
        { timeout: 5000 }
      );
      await page
        .locator('[data-component="ChatActivityLine"] [data-component="PinnedTodoList"] button')
        .first()
        .click();
      const sheet = page.getByRole("dialog", { name: "Activity" });
      await sheet.waitFor({ timeout: 5000 });
      const targets = [
        sheet.getByRole("button", { name: "Close" }),
        ...(await sheet.getByRole("tab").all()),
      ];
      for (const target of targets) {
        const box = await target.boundingBox();
        const name = `${size.width}px ${(await target.textContent())?.trim() || "Close"}`;
        const clipped = await target.evaluate(
          (element) => element.scrollWidth > element.clientWidth
        );
        if (!box) problems.push(`${name}: missing`);
        else if (box.height < 44) problems.push(`${name}: ${Math.round(box.height)}px tall`);
        else if (clipped) problems.push(`${name}: label cut`);
      }
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "hidden", timeout: 5000 });
    }
    assert.equal(problems.join("; "), "", "The sheet's controls must be whole touch targets");
  } finally {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await client.detach();
    if (viewport) await page.setViewportSize(viewport);
  }
}
/**
 * The live line clears the composer on a real touch phone. The touch floor makes every control's hit
 * area taller than what it draws, and the row keeps padding below the controls so the line never
 * sits on the composer's top edge. This is the only place that padding can be checked: it lives in
 * the same `pointer: coarse` query as the floor, which a play cannot match.
 */
async function assertLiveLineClearsTheComposer(page: StoryPage) {
  const client = await page.context().newCDPSession(page);
  const viewport = page.viewportSize();
  try {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForFunction(() => matchMedia("(pointer: coarse)").matches, undefined, {
      timeout: 5000,
    });
    const gap = await page.evaluate(() => {
      const line = document.querySelector('[data-component="ChatActivityLine"]');
      const surface = document.querySelector('[data-component="ChatInputSurface"]');
      if (!line || !surface) return null;
      const controls = [...line.querySelectorAll("button")].filter((control) => {
        const style = getComputedStyle(control);
        return style.visibility !== "hidden" && control.getBoundingClientRect().height > 0;
      });
      if (controls.length === 0) return null;
      const bottom = Math.max(...controls.map((control) => control.getBoundingClientRect().bottom));
      return surface.getBoundingClientRect().top - bottom;
    });
    assert(gap !== null, "No live-line control to measure on a 375px touch phone");
    assert(
      gap >= 5,
      `The live line ends ${Math.round(gap)}px above the composer, so it reads as part of it`
    );
  } finally {
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await client.detach();
    if (viewport) await page.setViewportSize(viewport);
  }
}

// Each guard below has a story built to trip it, except those that
// src/browser/stories/PaintCheckFixtures.stories.tsx lists as not covered. `make
// test-storybook-paint-fixtures` runs those stories through this file. A message that changes needs
// its new text in scripts/check-paint-check-fixtures.ts.
const PAINT_CHECK_TAG = "paint-check";
const NO_DIAGRAM_MESSAGE = `A story tagged ${PAINT_CHECK_TAG} must show a rendered Mermaid diagram`;
const DEFAULT_DIAGRAM_RENDER_TIMEOUT_MS = 15_000;
// The fixture run shortens this (scripts/check-paint-check-fixtures.ts), so the fixture with a frame
// that never draws fails without the default wait. A real run leaves the variable unset.
const requestedRenderTimeoutMs = Number(process.env[PAINT_CHECK_RENDER_TIMEOUT_ENV]);
const DIAGRAM_RENDER_TIMEOUT_MS =
  requestedRenderTimeoutMs > 0 ? requestedRenderTimeoutMs : DEFAULT_DIAGRAM_RENDER_TIMEOUT_MS;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Pixels {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

// Known limit (stated in docs/AGENTS.md): the check covers the diagrams that exist when this wait
// returns. A broken or extra diagram that mounts later is not checked, and nothing here re-checks.
async function waitForRenderedDiagrams(page: StoryPage) {
  const args: [string, string, string, number, string] = [
    MERMAID_PAGE_FRAME_SELECTOR,
    MERMAID_PAGE_DIAGRAM_SELECTOR,
    MERMAID_ERROR_SELECTOR,
    DIAGRAM_RENDER_TIMEOUT_MS,
    PAINT_CHECK_WAIT_EVENT,
  ];
  const rendered = await page.evaluate(async ([frames, diagrams, errors, timeout, waitEvent]) => {
    // A diagram that fails replaces its whole frame, so the counts below cannot see it.
    const hasFailed = () => document.querySelector(errors) !== null;
    const isRendered = () => {
      const drawn = document.querySelectorAll(diagrams).length;
      return drawn > 0 && drawn === document.querySelectorAll(frames).length;
    };
    // The fixture story that mounts its diagram late waits for this, so it cannot mount early.
    window.dispatchEvent(new Event(waitEvent));
    // Not Date.now(): the preview freezes it (.storybook/preview.tsx).
    const deadline = performance.now() + timeout;
    while (!isRendered() && !hasFailed() && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return isRendered() && !hasFailed();
  }, args);
  assert(rendered, NO_DIAGRAM_MESSAGE);
}

async function diagramPaintBoxes(page: StoryPage): Promise<Box[]> {
  const boxes = await page.$$eval(MERMAID_PAGE_DIAGRAM_SELECTOR, (diagrams) =>
    diagrams.map((diagram) => {
      const own = diagram.getBoundingClientRect();
      const container = diagram.parentElement!;
      const clip = container.getBoundingClientRect();
      const left = Math.max(own.left, clip.left + container.clientLeft);
      const top = Math.max(own.top, clip.top + container.clientTop);
      const right = Math.min(own.right, clip.left + container.clientLeft + container.clientWidth);
      const bottom = Math.min(own.bottom, clip.top + container.clientTop + container.clientHeight);
      return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
    })
  );
  assert(boxes.length > 0, NO_DIAGRAM_MESSAGE);
  return boxes;
}

async function viewportPixels(page: StoryPage): Promise<Pixels> {
  const png = await page.screenshot({ animations: "disabled", scale: "css" });
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function setDiagramHidden(page: StoryPage, index: number, hidden: boolean) {
  return page.$$eval(
    MERMAID_PAGE_DIAGRAM_SELECTOR,
    (diagrams, [target, hide]) => {
      // Opacity, because a child can set visibility: visible inside a hidden parent.
      (diagrams[target as number] as SVGElement).style.opacity = hide ? "0" : "";
    },
    [index, hidden]
  );
}

// Screenshot noise (glyph fringes, fading glows) changes a few pixels. An escaped diagram changes
// thousands.
const MIN_INK_PIXELS = 32;

// Two screenshots of the same page can differ where the page changes by itself: a scroll-driven
// mask moved 40-60 pixels of the composer toolbar by 1-2 levels. A pixel counts as ink only when
// it differs by more than this. Do not compare against a second shown screenshot instead: the
// first screenshot repairs a stale WebKit layout, so ink that only it shows is the case to catch.
const NOISE_LEVELS = 3;

function pixelDiffers(a: Pixels, b: Pixels, at: number) {
  for (let channel = 0; channel < a.channels; channel++) {
    if (Math.abs(a.data[at + channel] - b.data[at + channel]) > NOISE_LEVELS) return true;
  }
  return false;
}

/** The box is widened by one pixel so its own antialiased edge never counts. */
function differenceOutside(box: Box, shown: Pixels, hidden: Pixels) {
  assert(
    shown.width === hidden.width && shown.height === hidden.height,
    "Both screenshots must have the viewport's size"
  );
  const left = Math.floor(box.left) - 1;
  const right = Math.ceil(box.right) + 1;
  const top = Math.floor(box.top) - 1;
  const bottom = Math.ceil(box.bottom) + 1;
  const sides = new Set<string>();
  const bounds = { left: Infinity, top: Infinity, right: -1, bottom: -1 };
  let count = 0;
  const scan = (y: number, from: number, to: number) => {
    const start = (y * shown.width + from) * shown.channels;
    const end = (y * shown.width + to) * shown.channels;
    if (shown.data.subarray(start, end).equals(hidden.data.subarray(start, end))) return;
    for (let x = from; x < to; x++) {
      const at = (y * shown.width + x) * shown.channels;
      if (!pixelDiffers(shown, hidden, at)) continue;
      count++;
      sides.add(y >= bottom ? "below" : y < top ? "above" : x < left ? "left of" : "right of");
      bounds.left = Math.min(bounds.left, x);
      bounds.top = Math.min(bounds.top, y);
      bounds.right = Math.max(bounds.right, x);
      bounds.bottom = Math.max(bounds.bottom, y);
    }
  };
  for (let y = 0; y < shown.height; y++) {
    if (y >= top && y < bottom) {
      scan(y, 0, Math.min(Math.max(left, 0), shown.width));
      scan(y, Math.min(Math.max(right, 0), shown.width), shown.width);
    } else {
      scan(y, 0, shown.width);
    }
  }
  return { count, sides: [...sides].sort(), bounds };
}

/**
 * Pixels that hiding the diagram changed inside its box, as far as the viewport shows it. A diagram
 * that is seen changes many; one under a hidden parent, an overlay or a clip changes none, which
 * leaves nothing outside its box to compare either. Stops counting once it is clearly seen.
 */
function differenceInside(box: Box, shown: Pixels, hidden: Pixels) {
  const right = Math.min(Math.ceil(box.right), shown.width);
  const bottom = Math.min(Math.ceil(box.bottom), shown.height);
  let count = 0;
  for (let y = Math.max(Math.floor(box.top), 0); y < bottom; y++) {
    for (let x = Math.max(Math.floor(box.left), 0); x < right; x++) {
      if (pixelDiffers(shown, hidden, (y * shown.width + x) * shown.channels)) count++;
      if (count >= MIN_INK_PIXELS) return count;
    }
  }
  return count;
}

/** Hides the diagram and compares the viewport with `shown`: ink outside its box, and ink inside. */
async function compareWithHidden(page: StoryPage, index: number, box: Box, shown: Pixels) {
  await setDiagramHidden(page, index, true);
  try {
    const hidden = await viewportPixels(page);
    const { sides, bounds, count } = differenceOutside(box, shown, hidden);
    const where = `x ${bounds.left}-${bounds.right}, y ${bounds.top}-${bounds.bottom}`;
    return {
      painted:
        count >= MIN_INK_PIXELS
          ? [`diagram ${index} paints ${sides.join(" and ")} its box (${count} px, ${where})`]
          : [],
      changedInside: differenceInside(box, shown, hidden),
    };
  } finally {
    await setDiagramHidden(page, index, false);
  }
}

function scrollBelowDiagram(page: StoryPage, index: number, scroll: boolean) {
  return page.$$eval(
    MERMAID_PAGE_DIAGRAM_SELECTOR,
    (diagrams, [target, down]) => {
      const frame = diagrams[target as number].parentElement!.parentElement!;
      if (down) {
        (frame.nextElementSibling ?? frame).scrollIntoView({ block: "end" });
        return;
      }
      for (let el = frame.parentElement; el; el = el.parentElement) {
        el.scrollTop = 0;
        el.scrollLeft = 0;
      }
    },
    [index, scroll]
  );
}

// iPhone Safari painted the escaped diagram below its box, so a diagram needs this much page
// below it to compare.
const MIN_BELOW_PX = 8;
const roomBelow = (box: Box, viewportHeight: number) => viewportHeight - Math.ceil(box.bottom) - 1;

/**
 * For a diagram that ends below the viewport. By now the first screenshot has repaired any stale
 * WebKit layout, so this scrolled view only catches paint that escapes a settled layout.
 */
async function paintBelowWhenScrolled(page: StoryPage, index: number) {
  await scrollBelowDiagram(page, index, true);
  try {
    const box = (await diagramPaintBoxes(page))[index];
    const shown = await viewportPixels(page);
    assert(
      roomBelow(box, shown.height) >= MIN_BELOW_PX,
      `Diagram ${index} has no content below it to compare: put text after it in the story`
    );
    return await compareWithHidden(page, index, box, shown);
  } finally {
    await scrollBelowDiagram(page, index, false);
  }
}

/**
 * iPhone Safari painted a diagram outside the box it laid it out in, and plays read layout boxes
 * only. WebKit lays the page out again at its next screenshot or resize, which repairs that
 * state, so each diagram is compared against one first screenshot (one that ends below the
 * viewport also gets a scrolled one) and the viewport is left alone: with a diagram hidden, the
 * page outside its box must look the same as with it shown, and its box must look different.
 */
async function assertNoDiagramInkOutsideItsBox(page: StoryPage) {
  // A hovered button shows a tooltip, which fades in and out between two screenshots.
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector('[role="tooltip"]') === null, undefined, {
    timeout: 5000,
  });
  await waitForRenderedDiagrams(page);
  // Wait for fonts and late renders by polling boxes across frames, not by comparing screenshots:
  // a screenshot makes WebKit lay the page out again.
  await page.evaluate(async (selector) => {
    await document.fonts.ready;
    const layout = () =>
      Array.from(document.querySelectorAll(selector), (diagram) =>
        [diagram, diagram.parentElement!.parentElement!]
          .map((element) => {
            const { left, top, width, height } = element.getBoundingClientRect();
            return [left, top, width, height].join(",");
          })
          .join("|")
      ).join(";");
    let last = layout();
    for (let still = 0, frames = 0; still < 5 && frames < 300; frames++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = layout();
      still = now === last ? still + 1 : 0;
      last = now;
    }
  }, MERMAID_PAGE_DIAGRAM_SELECTOR);
  const boxes = await diagramPaintBoxes(page);
  const shown = await viewportPixels(page);
  const painted: string[] = [];
  const unseen: string[] = [];
  for (const [index, box] of boxes.entries()) {
    const atRest = await compareWithHidden(page, index, box, shown);
    painted.push(...atRest.painted);
    let changedInside = atRest.changedInside;
    if (roomBelow(box, shown.height) < MIN_BELOW_PX) {
      const scrolled = await paintBelowWhenScrolled(page, index);
      painted.push(...scrolled.painted);
      changedInside = Math.max(changedInside, scrolled.changedInside);
    }
    if (changedInside < MIN_INK_PIXELS) {
      unseen.push(
        `diagram ${index} (x ${box.left}-${box.right}, y ${box.top}-${box.bottom}) changed ${changedInside} px when hidden`
      );
    }
  }
  assert.equal(
    painted.join("; "),
    "",
    "A diagram must paint only inside its box and the container that clips it"
  );
  assert.equal(
    unseen.join("; "),
    "",
    "Hiding a diagram must change pixels inside its box: a diagram outside the viewport, under a hidden parent, under an overlay or clipped away is not compared with anything, so show it in the story"
  );
}

// Stories that need a pinned viewport (a phone, or a laptop window) for their play, as their
// globals.viewport gives them in Storybook. A fixed-size frame would not do: matchMedia, which
// decides where the live line opens its panels (the phone sheet or a popover), still sees the
// desktop window, and a fixed overlay needs the real viewport to be its containing block.
const PINNED_VIEWPORT_STORIES = new Map([
  ["app-composeractivityline--worst-case-phone", { width: 375, height: 667 }],
  ["app-waitingonyou--phone", { width: 390, height: 844 }],
  ["app-waitingonyou--phone-count-change-keeps-typing", { width: 390, height: 844 }],
  ["app-chat-messages-markdownrenderer--mermaid-state-dialog-phone", { width: 390, height: 844 }],
  ["app-chat-tools-proposeplan--propose-plan-mobile", { width: 390, height: 844 }],
  [
    "app-chat-messages-markdownrenderer--mermaid-state-dialog-desktop",
    { width: 1200, height: 900 },
  ],
  [MERMAID_SIDE_INSET_STORY, SIDE_INSET_VIEWPORT],
]);
const viewportsToRestore = new WeakMap<object, { width: number; height: number }>();

const config: TestRunnerConfig = {
  async preVisit(page, context) {
    // A play calls this before a screenshot or resize repairs a stale WebKit layout.
    // exposeFunction throws on a second registration.
    if (!paintHookReady.has(page)) {
      paintHookReady.add(page);
      await page.exposeFunction("__storybookAssertPaint", () =>
        assertNoDiagramInkOutsideItsBox(page)
      );
    }
    const pinnedViewport = PINNED_VIEWPORT_STORIES.get(context.id);
    if (pinnedViewport) {
      const viewport = page.viewportSize();
      if (viewport) viewportsToRestore.set(page, viewport);
      await page.setViewportSize(pinnedViewport);
      return;
    }
    // exposeFunction throws on a second registration, so register once per Playwright page.
    if (!context.id.startsWith(HOVER_STORY_PREFIX) || hoverReady.has(page)) return;
    hoverReady.add(page);
    await page.exposeFunction("__storybookHover", (selector: string) => page.hover(selector));
    await page.exposeFunction("__storybookUnhover", () => page.mouse.move(0, 0));
  },
  async postVisit(page, context) {
    // Runs after a failed play too, so a pinned viewport never leaks into the next story.
    const restoreViewport = viewportsToRestore.get(page);
    try {
      // Before the viewport is restored, since a resize repairs a stale WebKit layout. Skipped
      // after a failed play so its own error shows.
      if (
        !context.hasFailure &&
        (await getStoryContext(page, context)).tags?.includes(PAINT_CHECK_TAG)
      ) {
        await assertNoDiagramInkOutsideItsBox(page);
      }
    } finally {
      if (restoreViewport) {
        viewportsToRestore.delete(page);
        await page.setViewportSize(restoreViewport);
      }
    }
    if (context.id === LANDSCAPE_SHEET_STORY) {
      if (page.context().browser()?.browserType().name() === "chromium") {
        await assertLiveLineClearsTheComposer(page);
        await assertSheetTouchTargets(page);
      }
      return;
    }
    const insetTarget = SIDE_INSET_TARGETS.get(context.id);
    if (insetTarget) {
      if (page.context().browser()?.browserType().name() === "chromium") {
        await assertClearsRightInset(page, insetTarget);
      }
      return;
    }
    if (context.id === DUO_BAND_STORY) {
      if (page.context().browser()?.browserType().name() === "chromium") {
        await assertBandOnlyRightReserve(page);
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
    if (context.id === AGENT_INTERFACE_TOUCH_STORY) {
      if (page.context().browser()?.browserType().name() === "chromium") {
        await assertAgentInterfaceToggleTouchTargets(page);
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
      // A swipe has settled at the first scrollend after its touchEnd (`data-swipe-ended` marks
      // that point), not at any scrollend: Playwright's scroll-into-view before a click and the
      // previous swipe's fling also end with one, and a fast runner can have the swipe already
      // listening by then. Counting that event started the next swipe, and in the end the tap on
      // the last tab, during a fling. A touch that lands on a fling only stops it and sends no
      // click, so the tab stayed unselected and the wait for it timed out.
      await row.evaluate((el) => {
        el.addEventListener("scrollend", () => {
          if (el.hasAttribute("data-swipe-ended")) el.setAttribute("data-scroll-settled", "");
        });
      });
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
            el.removeAttribute("data-swipe-ended");
            el.removeAttribute("data-scroll-settled");
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
          // Arm before the touch ends: a scrollend that comes right as the finger lifts counts.
          await row.evaluate((el) => el.setAttribute("data-swipe-ended", ""));
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
