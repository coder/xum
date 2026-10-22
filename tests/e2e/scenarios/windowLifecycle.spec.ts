import { electronTest as test, electronExpect as expect } from "../electronTest";
import { MOCK_LIST_PROGRAMMING_LANGUAGES } from "../mockAiPrompts";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("window lifecycle", () => {
  test("window opens with expected structure", async ({ page }) => {
    await expect(page.getByRole("navigation", { name: "Projects" })).toBeVisible();
    await expect(page.locator("main, #root, .app-container").first()).toBeVisible();
    await expect(page.getByRole("dialog", { name: /error/i })).not.toBeVisible();
  });

  // Exercises IPC handler stability under heavy use (regression: #851 duplicate handler registration)
  test("IPC stable after heavy operations", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    // Many IPC calls: stream + mode switches + settings navigation
    const timeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_LIST_PROGRAMMING_LANGUAGES);
    });
    expect(timeline.events.some((e) => e.type === "stream-end")).toBe(true);

    await ui.chat.setMode("Exec");
    await ui.chat.setMode("Plan");
    await ui.settings.open();
    await ui.settings.selectSection("Providers");
    await ui.settings.close();

    // Verify app remains functional after all IPC calls
    await expect(page.getByRole("navigation", { name: "Projects" })).toBeVisible();
    await ui.chat.expectTranscriptContains("Python");
  });
});
