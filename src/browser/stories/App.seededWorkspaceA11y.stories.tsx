/**
 * Seeded workspace page (#5951): the ARIA and target-size audits that Lighthouse failed on a
 * workspace with a short chat. The play checks the same facts with role queries, in a real
 * browser so the toggle's hit area is measured. Contrast is a separate decision (#5950). The
 * phone stories cover the main landmark at 390 px (#5956). The landmark stories at the end cover
 * the layouts without a chat pane: immersive review and the pages with no workspace (#5969),
 * the shell's "No Workspace Selected" placeholder (#5998), and the "Loading Xum" startup screen
 * (#6017).
 */

import { expect, userEvent, waitFor, within } from "@storybook/test";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import {
  getReviewImmersiveKey,
  getRightSidebarLayoutKey,
  RIGHT_SIDEBAR_WIDTH_KEY,
} from "@/common/constants/storage";
import type { ProjectConfig } from "@/node/config";
import type { RightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";

import type { ThemeMode } from "@/browser/contexts/ThemeContext";

import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { expandLeftSidebar, expandProjects, expandRightSidebar } from "./helpers/uiState";
import { createMockORPCClient } from "./mocks/orpc";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";

export default {
  ...appMeta,
  title: "App/SeededWorkspaceA11y",
};

/** Lighthouse's seeded page: one project, one workspace with a 4-message chat, both sidebars open. */
function renderSeededClient() {
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
}

const renderSeededWorkspace = () => <AppWithMocks setup={renderSeededClient} />;

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
  const addTab = within(tabStrip).getByRole("button", { name: "New tab", exact: true });
  // The launcher replaces direct terminal creation but must remain outside the tablist.
  // The sidebar fades in, so wait for it before checking visibility.
  await waitFor(() => expect(addTab).toBeVisible());
  // The tablist renders its own box: Safari has dropped the role of `display: contents`
  // elements, which have no client rects (#5962).
  await expect(tablist.getClientRects().length).toBeGreaterThan(0);
  // The launcher stays beside the scrolling row, not after an offscreen last tab.
  const row = tablist.getBoundingClientRect();
  const add = addTab.getBoundingClientRect();
  await expect(Math.abs(add.left - (row.right + TAB_GAP_PX))).toBeLessThan(1);
  await expect(Math.abs(add.top + add.height / 2 - (row.top + row.height / 2))).toBeLessThan(1);

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

/**
 * Narrowest right sidebar (#5962). The right sidebar is hidden at phone width, so its narrowest
 * real layout is the minimum sidebar width. Open tabs scroll within one row while "+" stays
 * visible beside it; neither the row nor the launcher may overflow the sidebar.
 */
const NARROW_SIDEBAR_WIDTH_PX = 300;

const narrowSidebarStory = (theme: ThemeMode): AppStory => ({
  globals: { theme },
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  render: () => (
    <AppWithMocks
      setup={() => {
        const client = renderSeededClient();
        updatePersistedState(RIGHT_SIDEBAR_WIDTH_KEY, NARROW_SIDEBAR_WIDTH_PX);
        // Fresh workspaces have only a launcher; seed enough opened tools to exercise overflow.
        updatePersistedState<RightSidebarLayoutState>(getRightSidebarLayoutKey("ws-a11y-seeded"), {
          version: 1,
          openTabsOnly: true,
          nextId: 2,
          focusedTabsetId: "tabset-1",
          root: {
            type: "tabset",
            id: "tabset-1",
            tabs: ["stats", "review", "explorer", "terminal", "output", "new"],
            activeTab: "new",
          },
        });
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tablist = await canvas.findByRole(
      "tablist",
      { name: "Sidebar views" },
      { timeout: 15_000 }
    );
    const sidebar = canvas.getByRole("complementary", { name: "Workspace insights" });
    await waitFor(() =>
      expect(sidebar.getBoundingClientRect().width).toBe(NARROW_SIDEBAR_WIDTH_PX)
    );
    await expect(tablist.getClientRects().length).toBeGreaterThan(0);
    const tabs = within(tablist).getAllByRole("tab");
    const addTab = within(sidebar).getByRole("button", { name: "New tab", exact: true });
    await waitFor(() => expect(addTab).toBeVisible());
    const bounds = sidebar.getBoundingClientRect();
    for (const element of [tablist, addTab]) {
      const rect = element.getBoundingClientRect();
      await expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
      await expect(rect.right).toBeLessThanOrEqual(bounds.right);
    }
    await expect(tablist.scrollWidth).toBeGreaterThan(tablist.clientWidth);
    const rows = new Set(
      [...tabs, addTab].map((element) => {
        const rect = element.getBoundingClientRect();
        return Math.round(rect.top + rect.height / 2);
      })
    );
    await expect(rows.size).toBe(1);
    await expect(tablist).not.toContainElement(addTab);
    const row = tablist.getBoundingClientRect();
    const add = addTab.getBoundingClientRect();
    await expect(Math.abs(add.left - (row.right + TAB_GAP_PX))).toBeLessThan(1);
  },
});

export const NarrowSidebarLight = narrowSidebarStory("light");
export const NarrowSidebarDark = narrowSidebarStory("dark");

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

/**
 * Layouts without a chat pane (#5969): immersive review hides the chat, and the root, project and
 * scratch pages have no workspace. Each still needs exactly one `main` landmark, holding its
 * primary content and none of the sidebars. Where a footer exists it stays outside `main`.
 */
async function expectOneMainHolding(canvasElement: HTMLElement, content: HTMLElement) {
  const canvas = within(canvasElement);
  const mains = canvas.getAllByRole("main");
  await expect(mains).toHaveLength(1);
  await expect(mains[0]).toContainElement(content);
  const main = within(mains[0]);
  await expect(main.queryByRole("navigation", { name: "Projects" })).toBeNull();
  await expect(main.queryByRole("complementary", { name: "Workspace insights" })).toBeNull();
  await expect(main.queryByRole("contentinfo")).toBeNull();
}

const REVIEW_WORKSPACE_ID = "ws-a11y-review";
const REVIEW_DIFF = `diff --git a/src/a11y/landmarks.ts b/src/a11y/landmarks.ts
index 1111111..2222222 100644
--- a/src/a11y/landmarks.ts
+++ b/src/a11y/landmarks.ts
@@ -1,3 +1,4 @@
 export const LANDMARKS = ["main"];
+export const ONE_MAIN = true;
 export const VERSION = 1;
`;
const REVIEW_NUMSTAT = "1\t0\tsrc/a11y/landmarks.ts";

const PROJECT_PATH = "/home/user/projects/xum";

type LayoutPlay = (canvasElement: HTMLElement, layout: "desktop" | "phone") => Promise<HTMLElement>;

interface LandmarkLayout {
  setup: () => ReturnType<typeof createMockORPCClient>;
  /** Opens the layout and returns an element of its primary content. */
  open: LayoutPlay;
}

const LANDMARK_LAYOUTS: Record<
  | "ImmersiveReview"
  | "RootPage"
  | "ProjectPage"
  | "ScratchPage"
  | "NoWorkspaceSelected"
  | "LoadingXum",
  LandmarkLayout
> = {
  ImmersiveReview: {
    setup: () => {
      const client = setupSimpleChatStory({
        workspaceId: REVIEW_WORKSPACE_ID,
        workspaceName: "a11y-review",
        projectName: "xum",
        projectPath: PROJECT_PATH,
        messages: [
          createUserMessage("msg-1", "Review the change", {
            historySequence: 1,
            timestamp: STABLE_TIMESTAMP - 60_000,
          }),
        ],
        gitDiff: { diffOutput: REVIEW_DIFF, numstatOutput: REVIEW_NUMSTAT },
      });
      expandRightSidebar();
      // Immersive mode is persisted per workspace, so start each story with the chat showing.
      updatePersistedState(getReviewImmersiveKey(REVIEW_WORKSPACE_ID), false);
      return client;
    },
    open: async (canvasElement, layout) => {
      const canvas = within(canvasElement);
      await canvas.findByRole("textbox", { name: "Message" }, { timeout: 15_000 });
      window.dispatchEvent(
        createCustomEvent(
          layout === "phone"
            ? CUSTOM_EVENTS.OPEN_TOUCH_REVIEW_IMMERSIVE
            : CUSTOM_EVENTS.OPEN_REVIEW_IMMERSIVE,
          { workspaceId: REVIEW_WORKSPACE_ID }
        )
      );
      return canvas.findByTestId("immersive-review-view", {}, { timeout: 10_000 });
    },
  },
  RootPage: {
    setup: () => createMockORPCClient({}),
    open: (canvasElement) =>
      within(canvasElement).findByText(
        "Select or add a project to get started.",
        {},
        { timeout: 15_000 }
      ),
  },
  ProjectPage: {
    setup: () => {
      expandLeftSidebar();
      expandProjects([PROJECT_PATH]);
      return createMockORPCClient({
        projects: new Map<string, ProjectConfig>([[PROJECT_PATH, { workspaces: [] }]]),
        workspaces: [],
      });
    },
    open: async (canvasElement) => {
      const body = within(canvasElement.ownerDocument.body);
      await userEvent.click(
        await body.findByRole("button", { name: "Create workspace in xum" }, { timeout: 15_000 })
      );
      return body.findByRole("textbox", { name: "Message" });
    },
  },
  ScratchPage: {
    setup: () => {
      expandLeftSidebar();
      return createMockORPCClient({});
    },
    open: async (canvasElement) => {
      const body = within(canvasElement.ownerDocument.body);
      await userEvent.click(
        await body.findByRole("button", { name: "New scratch chat" }, { timeout: 15_000 })
      );
      return body.findByRole("textbox", { name: "Message" });
    },
  },
  // A workspace without a name shows the shell's "No Workspace Selected" placeholder.
  NoWorkspaceSelected: {
    setup: () =>
      setupSimpleChatStory({
        workspaceId: "ws-a11y-unnamed",
        workspaceName: "",
        projectName: "xum",
        projectPath: PROJECT_PATH,
        messages: [
          createUserMessage("msg-1", "Hello", {
            historySequence: 1,
            timestamp: STABLE_TIMESTAMP - 60_000,
          }),
        ],
      }),
    open: (canvasElement) =>
      within(canvasElement).findByText("No Workspace Selected", {}, { timeout: 15_000 }),
  },
  // A metadata stream that never opens keeps AppLoader on its "Loading Xum" screen (#6017).
  LoadingXum: {
    setup: () => {
      const client = createMockORPCClient({});
      client.workspace.onMetadata = () => new Promise<never>(() => undefined);
      return client;
    },
    open: async (canvasElement) => {
      const canvas = within(canvasElement);
      await canvas.findByText(/Loading Xum/, {}, { timeout: 15_000 });
      return canvas.getByRole("status");
    },
  },
};

const landmarkStory = (
  name: keyof typeof LANDMARK_LAYOUTS,
  layout: "desktop" | "phone"
): AppStory => ({
  ...(layout === "phone"
    ? {
        globals: { viewport: { value: "mobile2", isRotated: false } },
        decorators: [
          (Story) => (
            <div style={{ width: PHONE_WIDTH_PX, height: 844, overflow: "hidden" }}>
              <Story />
            </div>
          ),
        ],
      }
    : {}),
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={LANDMARK_LAYOUTS[name].setup} />,
  play: async ({ canvasElement }) => {
    const content = await LANDMARK_LAYOUTS[name].open(canvasElement, layout);
    await waitFor(() => expectOneMainHolding(canvasElement, content));
  },
});

export const ImmersiveReviewLandmark = landmarkStory("ImmersiveReview", "desktop");
export const ImmersiveReviewLandmarkPhone = landmarkStory("ImmersiveReview", "phone");
export const RootPageLandmark = landmarkStory("RootPage", "desktop");
export const RootPageLandmarkPhone = landmarkStory("RootPage", "phone");
export const ProjectPageLandmark = landmarkStory("ProjectPage", "desktop");
export const ProjectPageLandmarkPhone = landmarkStory("ProjectPage", "phone");
export const ScratchPageLandmark = landmarkStory("ScratchPage", "desktop");
export const ScratchPageLandmarkPhone = landmarkStory("ScratchPage", "phone");
export const NoWorkspaceSelectedLandmark = landmarkStory("NoWorkspaceSelected", "desktop");
export const NoWorkspaceSelectedLandmarkPhone = landmarkStory("NoWorkspaceSelected", "phone");
export const LoadingXumLandmark = landmarkStory("LoadingXum", "desktop");
export const LoadingXumLandmarkPhone = landmarkStory("LoadingXum", "phone");
