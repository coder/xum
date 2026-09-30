import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "@/browser/stories/meta.js";
import { expect, waitFor, within, userEvent } from "@storybook/test";
import {
  getSettingsDialog,
  openSettingsDialog,
  waitForChatInputAutofocusDone,
} from "@/browser/stories/storyPlayHelpers.js";
import type { LayoutPresetsConfig } from "@/common/types/uiLayouts";
import { setupSettingsStory } from "./Sections/settingsStoryUtils.js";

export default {
  ...appMeta,
  title: "Settings/SettingsPage",
};

const BASE_SECTION_LABELS = [
  "General",
  "Agents",
  "Providers",
  "Models",
  "MCP",
  "Secrets",
  "Security",
  "Server Access",
  "Layouts",
  "Runtimes",
  "Experiments",
  "Keybinds",
  "Backup",
] as const;

type BaseSectionLabel = (typeof BASE_SECTION_LABELS)[number];

const SECTION_CONTENT_MATCHERS: Record<BaseSectionLabel, RegExp> = {
  General: /Theme/i,
  Agents: /Max Parallel Agent Tasks/i,
  Providers: /Configure API keys and endpoints for AI providers|API Key/i,
  Models: /Custom Models|Built-in Models/i,
  MCP: /MCP Servers/i,
  Secrets: /Secrets are stored in/i,
  Security: /Project Trust/i,
  "Server Access": /Server access sessions/i,
  Layouts: /Layout Slots|Add layout/i,
  Runtimes: /Default runtime/i,
  Experiments: /Experimental features that are still in development/i,
  Keybinds: /Open agent picker/i,
  Backup: /Settings backup/i,
};

async function openSettings(canvasElement: HTMLElement): Promise<HTMLElement> {
  const canvas = within(canvasElement);
  // Phone renders start with the left sidebar (and its settings button) collapsed.
  await waitFor(() =>
    expect(
      canvas.queryByTestId("settings-button") ??
        canvas.queryByRole("button", { name: "Open sidebar menu" })
    ).not.toBeNull()
  );
  if (!canvas.queryByTestId("settings-button")) {
    await userEvent.click(canvas.getByRole("button", { name: "Open sidebar menu" }));
  }
  return openSettingsDialog(canvasElement);
}

async function clickSectionButton(dialog: HTMLElement, sectionLabel: string): Promise<void> {
  await userEvent.click(
    await within(dialog).findByRole("button", { name: new RegExp(`^${sectionLabel}$`, "i") })
  );
}

async function assertSectionBodyRendered(
  dialog: HTMLElement,
  sectionLabel: BaseSectionLabel
): Promise<void> {
  const settings = within(dialog);
  const sectionContentMatcher = SECTION_CONTENT_MATCHERS[sectionLabel];

  await waitFor(
    () => {
      if (settings.queryAllByText(sectionContentMatcher).length === 0) {
        throw new Error(`Expected ${sectionLabel} section content to render.`);
      }
    },
    { timeout: 2500 }
  );
}

async function waitForSettingsClosed(): Promise<void> {
  await waitFor(() =>
    expect(within(document.body).queryByRole("dialog", { name: "Settings" })).toBeNull()
  );
}

// Radix's DismissableLayer ignores Escape until one more render after the dialog mounts: its
// `isHighestLayer` check uses a layer index computed during render, and the layer registers in
// an effect that then forces that re-render. Nothing in the DOM marks the moment, so under CI
// load a play that presses Escape right after the dialog appears can have the key dropped
// (#5127). Press again while the dialog is still open; stop once it starts closing, so no extra
// Escape reaches the element that gets focus back.
async function closeSettingsWithEscape(): Promise<void> {
  await waitFor(
    async () => {
      const dialog = within(document.body).queryByRole("dialog", { name: "Settings" });
      if (dialog?.getAttribute("data-state") === "open") {
        await userEvent.keyboard("{Escape}");
      }
      await expect(within(document.body).queryByRole("dialog", { name: "Settings" })).toBeNull();
    },
    { timeout: 5000 }
  );
}

export const SectionsSmoke: AppStory = {
  // Pixel budget: the App task, advisor, and compaction settings stories already capture this
  // dialog on desktop, so this file's snapshot slot goes to PhoneFullScreen.
  parameters: { pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={() => setupSettingsStory({})} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const dialog = await openSettings(canvasElement);

    for (const sectionLabel of BASE_SECTION_LABELS) {
      await clickSectionButton(dialog, sectionLabel);
      await assertSectionBodyRendered(dialog, sectionLabel);
    }
  },
};

