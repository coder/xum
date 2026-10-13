// Touch phones (iOS Safari) apply a 44px minimum to every button (globals.css, `pointer: coarse`).
// That minimum pushed controls off the line of the text next to them: the Settings close X sat
// below the title, and a reply's model and time wrapped onto two lines beside the action buttons.
//
// The e2e browser has no coarse pointer, so each test copies the app's own coarse-pointer rules
// into an unconditional stylesheet first. The rules come from the shipped CSS, so a change to them
// changes what these tests see.
import type { Browser } from "@e2e-dev/web";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground, sendMessage } from "./helpers";

async function applyTouchPointerRules(browser: Browser): Promise<void> {
  const copied = await browser.evaluate(() => {
    const css: string[] = [];
    const visit = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSMediaRule && rule.conditionText.includes("pointer: coarse")) {
          for (const inner of Array.from(rule.cssRules)) css.push(inner.cssText);
        } else if ("cssRules" in rule) {
          visit((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) visit(sheet.cssRules);
    const style = document.createElement("style");
    style.textContent = css.join("\n");
    document.head.appendChild(style);
    return css.length;
  });
  // Without any copied rule the tests would measure the desktop layout and pass for no reason.
  expect(copied).toBeGreaterThan(0);
}

/** Vertical distance in px between the centers of two elements' boxes, or 999 (fails the check) if one is missing. */
function centerGap(browser: Browser, a: string, b: string): Promise<number> {
  return browser.evaluate(
    ([sa, sb]) => {
      const ea = document.querySelector(sa);
      const eb = document.querySelector(sb);
      if (!ea || !eb) return 999;
      const ra = ea.getBoundingClientRect();
      const rb = eb.getBoundingClientRect();
      return Math.abs(ra.top + ra.height / 2 - (rb.top + rb.height / 2));
    },
    [a, b] as const
  );
}

async function openSettings(browser: Browser, screen: Parameters<typeof openPlayground>[1]) {
  // The settings button lives in the sidebar, which narrow layouts hide behind a menu button.
  const sidebarMenu = screen.getByRole("button", "Open sidebar menu");
  if (await sidebarMenu.isVisible()) await sidebarMenu.tap();
  await browser.locator('[data-testid="settings-button"]').tap();
  await expect(screen.getByRole("dialog", "Settings")).toBeVisible();
}

// 768px is the edge where Tailwind's md: layout and the touch 44px minimum both apply (iPad mini
// in portrait), so a fix that only covers phone widths still fails there.
for (const width of [390, 768]) {
  test(
    `Settings close button lines up with the title on a touch screen ${width}px wide`,
    { tags: ["bugbash", "touch-alignment"] },
    async ({ app, screen, browser }) => {
      await browser.setViewport({ width, height: 844 });
      await openPlayground(app, screen, browser);
      await openSettings(browser, screen);
      await applyTouchPointerRules(browser);

      // Before the fix the X sat about 10px below the title's middle.
      await expect
        .poll(() =>
          centerGap(browser, "[role=dialog] h2", '[role=dialog] [aria-label="Close settings"] svg')
        )
        .toBeLessThanOrEqual(2);
    }
  );
}

test(
  "Checkboxes keep their size and line up with their labels on a touch phone",
  { tags: ["bugbash", "touch-alignment", "5835"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await openPlayground(app, screen, browser);
    await openSettings(browser, screen);
    await screen.getByRole("button", "Backup").tap();
    await applyTouchPointerRules(browser);

    // Before the fix the 44px minimum drew each checkbox as a 44px square, and its middle sat
    // 14px below the middle of its label's first line. Inside a label the button shrink-wraps the
    // drawn box, so the button's size is the drawn size.
    const measure = () =>
      browser.evaluate(() => {
        const checkbox = document.querySelector('[role=dialog] label button[role="checkbox"]');
        const title = checkbox?.nextElementSibling?.firstElementChild;
        const row = checkbox?.closest("label");
        if (!checkbox || !title || !row) return null;
        const b = checkbox.getBoundingClientRect();
        const t = title.getBoundingClientRect();
        return {
          drawnBox: Math.round(Math.max(b.width, b.height)),
          centerGap: Math.abs(b.top + b.height / 2 - (t.top + t.height / 2)),
          rowHeight: Math.round(row.getBoundingClientRect().height),
        };
      });
    await expect.poll(async () => (await measure())?.drawnBox ?? 999).toBeLessThanOrEqual(20);
    const result = await measure();
    expect(result?.centerGap ?? 999).toBeLessThanOrEqual(2);
    // The label row stays a 44px touch target.
    expect(result?.rowHeight ?? 0).toBeGreaterThanOrEqual(44);
  }
);

test(
  "A reply's model and time stay on one line on a touch phone",
  // mock-only: the mock reply's model name is long enough to wrap; a real Haiku reply can fit
  // beside the buttons even with the bug.
  { tags: ["bugbash", "touch-alignment", "mock-only"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await openPlayground(app, screen, browser);
    await sendMessage(screen, "Touch alignment: model and time on one line");
    await applyTouchPointerRules(browser);

    // The newest meta row that shows more than the time is the reply's. Before the fix the model
    // and the time sat on two lines, 24px apart.
    await expect
      .poll(() =>
        browser.evaluate(() => {
          const rows = Array.from(document.querySelectorAll("[data-message-meta-right]")).filter(
            (row) => row.childElementCount >= 2 && row.querySelector("[data-message-timestamp]")
          );
          const row = rows.at(-1);
          const first = row?.firstElementChild;
          const time = row?.querySelector("[data-message-timestamp]");
          if (!first || !time || first === time) return 999;
          const a = first.getBoundingClientRect();
          const b = time.getBoundingClientRect();
          return Math.abs(a.top + a.height / 2 - (b.top + b.height / 2));
        })
      )
      .toBeLessThanOrEqual(2);
  }
);

test(
  "The workspace actions menu stays on the title row on a touch phone",
  { tags: ["bugbash", "touch-alignment"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    // The header picks its button order with matchMedia, which the copied CSS rules cannot
    // reach: report a coarse pointer to scripts too.
    await browser.addInitScript(() => {
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query: string) =>
        matchMedia(query.replaceAll("(pointer: coarse)", "(min-width: 0px)"));
    });
    await openPlayground(app, screen, browser);
    await applyTouchPointerRules(browser);

    // The 44px buttons do not fit beside the title, so the header wraps. Before the fix the
    // three-dots menu wrapped with the other actions and sat under the title, 44px lower.
    await expect
      .poll(() =>
        centerGap(
          browser,
          '[data-testid="workspace-title"]',
          '[data-testid="workspace-more-actions"]'
        )
      )
      .toBeLessThanOrEqual(2);
    // Keyboard focus follows the DOM, so the menu must also come before the row below it.
    const menuFirst = await browser.evaluate(() => {
      const menu = document.querySelector('[data-testid="workspace-more-actions"]');
      const bell = document.querySelector('[data-testid="notify-on-response-button"]');
      if (!menu || !bell) return false;
      return (menu.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(menuFirst).toBe(true);
  }
);
