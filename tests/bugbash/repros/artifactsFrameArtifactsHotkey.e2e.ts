// artifact-frame-artifacts-hotkey (PR #7194 review, 2026-10-22): OPEN_ARTIFACTS_TAB did nothing once
// focus was inside an HTML artifact's sandboxed frame (any click in its content). The key went to
// the frame's document, which never reaches the app's window listener, and the frame's key bridge
// forwarded only TOGGLE_RIGHT_SIDEBAR. Since the key toggles the Artifacts tab, a press there must
// hide the sidebar, like a press with focus anywhere else in the tab.
import { test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
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

test(
  "Ctrl+Shift+K hides the right sidebar after a click inside an HTML artifact",
  { tags: ["bugbash", "artifact-frame-artifacts-hotkey"] },
  async ({ app, screen, browser }) => {
    // The web target's size: the narrow layout hides the right sidebar.
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    await screen.getByRole("textbox", "Message").tap();
    await browser.keyboard.press("Control+Shift+K");
    await expect(screen.getByTestId("artifacts-panel")).toBeFocused();

    // guide.html is seeded by startApp.ts, under the collapsed "Other files" group.
    await screen.getByRole("combobox", "Artifact").tap();
    await screen.getByRole("option", /^Show \d+ other files?$/).tap();
    await screen.getByRole("option", "guide.html").tap();
    const frame = browser.frameLocator('[data-testid="artifact-frame"]');
    await expect(frame.getByText("At the top")).toBeVisible({ timeout: 15_000 });
    expect(await toggleLabel(browser)).toBe("Collapse right sidebar");

    // A click in the content moves focus into the frame. The bug: the chord is then lost.
    await frame.getByRole("heading", "Guide").tap();
    await expect(screen.getByTestId("artifact-frame")).toBeFocused();
    await browser.keyboard.press("Control+Shift+K");
    await expect.poll(() => toggleLabel(browser)).toBe("Expand right sidebar");
    // The collapse unmounts the frame, so focus moves to the toggle, and a second press opens the
    // sidebar on the Artifacts tab again.
    await expect(screen.getByRole("button", "Expand right sidebar")).toBeFocused();
    await browser.keyboard.press("Control+Shift+K");
    await expect.poll(() => toggleLabel(browser)).toBe("Collapse right sidebar");
    await expect(screen.getByTestId("artifacts-panel")).toBeFocused();
  }
);
