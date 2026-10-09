/**
 * Seeded workspace page (#5951): the ARIA and target-size audits that Lighthouse failed on a
 * workspace with a short chat. The play checks the same facts with role queries, in a real
 * browser so the toggle's hit area is measured. Contrast is a separate decision (#5950). The
 * phone stories cover the main landmark at 390 px (#5956).
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

/**
 * landmark-one-main (#5956): the page has exactly one `main` landmark, and it holds the chat
 * (the composer), not the project sidebar, the right sidebar or the footer.
 */
async function expectOneMainLandmark(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const composer = await canvas.findByRole("textbox", { name: "Message" }, { timeout: 15_000 });
  const mains = canvas.getAllByRole("main");
  await expect(mains).toHaveLength(1);
  await expect(mains[0]).toContainElement(composer);
  await expect(within(mains[0]).queryByRole("navigation", { name: "Projects" })).toBeNull();
  await expect(
    within(mains[0]).queryByRole("complementary", { name: "Workspace insights" })
  ).toBeNull();
  // The workspace footer is the page's contentinfo landmark. Inside `main` it would stop being one.
  await expect(canvas.getByRole("contentinfo")).toBeInTheDocument();
  await expect(within(mains[0]).queryByRole("contentinfo")).toBeNull();
}

/** Space between the right sidebar's tabs and the "+" button. */
const TAB_GAP_PX = 4;

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
  // The tablist renders its own box: Safari has dropped the role of `display: contents`
  // elements, which have no client rects (#5962).
  await expect(tablist.getClientRects().length).toBeGreaterThan(0);
  // "+" stays right after the last tab, in the same row, when the tabs wrap.
  const tabs = within(tablist).getAllByRole("tab");
  const lastTab = tabs[tabs.length - 1].getBoundingClientRect();
  const add = addTerminal.getBoundingClientRect();
  await expect(Math.abs(add.left - (lastTab.right + TAB_GAP_PX))).toBeLessThan(1);
  await expect(
    Math.abs(add.top + add.height / 2 - (lastTab.top + lastTab.height / 2))
  ).toBeLessThan(1);

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
    await expectOneMainLandmark(canvasElement);
  },
});

export const Light = contractStory("light");
export const Dark = contractStory("dark");

/** Phone width (390 px, iPhone 16e). */
const PHONE_WIDTH_PX = 390;

/**
 * Phone layout (#5956): Lighthouse's mobile preset found no main landmark. The test-runner applies
 * neither `globals.viewport` nor Pixel viewports, so a fixed-width wrapper frames the page at
 * 390 px for the play. The landmark does not depend on the media query, so the assertion holds
 * at the real phone viewport too (`globals.viewport` shows that locally).
 */
const phoneStory = (theme: ThemeMode): AppStory => ({
  globals: { theme, viewport: { value: "mobile2", isRotated: false } },
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  decorators: [
    (Story) => (
      <div style={{ width: PHONE_WIDTH_PX, height: 844, overflow: "hidden" }}>
        <Story />
      </div>
    ),
  ],
  render: renderSeededWorkspace,
  play: async ({ canvasElement }) => {
    await expectOneMainLandmark(canvasElement);
  },
});

export const PhoneLight = phoneStory("light");
export const PhoneDark = phoneStory("dark");