const LAYOUT_PRESET = {
  version: 2,
  slots: [
    {
      slot: 1,
      preset: {
        id: "preset-1",
        name: "My Layout",
        leftSidebarCollapsed: false,
        rightSidebar: {
          collapsed: true,
          width: { mode: "px", value: 400 },
          layout: {
            version: 1,
            nextId: 2,
            focusedTabsetId: "tabset-1",
            root: { type: "tabset", id: "tabset-1", tabs: ["costs"], activeTab: "costs" },
          },
        },
      },
    },
  ],
} satisfies LayoutPresetsConfig;

// Real-browser Escape routing: an inline editor inside the modal cancels its own edit without
// closing settings, while an unclaimed Escape closes the modal.
export const EscapeInInlineEditor: AppStory = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={() => setupSettingsStory({ layoutPresets: LAYOUT_PRESET })} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const dialog = await openSettings(canvasElement);
    const settings = within(dialog);
    await clickSectionButton(dialog, "Layouts");

    await userEvent.dblClick(await settings.findByText("My Layout"));
    const rename = await settings.findByRole("textbox", { name: "Rename layout Slot 1" });
    await expect(rename).toHaveFocus();
    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(settings.queryByRole("textbox", { name: "Rename layout Slot 1" })).toBeNull()
    );
    await expect(getSettingsDialog()).toBe(dialog);
    await expect(settings.getByText("My Layout")).toBeVisible();

    dialog.focus();
    await userEvent.keyboard("{Escape}");
    await waitForSettingsClosed();
    // Settings has no DialogTrigger, so focus must be returned to the opener explicitly.
    await waitFor(() => expect(within(canvasElement).getByTestId("settings-button")).toHaveFocus());
  },
};

// The palette item and model-selector entry that open settings unmount as it opens, so closing
// must return focus to the chat input they came from instead of leaving it on the body.
export const FocusReturnsWhenOpenerUnmounts: AppStory = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={() => setupSettingsStory({})} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitForChatInputAutofocusDone(canvasElement);
    const chatInput = canvasElement.querySelector<HTMLElement>(
      '[data-component="ChatInputSection"]'
    );
    if (!chatInput) {
      throw new Error("Chat input section not found");
    }
    const composer = within(chatInput).getByRole("textbox");

    await userEvent.click(composer);
    await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    await userEvent.keyboard(">Settings: Models{Enter}");
    await body.findByRole("dialog", { name: "Settings" });
    await closeSettingsWithEscape();
    await waitFor(() => expect(composer).toHaveFocus());
    await userEvent.keyboard("typed");
    await expect(composer).toHaveValue("typed");

    const modelSelector = chatInput.querySelector<HTMLElement>(
      '[data-component="ModelSelectorGroup"]'
    );
    if (!modelSelector) {
      throw new Error("Model selector not found");
    }
    await userEvent.click(within(modelSelector).getByRole("combobox"));
    await userEvent.click(await body.findByRole("button", { name: "Model settings" }));
    await body.findByRole("dialog", { name: "Settings" });
    await closeSettingsWithEscape();
    await waitFor(() => expect(composer).toHaveFocus());
  },
};

const phoneParameters = { pixel: { matrix: { viewports: ["phone"] } } };

// Ends with settings open so the phone capture shows the full-screen sheet.
export const PhoneFullScreen: AppStory = {
  render: () => <AppWithMocks setup={() => setupSettingsStory({})} />,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: phoneParameters,
  play: async ({ canvasElement, parameters }) => {
    await expect(parameters.pixel).toEqual(phoneParameters.pixel);
    const dialog = await openSettings(canvasElement);
    await clickSectionButton(dialog, "Providers");
    await assertSectionBodyRendered(dialog, "Providers");

    // The test-runner plays at desktop size; only Pixel/manager pin the phone width.
    if (window.innerWidth < 768) {
      const rect = dialog.getBoundingClientRect();
      await expect(rect.left).toBe(0);
      await expect(rect.width).toBe(window.innerWidth);
      await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
      const close = within(dialog).getByRole("button", { name: "Close settings" });
      await expect(close.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    }
  },
};
