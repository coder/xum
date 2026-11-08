// artifact-hash-router: a hash router in an HTML artifact never saw its routes. A click on a
// "#/route" link was cancelled and left the fragment alone (so no hashchange fired), and
// history.replaceState(null, "", "#/route") threw a SecurityError, because a srcdoc frame resolves
// that URL against the app's. Proves the rendered route follows each control and the frame stays.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

test(
  "a hash router in an HTML artifact follows links and replaceState",
  { tags: ["bugbash", "artifact-hash-router"] },
  async ({ app, screen, browser }) => {
    // The web target's size, set here so the repro runs the same on every target: the narrow
    // layout hides the right sidebar.
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    await screen.getByRole("textbox", "Message").tap();
    await browser.keyboard.press("Control+Shift+K");
    await expect(screen.getByTestId("artifacts-panel")).toBeFocused();

    // hash-router.html is seeded by startApp.ts. It is not published and the seed's options.html
    // is, so the picker lists it under the collapsed "Other files" group.
    await screen.getByRole("combobox", "Artifact").tap();
    await screen.getByRole("option", /^Show \d+ other files?$/).tap();
    await screen.getByRole("option", "hash-router.html").tap();
    const frame = browser.frameLocator('[data-testid="artifact-frame"]');
    await expect(frame.getByText("Route is /.")).toBeVisible({ timeout: 15_000 });

    await frame.getByRole("link", "Alpha").tap();
    await expect(frame.getByText("Route is /s/alpha.")).toBeVisible();
    await frame.getByRole("link", "Beta").tap();
    await expect(frame.getByText("Route is /s/beta.")).toBeVisible();
    await frame.getByRole("button", "Delta by replaceState").tap();
    await expect(frame.getByText("Route is /s/delta.")).toBeVisible();
    await frame.getByRole("button", "Gamma by hash").tap();
    await expect(frame.getByText("Route is /s/gamma.")).toBeVisible();
    await frame.getByRole("link", "Home").tap();
    await expect(frame.getByText("Route is /.")).toBeVisible();

    await expect(screen.getByText("This artifact navigated away", { exact: false })).toBeHidden();
    await expect(screen.getByTestId("artifact-frame")).toBeVisible();
  }
);
