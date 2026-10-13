// #6116: after a reply that failed with no output, the next send's server deleted that empty row,
// but the browser kept it. An edit then sent the kept row as history evidence, and the server
// refused the edit once with "History changed". Proves the first Send of such an edit goes through.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground, sendMessage, sendMessageForEdit } from "./helpers";
import { EDIT_HISTORY_CHANGED_MESSAGE } from "../../../src/constants/transcriptBarrier";

test(
  "an edit after an empty failed reply goes through on the first Send",
  { tags: ["bugbash", "6116", "mock-only"] },
  async ({ app, screen, browser }) => {
    await openPlayground(app, screen, browser);
    // Unique per attempt: repeats and retries share the run's seeded workspace.
    const stamp = Date.now();
    // The mock answers this prompt with an API error and no output, then auto-retries.
    const edit = await sendMessageForEdit(screen, browser, `[mock:error:api] 6116 ${stamp}`);
    // Wait for the retry countdown: a Stop tap during the stream would interrupt it instead.
    await expect(screen.getByText(/Retrying in/)).toBeVisible({ timeout: 20_000 });
    // The barrier's Stop button carries a shortcut hint, so match its name by prefix.
    await screen.getByRole("button", /^Stop/).tap();
    await expect(screen.getByText("Auto-retry stopped:")).toBeVisible({ timeout: 10_000 });

    // This send's server drops the empty failed reply from history.
    const followUp = `6116 follow-up ${stamp}`;
    await sendMessage(screen, followUp);
    await expect(screen.getByText(`Mock response: ${followUp}`)).toBeVisible({ timeout: 20_000 });

    await edit.tap();
    const editBox = screen.getByRole("textbox", "Edit message");
    const edited = `6116 edited ${stamp}`;
    await editBox.fill(edited);
    await screen.getByRole("button", "Send message").tap();
    const refused = screen.getByText(EDIT_HISTORY_CHANGED_MESSAGE);
    const answered = screen.getByText(`Mock response: ${edited}`);
    // Wait for whichever outcome comes first, so a refusal fails here and names the reason.
    await expect
      .poll(
        async () =>
          (await refused.isVisible()) ? "refused" : (await answered.isVisible()) ? "answered" : "",
        { timeout: 20_000 }
      )
      .toBe("answered");
  }
);
