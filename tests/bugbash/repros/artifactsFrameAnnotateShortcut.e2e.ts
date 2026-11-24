// artifact-frame-annotate-shortcut: C (annotate) only reached the Artifacts panel's onKeyDown.
// Once focus was inside an HTML artifact's sandboxed frame (any click in its content), the key
// went to the frame's document, and the frame's key bridge forwarded only Escape and Shift+F.
// So in fullscreen C did nothing. Proves C toggles annotate mode with focus in the frame.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

test(
  "C toggles annotate mode in a fullscreen HTML artifact after a click inside the artifact",
  { tags: ["bugbash", "artifact-frame-annotate-shortcut"] },
  async ({ app, screen, browser }) => {
    // The web target's size, set here so the repro runs the same on every target: the narrow
    // layout hides the right sidebar.
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

    await screen.getByRole("button", "Fullscreen").tap();
    await expect(screen.getByRole("button", "Exit fullscreen")).toBeVisible();
    // Control: with focus on the panel, C works.
    await browser.keyboard.press("c");
    await expect(screen.getByRole("button", "Stop annotating")).toBeVisible();
    await browser.keyboard.press("c");
    await expect(screen.getByRole("button", "Annotate")).toBeVisible();

    // A click in the content moves focus into the frame (annotate mode is off, so the click
    // is the artifact's own). The bug: C is then lost.
    await frame.getByRole("heading", "Guide").tap();
    await expect(screen.getByTestId("artifact-frame")).toBeFocused();
    await browser.keyboard.press("c");
    await expect(screen.getByRole("button", "Stop annotating")).toBeVisible();
  }
);
