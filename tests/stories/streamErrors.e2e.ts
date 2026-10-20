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
import { disableTutorials, WORKSPACE_TITLE } from "../bugbash/repros/helpers";

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
  async ({ app, agent, browser }) => {
    // e2e has no `log` role query, so CSS: the transcript is ChatPane's role="log" element.
    const transcript = browser.locator('[role="log"][aria-label="Conversation transcript"]');

    await disableTutorials(app);
    await app.open();
    await agent.act(`open the '${WORKSPACE_TITLE}' workspace in the left sidebar`);
    for (const [prompt, error] of ERRORS) {
      await agent.act(
        "send the chat message {prompt} exactly as written, and wait until the chat shows an " +
          "error for it",
        { params: { prompt } }
      );
      await expect(transcript).toContainText(error, { timeout: 30_000 });
    }

    await agent.act(`send the chat message '${MESSAGE}' and wait for the reply`);
    await expect(transcript).toContainText(REPLY, { timeout: 30_000 });
    await agent.assert(
      `the chat shows the reply '${REPLY}' after the earlier errors, and no error follows it`
    );
  }
);
