// N5 (#5670): Ctrl+Shift+N was bound to both "New scratch chat" and "Toggle notifications".
// Notifications moved to Ctrl/Cmd+Shift+Comma; this repro fails if the shortcut stops toggling it.
import { test } from "@e2e-dev/web";
import { expectNotifyOnAllResponses, openPlayground } from "./helpers";

test(
  "Ctrl+Shift+Comma toggles notifications in a workspace",
  { tags: ["bugbash", "N5"] },
  async ({ app, screen, browser }) => {
    await openPlayground(app, screen, browser);
    await expectNotifyOnAllResponses(screen, browser, false);

    const composer = screen.getByRole("textbox", "Message");
    await composer.tap();
    await browser.keyboard.press("Control+Shift+Comma");
    await expectNotifyOnAllResponses(screen, browser, true);

    await composer.tap();
    await browser.keyboard.press("Control+Shift+Comma");
    await expectNotifyOnAllResponses(screen, browser, false);
  }
);
