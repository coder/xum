// artifact-in-page-links: a srcdoc frame resolves "#usage" against the app's URL, so clicking an
// in-page link navigated the artifact frame to the app itself, and the navigation guard closed
// it ("This artifact navigated away"). Proves the link scrolls the artifact and the frame stays.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

test(
  "an in-page link in an HTML artifact scrolls instead of closing the artifact",
  { tags: ["bugbash", "artifact-in-page-links"] },
  async ({ app, screen, browser }) => {
    // The web target's size, set here so the repro runs the same on every target: the narrow
    // layout hides the right sidebar.
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    await screen.getByRole("textbox", "Message").tap();
    await browser.keyboard.press("Control+Shift+K");
    await expect(screen.getByTestId("artifacts-panel")).toBeFocused();

    // guide.html is seeded by startApp.ts. It has no stored version and the seed's options.html
    // does, so the picker lists guide.html under the collapsed "Other files" group.
    await screen.getByRole("combobox", "Artifact").tap();
    await screen.getByRole("option", /^Show \d+ other files?$/).tap();
    await screen.getByRole("option", "guide.html").tap();
    const frame = browser.frameLocator('[data-testid="artifact-frame"]');
    await expect(frame.getByText("At the top")).toBeVisible({ timeout: 15_000 });

    await frame.getByRole("link", "Usage").tap();
    await expect(frame.getByText("Scrolled")).toBeVisible();
    await frame.getByRole("link", "Back to top").tap();
    await expect(frame.getByText("At the top")).toBeVisible();
    await expect(screen.getByText("This artifact navigated away", { exact: false })).toBeHidden();
    await expect(screen.getByTestId("artifact-frame")).toBeVisible();
  }
);
