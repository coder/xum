import { electronTest as test, electronExpect as expect } from "../electronTest";
import {
  MOCK_ERROR_MESSAGES,
  MOCK_ERROR_PROMPTS,
  MOCK_LIST_PROGRAMMING_LANGUAGES,
} from "../mockAiPrompts";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("streaming behavior", () => {
  test("stream continues after settings opens", async ({ ui }) => {
    await ui.projects.openFirstWorkspace();

    let markSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      markSent = resolve;
    });
    const streamPromise = ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_LIST_PROGRAMMING_LANGUAGES);
      markSent();
    });

    // sendMessage waits for Send to enable after transcript catch-up. Opening Settings
    // before that replaces the composer and hides the button, so open it only once the
    // send was submitted: the stream is then starting or active, as this test intends.
    // Racing streamPromise surfaces a failed send instead of hanging on `sent`.
    await Promise.race([sent, streamPromise]);
    await ui.settings.open();
    const timeline = await streamPromise;
    await ui.settings.close();

    expect(timeline.events.some((e) => e.type === "stream-end")).toBe(true);
    await ui.chat.expectTranscriptContains("Python");
  });

  test("mode switching doesn't break streaming", async ({ ui }) => {
    await ui.projects.openFirstWorkspace();

    await ui.chat.setMode("Exec");
    await ui.chat.setMode("Plan");

    const timeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_LIST_PROGRAMMING_LANGUAGES);
    });

    expect(timeline.events.some((e) => e.type === "stream-end")).toBe(true);
    await ui.chat.expectTranscriptContains("Python");
  });

  // Consolidate error tests using parameterization
  for (const [errorType, prompt, expectedMessage] of [
    ["rate limit", MOCK_ERROR_PROMPTS.TRIGGER_RATE_LIMIT, MOCK_ERROR_MESSAGES.RATE_LIMIT],
    ["server", MOCK_ERROR_PROMPTS.TRIGGER_API_ERROR, MOCK_ERROR_MESSAGES.API_ERROR],
    ["network", MOCK_ERROR_PROMPTS.TRIGGER_NETWORK_ERROR, MOCK_ERROR_MESSAGES.NETWORK_ERROR],
  ] as const) {
    test(`${errorType} error displays in transcript`, async ({ ui, page }) => {
      await ui.projects.openFirstWorkspace();
      await ui.chat.setMode("Exec");

      const timeline = await ui.chat.captureStreamTimeline(async () => {
        await ui.chat.sendMessage(prompt);
      });

      expect(timeline.events.some((e) => e.type === "stream-error")).toBe(true);
      const transcript = page.getByRole("log", { name: "Conversation transcript" });
      await expect(transcript.getByText(expectedMessage)).toBeVisible();
    });
  }

  test("app recovers after error", async ({ ui }) => {
    await ui.projects.openFirstWorkspace();
    await ui.chat.setMode("Exec");

    await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_ERROR_PROMPTS.TRIGGER_API_ERROR);
    });

    await ui.chat.setMode("Plan");
    const timeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_LIST_PROGRAMMING_LANGUAGES);
    });

    expect(timeline.events.some((e) => e.type === "stream-end")).toBe(true);
    await ui.chat.expectTranscriptContains("Python");
  });
});
