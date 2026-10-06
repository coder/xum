// N1 (#5670): edit mode had no visible way out except Escape, and touch screens have no Escape key.
// Proves the edit bar's Cancel button leaves edit mode and puts the unsent draft back.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground, sendMessageForEdit } from "./helpers";

// Unique per attempt: repeats and retries share the run's seeded workspace.
const messageText = () => `N1 message to edit ${Date.now()}`;

test(
  "Cancel in edit mode leaves edit mode and keeps the unsent draft",
  { tags: ["bugbash", "N1"] },
  async ({ app, screen, browser }) => {
    await openPlayground(app, screen, browser);
    const MESSAGE = messageText();
    const edit = await sendMessageForEdit(screen, browser, MESSAGE);

    const composer = screen.getByRole("textbox", "Message");
    await composer.fill("unsent draft");
    await edit.tap();
    const editBox = screen.getByRole("textbox", "Edit message");
    await expect(editBox).toHaveValue(MESSAGE);

    const cancel = screen.getByRole("button", "Cancel");
    await expect(cancel).toBeVisible();
    await cancel.tap();
    await expect(editBox).toBeHidden();
    await expect(composer).toHaveValue("unsent draft");
  }
);
