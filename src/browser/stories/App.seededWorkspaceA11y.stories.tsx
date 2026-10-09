/**
 * Seeded workspace page (#5951): the ARIA and target-size audits that Lighthouse failed on a
 * workspace with a short chat. The play checks the same facts with role queries, in a real
 * browser so the toggle's hit area is measured. Contrast is a separate decision (#5950).
 */

import { expect, waitFor, within } from "@storybook/test";

import type { ThemeMode } from "@/browser/contexts/ThemeContext";

import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { expandLeftSidebar, expandRightSidebar } from "./helpers/uiState";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";

export default {
  ...appMeta,
  title: "App/SeededWorkspaceA11y",
};

/** Lighthouse's seeded page: one project, one workspace with a 4-message chat, both sidebars open. */
const renderSeededWorkspace = () => (
  <AppWithMocks
    setup={() => {
      const client = setupSimpleChatStory({
        workspaceId: "ws-a11y-seeded",
        workspaceName: "a11y-seeded",
        projectName: "xum",
        messages: [
          createUserMessage("msg-1", "What does this repo do?", {
            historySequence: 1,
            timestamp: STABLE_TIMESTAMP - 60_000,
          }),
          createAssistantMessage("msg-2", "It is a desktop app for parallel agent work.", {
            historySequence: 2,
            timestamp: STABLE_TIMESTAMP - 50_000,
          }),
          createUserMessage("msg-3", "Where is the composer?", {
            historySequence: 3,
            timestamp: STABLE_TIMESTAMP - 40_000,
          }),
          createAssistantMessage("msg-4", "In src/browser/features/ChatInput.", {
            historySequence: 4,
            timestamp: STABLE_TIMESTAMP - 30_000,
          }),
        ],
      });
      expandLeftSidebar();
      expandRightSidebar();
      return client;
    }}
  />
);

/** WCAG 2.2 target-size minimum (Lighthouse `target-size`). */
const MIN_TARGET_PX = 24;

async function expectSeededPageAudits(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);

  // aria-allowed-attr: the composer is a textbox, and a textbox does not take aria-expanded.
  const composer = await canvas.findByRole("textbox", { name: "Message" }, { timeout: 15_000 });
  await expect(composer).not.toHaveAttribute("aria-expanded");

  // aria-required-children: the tablist owns only tabs. The "+" button stays next to it.
  const tablist = await canvas.findByRole("tablist", { name: "Sidebar views" });
  await expect(within(tablist).getAllByRole("tab").length).toBeGreaterThan(0);
  const nonTabChildren = Array.from(
    tablist.querySelectorAll<HTMLElement>("button, a[href], input, [role]")
  )
    .filter((element) => element.closest('[role="tab"]') === null)
    .map((element) => element.getAttribute("aria-label") ?? element.outerHTML.slice(0, 80));
  await expect(nonTabChildren).toEqual([]);
  const tabStrip = tablist.parentElement;
  if (!tabStrip) throw new Error("Tab strip not rendered");
  const addTerminal = within(tabStrip).getByRole("button", { name: "New terminal" });
  // The sidebar fades in, so wait for it before checking visibility.
  await waitFor(() => expect(addTerminal).toBeVisible());

  // button-name: icon-only and combobox triggers need a name of their own.
  await expect(await canvas.findByRole("button", { name: "Open in editor" })).toBeVisible();
  await expect(await canvas.findByRole("combobox", { name: /^Model: \S/ })).toBeVisible();

  // target-size: the project toggle's hit area is at least 24x24 px.
  const toggle = await canvas.findByRole("button", { name: /^(Expand|Collapse) project xum$/ });
  await waitFor(async () => {
    const rect = toggle.getBoundingClientRect();
    await expect(rect.width).toBeGreaterThanOrEqual(MIN_TARGET_PX);
    await expect(rect.height).toBeGreaterThanOrEqual(MIN_TARGET_PX);
  });
}

// Behavioral contract only, so Pixel snapshots are off. The screenshots on #5951's PR show
// the page at phone and laptop widths in both themes.
const contractStory = (theme: ThemeMode): AppStory => ({
  globals: { theme },
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  render: renderSeededWorkspace,
  play: async ({ canvasElement }) => {
    await expectSeededPageAudits(canvasElement);
  },
});

export const Light = contractStory("light");
export const Dark = contractStory("dark");
