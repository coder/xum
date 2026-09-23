import { electronTest as test, electronExpect as expect } from "../electronTest";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("Settings", () => {
  test("opens settings via gear button", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    // Open settings
    await ui.settings.open();

    // The titlebar settings control now acts as the close toggle while settings are open.
    await expect(page.getByTestId("settings-button")).toHaveAttribute(
      "aria-label",
      "Close settings"
    );

    // Verify sidebar sections are present
    await expect(page.getByRole("button", { name: "General", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Providers", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Models", exact: true })).toBeVisible();

    // Verify default section is General (theme toggle visible)
    await expect(page.getByText("Theme", { exact: true })).toBeVisible();
  });

  test("navigates between settings sections", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();

    // Navigate to Providers section
    await ui.settings.selectSection("Providers");
    await expect(page.getByText(/Configure API keys and endpoints/i)).toBeVisible();

    // Navigate to Models section
    await ui.settings.selectSection("Models");
    await expect(page.getByPlaceholder(/model-id/i)).toBeVisible();

    // Navigate back to General
    await ui.settings.selectSection("General");
    await expect(page.getByText("Theme", { exact: true })).toBeVisible();
  });

  test("closes settings with the titlebar toggle button", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();

    const closeButton = page.getByTestId("settings-button");
    await expect(closeButton).toHaveAttribute("aria-label", "Close settings");
    await closeButton.click();

    await ui.settings.expectClosed();
  });

  test("returns to previous page when closing settings", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();
    await ui.settings.selectSection("Providers");

    await ui.settings.close();

    await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
  });

  test("expands provider accordion in Providers section", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();
    await ui.settings.selectSection("Providers");

    // Expand Anthropic provider
    await ui.settings.expandProvider("Anthropic");

    // Verify accordion content is visible - use exact matches to avoid ambiguity
    await expect(page.getByText("API Key", { exact: true })).toBeVisible();
    await expect(page.getByText(/Base URL/, { exact: false })).toBeVisible();
  });

  test("shows all provider names correctly", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();
    await ui.settings.selectSection("Providers");

    // Verify all providers are listed with correct display names
    await expect(page.getByRole("button", { name: /Anthropic/i })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /OpenAI/i }).filter({ has: page.getByText("OpenAI icon") })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Google/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /xAI/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Ollama/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /OpenRouter/i })).toBeVisible();
  });

  test("Models section shows add form", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();
    await ui.settings.selectSection("Models");

    // Verify add model form elements
    await expect(page.getByText("Custom Models")).toBeVisible();
    // Scope to the add form: the model tables now render per-model "Min Thinking" comboboxes,
    // so an unscoped combobox locator would be ambiguous.
    const addForm = page
      .locator("div")
      .filter({ has: page.getByPlaceholder(/model-id/i) })
      .filter({ has: page.getByRole("button", { name: /^Add$/i }) })
      .last();
    // The add row has two comboboxes: the provider dropdown and the editable Model ID field.
    await expect(addForm.getByRole("combobox", { name: "Provider" })).toBeVisible();
    await expect(addForm.getByRole("combobox", { name: "Model ID" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Add$/i })).toBeVisible();
  });

  test("provider settings updates propagate without reload", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();
    await ui.settings.selectSection("Providers");

    // Expand OpenAI provider - use the specific button with OpenAI icon
    const openaiButton = page
      .getByRole("button", { name: /OpenAI/i })
      .filter({ has: page.getByText("OpenAI icon") });
    await expect(openaiButton).toBeVisible();
    await openaiButton.click();

    // Wait for the provider section to expand - API Key label should be visible
    await expect(page.getByText("API Key", { exact: true })).toBeVisible();

    // Verify API key is not set initially (shows "Not set")
    await expect(page.getByText("Not set").first()).toBeVisible();

    // Click "Set" to enter edit mode - it's a text link, not a button role
    const setLink = page.getByText("Set", { exact: true }).first();
    await setLink.click();

    // The password input should appear with autofocus
    const apiKeyInput = page.locator('input[type="password"]');
    await expect(apiKeyInput).toBeVisible();
    await apiKeyInput.fill("sk-test-key-12345");

    // Save by pressing Enter (the input has onKeyDown handler for Enter)
    await page.keyboard.press("Enter");

    // Verify the field now shows as set (masked value)
    await expect(page.getByText("••••••••")).toBeVisible();

    // Close settings
    await ui.settings.close();

    // Re-open settings and verify the change persisted without reload
    await ui.settings.open();
    await ui.settings.selectSection("Providers");

    // Expand OpenAI again
    await openaiButton.click();
    await expect(page.getByText("API Key", { exact: true })).toBeVisible();

    // The API key should still show as set
    await expect(page.getByText("••••••••")).toBeVisible();

    // The provider should show as configured (status indicator dot)
    const configuredIndicator = openaiButton.locator('[title="Configured"]');
    await expect(configuredIndicator).toBeVisible();
  });
});
