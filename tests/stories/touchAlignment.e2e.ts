/**
 * Touch phones (iOS Safari) apply a 44px minimum to every button (globals.css, `pointer: coarse`).
 * That minimum pushed controls off the line of the text next to them (#5834, #5940, #6318). These
 * stories replace the exact repro that measured element boxes: the steps stay exact, and a judge
 * reads the screenshot (`vision: "only"`: the accessibility tree has no positions). Claims that a
 * screenshot cannot show (an invisible hit area, the keyboard order) keep exact checks.
 *
 * The e2e browser has no coarse pointer, so each test copies the app's own coarse-pointer rules
 * into an unconditional stylesheet first. The rules come from the shipped CSS, so a change to them
 * changes what these stories see.
 */
import type { Browser } from "@e2e-dev/web";
import { test } from "@e2e-dev/web";
import type { Screen } from "e2e";
import { expect } from "e2e";
import { openPlayground, sendMessage, WORKSPACE_TITLE } from "../bugbash/repros/helpers";

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
  // Without any copied rule the judge would see the desktop layout and pass for no reason.
  expect(copied).toBeGreaterThan(0);
}

async function openSettings(browser: Browser, screen: Screen): Promise<void> {
  // The settings button lives in the sidebar, which narrow layouts hide behind a menu button.
  const sidebarMenu = screen.getByRole("button", "Open sidebar menu");
  if (await sidebarMenu.isVisible()) await sidebarMenu.tap();
  await browser.locator('[data-testid="settings-button"]').tap();
  await expect(screen.getByRole("dialog", "Settings")).toBeVisible();
}

/** Height and width in px of the first element that matches, or zeros if none does. */
async function boxSize(browser: Browser, selector: string): Promise<{ w: number; h: number }> {
  const box = await browser.locator(selector).first().boundingBox();
  return { w: Math.round(box?.width ?? 0), h: Math.round(box?.height ?? 0) };
}

// 768px is the edge where Tailwind's md: layout and the touch 44px minimum both apply (iPad mini
// in portrait), so a fix that only covers phone widths still fails there.
for (const width of [390, 768]) {
  test(
    `the Settings close button is level with the title on a touch screen ${width}px wide`,
    { tags: ["story", "touch-alignment"] },
    async ({ app, agent, screen, browser }) => {
      await browser.setViewport({ width, height: 844 });
      await openPlayground(app, screen, browser);
      await openSettings(browser, screen);
      await applyTouchPointerRules(browser);
      await expect(screen.getByRole("button", "Close settings")).toBeVisible();
      // Before the fix (#5834) the X sat about 10px below the middle of the title.
      await agent.assert(
        "in the Settings header, the close X is vertically centered on the 'Settings' title's line, not lower than the title",
        { vision: "only" }
      );
    }
  );
}

test(
  "Backup settings checkboxes are small and level with their labels on a touch phone",
  { tags: ["story", "touch-alignment"] },
  async ({ app, agent, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await openPlayground(app, screen, browser);
    await openSettings(browser, screen);
    await screen.getByRole("button", "Backup").tap();
    await applyTouchPointerRules(browser);
    await expect(
      screen.getByRole("dialog", "Settings").getByRole("checkbox").first()
    ).toBeVisible();
    // Before the fix (#6318) each box drew as a 44px square, 14px below its label's first line.
    await agent.assert(
      "in the 'What to back up and restore' list, each checkbox is much smaller than the Branch text field above it, about as tall as its label's text, and level with that text",
      { vision: "only" }
    );
    // Not visible on screen: the label row stays a 44px touch target.
    const row = await boxSize(browser, '[role=dialog] label:has(button[role="checkbox"])');
    expect(row.h).toBeGreaterThanOrEqual(44);
  }
);

test(
  "the heartbeat checkbox is small and level with its label on a touch phone",
  { tags: ["story", "touch-alignment"] },
  async ({ app, agent, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await openPlayground(app, screen, browser);
    await screen.getByTestId("workspace-more-actions").tap();
    await screen.getByRole("button", /^Configure heartbeat/).tap();
    await expect(screen.getByRole("dialog", "Configure heartbeat")).toBeVisible();
    await applyTouchPointerRules(browser);
    await agent.assert(
      "in the Configure heartbeat dialog, the checkbox is a small square about the height of one line of text, level with its label",
      { vision: "only" }
    );
    // Not visible on screen: its sibling <label for> is no touch target, so the checkbox button
    // itself keeps a 44px hit area around the small box it draws.
    const hit = await boxSize(browser, "#workspace-heartbeat-use-default-interval");
    expect(Math.min(hit.w, hit.h)).toBeGreaterThanOrEqual(44);
  }
);

test(
  "a reply's model and time stay on one line on a touch phone",
  { tags: ["story", "touch-alignment"] },
  async ({ app, agent, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await openPlayground(app, screen, browser);
    // The story job's app AI is the mock, whose model name is long enough to wrap.
    await sendMessage(screen, "Touch alignment story: model and time on one line");
    // The judge needs this reply's settled meta row on screen. Every story of a run shares the one
    // seeded workspace, so wait on this reply's own block: an earlier story's reply has a meta row
    // too (Stories (Haiku) on #7185 judged this reply while it was still starting).
    await expect
      .poll(
        () =>
          browser.evaluate(() => {
            const reply = Array.from(document.querySelectorAll("[data-message-block]"))
              .filter((block) =>
                block.textContent?.includes("Mock response: Touch alignment story")
              )
              .at(-1);
            const time = reply?.querySelector("[data-message-meta-right] [data-message-timestamp]");
            time?.scrollIntoView({ block: "center" });
            return time != null;
          }),
        { timeout: 20_000 }
      )
      .toBe(true);
    await applyTouchPointerRules(browser);
    // Before the fix (#5834) the model and the time sat on two lines, 24px apart.
    await agent.assert(
      "under the assistant reply that starts 'Mock response: Touch alignment story', the model name and the time are on one single line",
      { vision: "only" }
    );
  }
);

test(
  "the workspace actions menu stays on the title row on a touch phone",
  { tags: ["story", "touch-alignment"] },
  async ({ app, agent, screen, browser }) => {
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
    await expect(screen.getByTestId("workspace-more-actions")).toBeVisible();
    // Before the fix (#5940) the three-dots menu wrapped under the title, 44px lower.
    await agent.assert(
      `the three-dots workspace actions button is on the same row as the workspace title '${WORKSPACE_TITLE}', at the top right`,
      { vision: "only" }
    );
    // Not visible on screen: keyboard focus follows the DOM, so the menu must also come before
    // the row below it.
    const menuFirst = await browser.evaluate(() => {
      const menu = document.querySelector('[data-testid="workspace-more-actions"]');
      const bell = document.querySelector('[data-testid="notify-on-response-button"]');
      if (!menu || !bell) return false;
      return (menu.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(menuFirst).toBe(true);
  }
);
