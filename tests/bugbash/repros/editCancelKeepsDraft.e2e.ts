// N1 (#5670): edit mode had no visible way out except Escape, and touch screens have no Escape key.
// Proves the edit bar's Cancel button leaves edit mode and puts the unsent draft back.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

test(
  "Cancel in edit mode leaves edit mode and keeps the unsent draft",
  { tags: ["bugbash", "N1"] },
  async ({ app, screen, browser }) => {
    await openPlayground(app, screen, browser);
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill("first message");
    await browser.keyboard.press("Enter");
    // The Edit action shows once the backend has accepted the send.
    const edit = screen.getByRole("button", "Edit");
    await expect(edit).toBeVisible({ timeout: 20_000 });

    await composer.fill("unsent draft");
    await edit.tap();
    const editBox = screen.getByRole("textbox", "Edit message");
    await expect(editBox).toHaveValue("first message");

    const cancel = screen.getByRole("button", "Cancel");
    await expect(cancel).toBeVisible();
    await cancel.tap();
    await expect(editBox).toBeHidden();
    await expect(composer).toHaveValue("unsent draft");
  }
);
