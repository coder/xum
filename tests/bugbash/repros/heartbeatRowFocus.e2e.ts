// Bug bash (heartbeat-row-keyboard charter): the collapsed sidebar card's Heartbeat row opens the
// heartbeat settings, but closing them with Escape dropped focus on <body>. Radix returns focus
// only to a DialogTrigger, and this dialog opens from state. Proves focus returns to the row, on
// the first open (which loads the dialog's chunk behind a loading dialog) and on a later one.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground, setPlaygroundHeartbeat } from "./helpers";

test(
  "closing the heartbeat settings opened from the overview card refocuses its row",
  { tags: ["bugbash", "heartbeat-row-focus"] },
  async ({ app, screen, browser }) => {
    // The overview card shows only beside a wide transcript; fresh profiles start collapsed.
    await browser.setViewport({ width: 1440, height: 900 });
    await setPlaygroundHeartbeat(app, true, 10 * 60_000);
    try {
      await openPlayground(app, screen, browser);
      const row = screen.getByRole("button", /^Heartbeat/);
      const dialog = screen.getByRole("dialog", "Configure heartbeat");
      // The row reads the real scheduler through workspace.heartbeat.next (the unit tests mock it).
      await expect(row).toContainText(/Next in \d+m/);
      await expect(row).toContainText("Every 10m");
      for (const key of ["Enter", "Space"]) {
        await row.focus();
        await browser.keyboard.press(key);
        await expect(dialog).toBeVisible();
        // Radix's dismissable layer drops an Escape that arrives before its deferred rerender
        // registers the new dialog as the top layer (#7141). With the chunk already loaded, the
        // second open is fast enough for CI to hit that window (#7136), so press Escape again
        // while the dialog is still open. It only reaches the open dialog, never the page.
        await expect
          .poll(async () => {
            if (await dialog.isHidden()) return true;
            await browser.keyboard.press("Escape");
            return dialog.isHidden();
          })
          .toBe(true);
        await expect(row).toBeFocused();
      }
    } finally {
      // The seeded workspace is shared with every later test of this target.
      await setPlaygroundHeartbeat(app, false, 10 * 60_000);
    }
  }
);
