import { electronTest as test, electronExpect as expect } from "../electronTest";
import {
  MOCK_COMPACTION_SUMMARY_PREFIX,
  MOCK_SLASH_COMMAND_PROMPTS,
  MOCK_TOOL_FLOW_PROMPTS,
} from "../mockAiPrompts";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("slash command flows", () => {
  test("slash command /clear resets conversation history", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_TOOL_FLOW_PROMPTS.FILE_READ);
    });
    await ui.chat.expectTranscriptContains("Mock README content");

    await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_TOOL_FLOW_PROMPTS.LIST_DIRECTORY);
    });
    await ui.chat.expectTranscriptContains("Directory listing:");

    await ui.chat.sendMessage("/clear");
    // Confirm the destructive action in the modal
    await page.getByRole("button", { name: "Clear" }).click();
    await ui.chat.expectStatusMessageContains("Chat history cleared");

    const transcript = page.getByRole("log", { name: "Conversation transcript" });
    await expect(transcript.getByText("No Messages Yet")).toBeVisible();
    await expect(transcript).not.toContainText("Mock README content");
    await expect(transcript).not.toContainText("Directory listing:");
  });

  test("slash command /compact produces compacted summary", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    const setupPrompts = [
      MOCK_TOOL_FLOW_PROMPTS.FILE_READ,
      MOCK_TOOL_FLOW_PROMPTS.LIST_DIRECTORY,
      MOCK_TOOL_FLOW_PROMPTS.CREATE_TEST_FILE,
      MOCK_TOOL_FLOW_PROMPTS.READ_TEST_FILE,
    ];

    for (const prompt of setupPrompts) {
      await ui.chat.captureStreamTimeline(async () => {
        await ui.chat.sendMessage(prompt);
      });
    }

    await ui.chat.captureStreamTimeline(
      async () => {
        await ui.chat.sendMessage("/compact -t 500");
      },
      { timeoutMs: 20_000 }
    );

    await ui.chat.expectStatusMessageContains("Compaction started");

    // Compaction now appends a summary boundary to the existing transcript.
    const transcript = page.getByRole("log", { name: "Conversation transcript" });
    await ui.chat.expectTranscriptContains(MOCK_COMPACTION_SUMMARY_PREFIX);
    await expect(transcript).toContainText(MOCK_COMPACTION_SUMMARY_PREFIX);
    await expect(transcript).toContainText("Compaction boundary");
    // With skip=0 (latest boundary only) replay, compaction prunes pre-boundary
    // messages from the live view. They are accessible via "Load older messages".
    await expect(transcript).not.toContainText("Resume after compaction");
    await expect(transcript).not.toContainText("Mock README content");
    await expect(transcript).not.toContainText("Directory listing:");
  });

  test("slash command /model sonnet switches models for subsequent turns", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    const modeToggles = page.locator('[data-component="ChatModeToggles"]');
    // Default model is Opus 5.1 - displayed as formatted name
    await expect(modeToggles.getByText("Opus 5.1", { exact: true })).toBeVisible();

    await ui.chat.sendMessage("/model sonnet");
    await ui.chat.expectStatusMessageContains("Model changed to anthropic:claude-sonnet-5");
    // Model is displayed as formatted name
    await expect(modeToggles.getByText("Sonnet 5", { exact: true })).toBeVisible();

    const timeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_SLASH_COMMAND_PROMPTS.MODEL_STATUS);
    });

    const streamStart = timeline.events.find((event) => event.type === "stream-start");
    expect(streamStart?.model).toBe("anthropic:claude-sonnet-5");
    await ui.chat.expectTranscriptContains(
      "Claude Sonnet 5 is now responding with standard reasoning capacity."
    );
  });
});
