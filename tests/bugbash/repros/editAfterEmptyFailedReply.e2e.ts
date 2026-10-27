// #6116: after a reply that failed with no output, the next send's server deleted that empty row,
// but the browser kept it. An edit then sent the kept row as history evidence, and the server
// refused the edit once with "History changed". Proves the first Send of such an edit goes through.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground, sendMessageForEdit } from "./helpers";
import { WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE } from "../../../src/constants/agentMessaging";
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

    // This send's server drops the empty failed reply from history. "Auto-retry stopped" shows
    // before the Stop has settled, and the UI has no signal for that point (the stop latch's
    // release): a send in between is refused as retryable (#7655). So send again after each such
    // refusal, as its message asks ("retry once it has settled"). Any other refusal fails here.
    // The UI should wait for the Stop instead: #7658.
    const followUp = `6116 follow-up ${stamp}`;
    const composer = screen.getByRole("textbox", "Message");
    const followUpAnswered = screen.getByText(`Mock response: ${followUp}`);
    const stopBusy = screen.getByText(WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE);
    // Any error toast, whatever its title: an alert has no accessible name, and refusal titles
    // vary, so match the toast by its Dismiss button.
    const sendFailed = screen
      .getByRole("alert")
      .filter({ has: screen.getByRole("button", "Dismiss") })
      .first();
    const outcome = async () =>
      (await followUpAnswered.isVisible())
        ? "answered"
        : (await stopBusy.isVisible())
          ? "stop in progress"
          : (await sendFailed.isVisible())
            ? "refused"
            : "";
    const deadline = Date.now() + 20_000;
    await composer.fill(followUp);
    for (;;) {
      await screen.getByRole("button", "Send message").tap();
      await expect.poll(outcome, { timeout: Math.max(deadline - Date.now(), 1) }).not.toBe("");
      const seen = await outcome();
      if (seen !== "stop in progress") {
        expect(seen).toBe("answered");
        break;
      }
      await screen.getByRole("button", "Dismiss").tap();
      // Dismissing clears the toast after its fade: a refusal shown before then would go too.
      await expect(stopBusy).not.toBeVisible();
      // The refused text comes back into the composer.
      await expect(composer).toHaveValue(followUp);
      // A Stop that never settles must fail here, not resend until the runner's global timeout.
      if (Date.now() >= deadline) {
        throw new Error("the Stop did not settle within 20 s: every follow-up send was refused");
      }
    }

    // The reply text shows while it still streams. An edit tapped mid-stream was refused as
    // "History changed" in 1 of 6 phone runs. This test covers an edit after the reply, so wait
    // for the stream to end.
    await expect(screen.getByRole("button", "Stop streaming")).not.toBeVisible({ timeout: 20_000 });

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
