// PF1, PF2 (bug bash 2026-10-21, keyboard persona): the command palette's right-sidebar commands
// opened a pane or a tool but left keyboard focus on <body>, so the next Tab started over from
// the top of the page. "Right Sidebar: New Tab" already focused its launcher's first row.
import type { Browser } from "@e2e-dev/web";
import { test } from "@e2e-dev/web";
import type { Screen } from "e2e";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

async function runPaletteCommand(screen: Screen, browser: Browser, title: string): Promise<void> {
  await browser.keyboard.press("Control+Shift+P");
  const palette = screen.getByRole("combobox", "Command palette");
  await expect(palette).toBeFocused();
  await palette.fill(`>${title}`);
  await expect(screen.getByRole("option", title)).toBeVisible();
  await browser.keyboard.press("Enter");
}

test(
  "Split Vertically from the palette focuses the new pane's launcher",
  { tags: ["bugbash", "PF1"] },
  async ({ app, screen, browser }) => {
    // The web target's size, set here so the repro runs the same on every target: the narrow
    // layout hides the right sidebar.
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    await runPaletteCommand(screen, browser, "Right Sidebar: Split Vertically");

    // The seeded workspace's only pane shows the New tab, so the split adds a second launcher
    // after it. Focus must sit on the first row of the new (second) one.
    await expect
      .poll(() =>
        browser.evaluate(() => {
          const active = document.activeElement;
          const launchers = Array.from(
            document.querySelectorAll('[role="tabpanel"][id$="-panel-new"]')
          );
          const pane = launchers.findIndex((launcher) => launcher.contains(active));
          return {
            launchers: launchers.length,
            pane,
            firstRow: pane !== -1 && launchers[pane].querySelector("button") === active,
          };
        })
      )
      .toEqual({ launchers: 2, pane: 1, firstRow: true });
  }
);

test(
  "Add Tool > Stats from the palette focuses the Stats tab",
  { tags: ["bugbash", "PF2"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    // The bug showed when the palette opened from the chat input.
    await screen.getByRole("textbox", "Message").tap();
    await runPaletteCommand(screen, browser, "Right Sidebar: Add Tool…");
    // The prompt's select field labels the palette input with the field's label.
    const toolField = screen.getByRole("combobox", "Tool");
    await expect(toolField).toBeFocused();
    await toolField.fill("Stats");
    await expect(screen.getByRole("option", "Stats")).toBeVisible();
    await browser.keyboard.press("Enter");

    await expect(screen.getByRole("tab", /^Stats\b/)).toBeFocused();
  }
);
