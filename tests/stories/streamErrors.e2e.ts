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
 * same error. A user's next send cancels the pending retry (agentSession.ts), so every error
 * stays on screen until the next prompt.
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
    }

    // exact send: Haiku 5.5 sent this while a network-error retry streamed, so it stayed
    // "Queued" (PR lane, runs 39656243674 and 39670600164). The countdown (RetryBarrier.tsx)
    // shows only between attempts, when no stream runs, and the send cancels that retry.
    await expect(screen.getByText(/Retrying in/)).toBeVisible({ timeout: 30_000 });
    await sendMessage(screen, MESSAGE);
    await expect(transcript).toContainText(REPLY, { timeout: 30_000 });
    await agent.assert(
      `the chat shows the reply '${REPLY}' after the earlier errors, and no error follows it`
    );
  }
);
