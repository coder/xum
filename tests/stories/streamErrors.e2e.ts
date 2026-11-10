/**
 * Story: a failed reply shows its error in the chat, and the chat still works afterwards. The
 * user sends the three mock error prompts (mockAiRouter.ts: rate limit, API and network), and
 * each error's text must show in the transcript (StreamErrorMessage.tsx). Then a plain message
 * must get its normal reply. It replaces the Playwright tests "<rate limit|server|network> error
 * displays in transcript" and "app recovers after error"
 * (tests/e2e/scenarios/streamingBehavior.spec.ts).
 *
 * Auto-retry: the API and network errors retry after 1 s, 2 s, ... (retryState.ts), and the rate
 * limit after its Retry-After of 60 s. Each retry sends the same prompt, so it fails with the
 * same error. The story stops each auto-retry before its next send, and the error stays on
 * screen. A user's send turns auto-retry on again (agentSession.ts).
 */
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials, sendMessage } from "../bugbash/repros/helpers";
import { openPlayground } from "./helpers";

// The mock AI's error prompts and the error texts it replies with (mockAiRouter.ts).
const ERRORS = [
  [
    "[mock:error:rate-limit] Trigger rate limit error",
    "Rate limit exceeded. Please retry after 60 seconds.",
  ],
  [
    "[mock:error:api] Trigger API error",
    "Internal server error occurred while processing the request.",
  ],
  [
    "[mock:error:network] Trigger network error",
    "Network connection lost. Please check your internet connection.",
  ],
] as const;
const MESSAGE = "sort the seed packets";
// RetryBarrier.tsx's Stop with its shortcut hint, not StreamingBarrierView's "Stop streaming".
const STOP_RETRY = /^Stop( \(.+\))?$/;
// The mock AI's default reply (mockAiRouter.ts).
const REPLY = `Mock response: ${MESSAGE}`;

test(
  "stream errors show in the chat, and the chat recovers",
  { tags: ["story"], timeout: 600_000 },
  async ({ app, agent, browser, screen }) => {
    // e2e has no `log` role query, so CSS: the transcript is ChatPane's role="log" element.
    const transcript = browser.locator('[role="log"][aria-label="Conversation transcript"]');

    await disableTutorials(app);
    await app.open();
    // exact step: Haiku 5.5 missed this step in 10 of 14 cold failures (Phase 5)
    await openPlayground(screen);
    for (const [prompt, error] of ERRORS) {
      // exact send: Haiku 5.5 did not send an error prompt in 4 of 14 cold failures (Phase 5)
      await sendMessage(screen, prompt);
      await expect(transcript).toContainText(error, { timeout: 30_000 });
      // exact Stop: a send made while a retry streams stays "Queued" (PR lane, runs 39656243674
      // and 39670600164), and the API and network errors retry 1 s later. A check of the
      // countdown before the send cannot close that gap, so the story stops the auto-retry.
      const stop = screen.getByRole("button", STOP_RETRY);
      await expect(stop).toBeVisible({ timeout: 30_000 });
      await stop.tap();
      await expect(stop).not.toBeVisible({ timeout: 15_000 });
    }

    await sendMessage(screen, MESSAGE);
    await expect(transcript).toContainText(REPLY, { timeout: 30_000 });
    await agent.assert(
      `the chat shows the reply '${REPLY}' after the earlier errors, and no error follows it`
    );
  }
);
