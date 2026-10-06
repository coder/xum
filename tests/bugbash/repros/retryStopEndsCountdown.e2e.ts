// B1 (#5670): Stop or Escape during an auto-retry countdown left the banner stuck on "Retrying…".
// Proves that both ways out end the countdown and the banner says auto-retry stopped.
import { test } from "@e2e-dev/web";
import type { Screen } from "e2e";
import { expect } from "e2e";
import { openPlayground, sendMessage } from "./helpers";

// The mock answers this prompt with a rate-limit error on every attempt, so auto-retry keeps
// counting down (no Retry-After: the backoff starts at 2 s and doubles).
const RATE_LIMIT_PROMPT = "[mock:error:rate-limit] Trigger rate limit error";

async function startRetryCountdown(screen: Screen): Promise<void> {
  await sendMessage(screen, RATE_LIMIT_PROMPT);
  await expect(screen.getByText(/Retrying in/)).toBeVisible({ timeout: 20_000 });
}

async function expectRetryEnded(screen: Screen): Promise<void> {
  await expect(screen.getByText("Auto-retry stopped:")).toBeVisible({ timeout: 10_000 });
  await expect(screen.getByText(/Retrying/)).toBeHidden();
}

test(
  "Stop during the auto-retry countdown ends the retry banner",
  { tags: ["bugbash", "B1", "mock-only"] },
  async ({ app, screen, browser }) => {
    await openPlayground(app, screen, browser);
    await startRetryCountdown(screen);
    // The barrier's Stop button carries a shortcut hint, so match its name by prefix.
    await screen.getByRole("button", /^Stop/).tap();
    await expectRetryEnded(screen);
  }
);

test(
  "Escape during the auto-retry countdown ends the retry banner",
  { tags: ["bugbash", "B1", "mock-only"] },
  async ({ app, screen, browser }) => {
    await openPlayground(app, screen, browser);
    await startRetryCountdown(screen);
    await browser.keyboard.press("Escape");
    await expectRetryEnded(screen);
  }
);
