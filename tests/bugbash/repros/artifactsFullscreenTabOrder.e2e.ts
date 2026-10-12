// #6200 (open): in the fullscreen Artifacts panel, Tab from the Artifact picker goes Annotate,
// then the panel itself, skipping Download, Exit fullscreen and Reload. Walks Tab and records
// each stop.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

test(
  "Tab in the fullscreen Artifacts panel reaches every toolbar button",
  { tags: ["bugbash", "known-failure", "6200"] },
  async ({ app, screen, browser }) => {
    // The web target's size, set here so the repro runs the same on every target: the narrow
    // layout hides the right sidebar.
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    await screen.getByRole("textbox", "Message").tap();
    await browser.keyboard.press("Control+Shift+K");
    await expect(screen.getByTestId("artifacts-panel")).toBeFocused();

    await screen.getByRole("button", "Fullscreen").tap();
    await expect(screen.getByRole("button", "Exit fullscreen")).toBeVisible();
    // Annotate renders and Download enables only once the selected file has loaded. Walking Tab
    // earlier would skip them for loading, not for the reported defect.
    await expect(screen.getByRole("button", "Annotate")).toBeVisible();
    await expect(screen.getByRole("button", "Download artifact")).toBeEnabled();

    await screen.getByRole("combobox", "Artifact").focus();
    const stops: string[] = [];
    for (let i = 0; i < 4; i++) {
      await browser.keyboard.press("Tab");
      stops.push(
        await browser.evaluate(() => {
          const active = document.activeElement;
          return active?.getAttribute("aria-label") ?? active?.tagName ?? "none";
        })
      );
    }
    expect(stops).toEqual(["Annotate", "Download artifact", "Exit fullscreen", "Reload artifact"]);
  }
);
