// RS1, RS2 (bug bash 2026-10-21 of the Ctrl+Shift+B right sidebar hotkey). Each test fails on the
// defect the bug bash found: the key acted behind the open command palette (RS1), and in the phone
// full-screen sidebar it collapsed the sidebar inside the view, which left a blank pane (RS2).
import type { Browser } from "@e2e-dev/web";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

/** The header toggle's label: "Expand right sidebar" while collapsed, "Collapse ..." while open. */
function toggleLabel(browser: Browser): Promise<string | null> {
  return browser.evaluate(
    () =>
      document
        .querySelector('[data-testid="right-sidebar-toggle-bar"] button')
        ?.getAttribute("aria-label") ?? null
  );
}

/** Two animation frames: React has committed whatever the key press changed. */
async function settle(browser: Browser): Promise<void> {
  // evaluate() returns JSON, so the frames resolve with null.
  await browser.evaluate(
    () =>
      new Promise<null>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))
      )
  );
}

test(
  "Ctrl+Shift+B does nothing while the command palette is open",
  { tags: ["bugbash", "RS1"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    // Control: outside the palette the key toggles the sidebar.
    const before = await toggleLabel(browser);
    await screen.getByRole("textbox", "Message").tap();
    await browser.keyboard.press("Control+Shift+B");
    await expect.poll(() => toggleLabel(browser)).not.toBe(before);
    const toggled = await toggleLabel(browser);

    await browser.keyboard.press("Control+Shift+P");
    await expect(screen.getByRole("combobox", "Command palette")).toBeFocused();
    await browser.keyboard.press("Control+Shift+B");
    await settle(browser);
    // The palette stays open, and the sidebar behind it keeps its state.
    await expect(screen.getByRole("combobox", "Command palette")).toBeVisible();
    expect(await toggleLabel(browser)).toBe(toggled);
  }
);

test(
  "Ctrl+Shift+B keeps the phone full-screen sidebar intact",
  { tags: ["bugbash", "RS2"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await openPlayground(app, screen, browser);
    await screen.getByRole("button", "Workspace actions").tap();
    await screen.getByRole("button", "Sidebar").tap();
    await expect(screen.getByRole("button", "Close sidebar")).toBeVisible();
    await expect(screen.getByRole("button", "New tab")).toBeVisible();

    await browser.keyboard.press("Control+Shift+B");
    await settle(browser);
    // Before the fix the key collapsed the sidebar inside the view: its tabs and tool list went
    // away and only the close button stayed.
    await expect(screen.getByRole("button", "Close sidebar")).toBeVisible();
    await expect(screen.getByRole("button", "New tab")).toBeVisible();
  }
);

test(
  "Ctrl+Shift+B from inside the sidebar moves focus to the sidebar toggle",
  { tags: ["bugbash", "RS3"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    if ((await toggleLabel(browser)) === "Expand right sidebar") {
      await screen.getByRole("button", "Expand right sidebar").tap();
    }
    // Focus a control inside the sidebar: its New tab.
    const newTab = screen.getByRole("tab", /^New tab\b/);
    await newTab.focus();
    await expect(newTab).toBeFocused();

    await browser.keyboard.press("Control+Shift+B");
    await expect.poll(() => toggleLabel(browser)).toBe("Expand right sidebar");
    // Before the fix the collapse unmounted the focused control and focus fell to <body>.
    await expect(screen.getByRole("button", "Expand right sidebar")).toBeFocused();
  }
);
