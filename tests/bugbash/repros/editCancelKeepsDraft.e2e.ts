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
    // The Edit action shows before the turn ends, and the composer turns off for a moment at
    // stream-start until the send settles; a fill then is dropped silently (#5810). The composer
    // is off before the turn starts and on while it starts, when Stop already shows. So, in order:
    // the composer is on (the turn started or ended), Stop is gone (it ended), the composer is on
    // (the send settled). With no turn running, it stays on from then. Mode-independent: no reply
    // text is matched, so a real app AI works too.
    await expect(composer).toBeEnabled({ timeout: 20_000 });
    await expect(screen.getByRole("button", /^Stop/)).toBeHidden({ timeout: 20_000 });
    await expect(composer).toBeEnabled();
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
