// iPhone Duo folds between a 382 px cover display (the phone layout: the left sidebar is a drawer)
// and a 951 px inner display (the desktop layout: an inline sidebar). One saved flag drove both, so
// folding with the sidebar open popped the drawer over the chat, and closing the drawer hid the
// wide sidebar after the next unfold. Proves that a fold never opens the drawer and that the drawer
// never changes the wide sidebar's saved state.
import type { Browser } from "@e2e-dev/web";
import { test } from "@e2e-dev/web";
import type { Screen } from "e2e";
import { expect } from "e2e";
import { LEFT_SIDEBAR_COLLAPSED_KEY } from "../../../src/common/constants/storage";
import { openPlayground } from "./helpers";

const INNER = { width: 951, height: 620 };
const COVER = { width: 382, height: 580 };
// The fold passes through intermediate widths before it settles on the cover display.
const FOLD_LADDER = [{ width: 466, height: 498 }, COVER];
const TAGS = ["bugbash", "duo-fold-drawer"];

/**
 * The sidebar's right edge once no animation runs in it. While one runs it reads NaN, which fails
 * every comparison (the page returns null: evaluate passes JSON values only).
 */
async function sidebarRight(browser: Browser): Promise<number> {
  const right = await browser.evaluate(() => {
    const sidebar = document.querySelector('[data-testid="left-sidebar"]');
    if (sidebar?.getAnimations({ subtree: true }).length !== 0) return null;
    return sidebar.getBoundingClientRect().right;
  });
  return right ?? Number.NaN;
}

/** Whether a tap on the composer's center reaches the composer (no drawer or backdrop over it). */
function composerTakesTaps(browser: Browser): Promise<boolean> {
  return browser.evaluate(() => {
    const composer = document.querySelector('[data-component="ChatInputSection"] textarea');
    if (composer == null) return false;
    const box = composer.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit != null && composer.contains(hit);
  });
}

async function expectDrawerClosed(screen: Screen, browser: Browser): Promise<void> {
  await expect(screen.getByRole("button", "Open sidebar menu")).toBeVisible();
  await expect.poll(() => sidebarRight(browser)).toBeLessThanOrEqual(0);
  await expect.poll(() => composerTakesTaps(browser)).toBe(true);
}

async function expectWideSidebar(
  screen: Screen,
  browser: Browser,
  expanded: boolean
): Promise<void> {
  await expect(
    screen.getByRole("button", expanded ? "Collapse sidebar" : "Open sidebar menu")
  ).toBeVisible();
  const right = expect.poll(() => sidebarRight(browser));
  if (expanded) {
    await right.toBeGreaterThan(100);
    // An open drawer looks the same; only the inline sidebar has a resize handle, so this waits
    // until the app has rendered the wide layout.
    await expect(browser.locator('[data-testid="left-sidebar-resize-handle"]')).toHaveCount(1);
  } else {
    await right.toBeLessThanOrEqual(0);
  }
}

async function fold(screen: Screen, browser: Browser): Promise<void> {
  for (const viewport of FOLD_LADDER) {
    await browser.setViewport(viewport);
    await expectDrawerClosed(screen, browser);
  }
}

test(
  "folding with the wide sidebar open keeps the drawer closed",
  { tags: TAGS },
  async ({ app, screen, browser }) => {
    await browser.setViewport(INNER);
    await openPlayground(app, screen, browser);
    await expectWideSidebar(screen, browser, true);
    await fold(screen, browser);
  }
);

test(
  "unfolding with the drawer open restores the wide sidebar, and the next fold starts closed",
  { tags: TAGS },
  async ({ app, screen, browser }) => {
    await browser.setViewport(INNER);
    await openPlayground(app, screen, browser);
    await fold(screen, browser);
    await screen.getByRole("button", "Open sidebar menu").tap();
    await expect.poll(() => sidebarRight(browser)).toBeGreaterThan(100);

    await browser.setViewport(INNER);
    await expectWideSidebar(screen, browser, true);
    await fold(screen, browser);
  }
);

test(
  "the drawer never expands a wide sidebar the user collapsed",
  { tags: TAGS },
  async ({ app, screen, browser }) => {
    await browser.setViewport(INNER);
    await openPlayground(app, screen, browser);
    await screen.getByRole("button", "Collapse sidebar").tap();
    await expectWideSidebar(screen, browser, false);
    await fold(screen, browser);

    await screen.getByRole("button", "Open sidebar menu").tap();
    await expect.poll(() => sidebarRight(browser)).toBeGreaterThan(100);
    await screen.getByRole("button", "Collapse sidebar").tap();
    await expectDrawerClosed(screen, browser);

    await browser.setViewport(INNER);
    await expectWideSidebar(screen, browser, false);
  }
);

test(
  "a reload at the cover width starts with the drawer closed when the wide sidebar is saved open",
  { tags: TAGS },
  async ({ app, screen, browser }) => {
    await browser.setViewport(COVER);
    await openPlayground(app, screen, browser);
    await browser.evaluate((key) => {
      localStorage.setItem(key, JSON.stringify(false));
      return null;
    }, LEFT_SIDEBAR_COLLAPSED_KEY);
    await browser.reload();
    await expectDrawerClosed(screen, browser);
  }
);
