// Known failure, open issue #5672: a reload during a message edit leaves the edit text in the
// composer as the new-message draft, and the unsent draft is lost. Fails until #5672 is fixed.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground, sendMessageForEdit, WORKSPACE_TITLE } from "./helpers";

// Unique per attempt: repeats and retries share the run's seeded workspace.
const messageText = () => `5672 message to edit ${Date.now()}`;

test(
  "a reload during an edit keeps the unsent draft",
  { tags: ["bugbash", "known-failure", "5672"] },
  async ({ app, screen, browser }) => {
    await openPlayground(app, screen, browser);
    const MESSAGE = messageText();
    const edit = await sendMessageForEdit(screen, browser, MESSAGE);

    const composer = screen.getByRole("textbox", "Message");
    await composer.fill("unsent draft");
    await edit.tap();
    const editBox = screen.getByRole("textbox", "Edit message");
    await expect(editBox).toHaveValue(MESSAGE);

    await browser.reload();
    await expect(screen.getByText(WORKSPACE_TITLE).first()).toBeVisible({ timeout: 15_000 });
    // The transcript has loaded once its Edit action shows.
    await expect(edit).toBeVisible({ timeout: 15_000 });
    // Either fix passes: one that drops the edit on reload, or one that restores edit mode, whose
    // Cancel then brings the pre-edit draft back.
    if (await editBox.isVisible()) {
      await screen.getByRole("button", "Cancel").tap();
    }
    await expect(composer).toHaveValue("unsent draft");
  }
);
