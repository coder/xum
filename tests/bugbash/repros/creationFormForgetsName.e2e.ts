// N3 (#5670): after a create from the default form, the form offered the same workspace name again,
// and that create collided with the branch. Proves the name field is empty on the next visit.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials } from "./helpers";

test(
  "the creation form forgets the name of the workspace it just created",
  { tags: ["bugbash", "N3"] },
  async ({ app, screen, browser }) => {
    await disableTutorials(browser);
    // The app opens on the project's default creation form.
    await app.open();
    const name = screen.getByRole("textbox", "workspace-name");
    await expect(name).toBeVisible({ timeout: 15_000 });

    // Focusing the field turns auto-naming off, so the typed name is the one submitted.
    await name.fill("n3-repro");
    await screen.getByRole("textbox", "Message").fill("create from the default form");
    await screen.getByRole("button", "Send message").tap();
    // The new workspace opens; its menu bar shows the notifications button.
    await expect(screen.getByRole("button", "Notifications")).toBeVisible({
      timeout: 30_000,
    });

    // Back to the default form of the same project.
    await screen.getByRole("textbox", "Message").tap();
    await browser.keyboard.press("Control+n");
    await expect(name).toBeVisible({ timeout: 15_000 });
    await expect(name).toHaveValue("");
  }
);
