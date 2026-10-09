/**
 * Light theme: muted (`--color-muted`) and secondary (`--color-secondary`) text meets WCAG AA
 * (4.5:1) on the main screens: home, a workspace with both sidebars open, and Settings. The
 * stories check every visible text in those colors, so a later change to either token, or to a
 * background behind them, fails here (#5950, #5951).
 */

import { expect, waitFor, within } from "@storybook/test";

import { RIGHT_SIDEBAR_TAB_KEY } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { tokenTextContrasts } from "@/browser/stories/helpers/contrast";
import { setupSettingsStory } from "@/browser/features/Settings/Sections/settingsStoryUtils";

import { setupSimpleChatStory } from "./helpers/chatSetup";
import { expandLeftSidebar, expandRightSidebar } from "./helpers/uiState";
import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { createMockORPCClient } from "./mocks/orpc";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";
import { openSettingsDialog } from "./storyPlayHelpers";

export default {
  ...appMeta,
  title: "App/LightThemeTokenContrast",
};

const TOKENS = ["--color-muted", "--color-secondary"];

/**
 * Every muted and secondary text under `root` reaches 4.5:1, and at least `minimum` texts of
 * each listed token were found, so an empty screen cannot pass.
 */
async function expectTokenTextsReadable(root: HTMLElement, minimum: Record<string, number>) {
  await waitFor(
    () => {
      const found = tokenTextContrasts(root, TOKENS);
      for (const [token, count] of Object.entries(minimum)) {
        const ofToken = found.filter((entry) => entry.token === token);
        if (ofToken.length < count) {
          throw new Error(`expected ${count}+ texts in ${token}, found ${ofToken.length}`);
        }
      }
    },
    { timeout: 15_000 }
  );
  const failing = tokenTextContrasts(root, TOKENS)
    // Known follow-up outside the token change: the selected right-sidebar tab's count sits on
    // the tab's darker pill (#5951 lists it with the other non-token items).
    .filter((entry) => !entry.element.closest('[role="tab"][aria-selected="true"]'))
    .filter((entry) => entry.ratio < 4.5)
    .map((entry) => `${entry.token} ${entry.ratio.toFixed(2)}:1 "${entry.text}"`);
  // A joined string, so a failure names every text instead of a truncated array.
  await expect(failing.join("\n")).toBe("");
}

// Behavioral contract only, so Pixel snapshots are off: Pixel's own stories show the colors.
const lightContract = { ...appMeta.parameters, pixel: PIXEL_DISABLED };

export const Home: AppStory = {
  globals: { theme: "light" },
  parameters: lightContract,
  render: () => <AppWithMocks setup={() => createMockORPCClient()} />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("No projects", {}, { timeout: 15_000 });
    await expectTokenTextsReadable(canvasElement, { "--color-muted": 1 });
  },
};

const REVIEW_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 export function start() {
+  console.log("ready");
   return true;
 }
`;

export const WorkspaceWithSidebars: AppStory = {
  globals: { theme: "light" },
  parameters: lightContract,
  render: () => (
    <AppWithMocks
      setup={() => {
        const client = setupSimpleChatStory({
          workspaceId: "ws-light-tokens",
          workspaceName: "feature/light-tokens",
          projectName: "my-app",
          messages: [
            createUserMessage("u1", "Add a ready log to start().", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60_000,
            }),
            createAssistantMessage("a1", "Added the log line in src/app.ts.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP,
            }),
          ],
          gitDiff: { diffOutput: REVIEW_DIFF, numstatOutput: "1\t0\tsrc/app.ts" },
        });
        // setupSimpleChatStory collapses the right sidebar; open both for this screen.
        expandLeftSidebar();
        expandRightSidebar();
        updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, "review");
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(
      "Added the log line in src/app.ts.",
      {},
      { timeout: 15_000 }
    );
    await expectTokenTextsReadable(canvasElement, { "--color-muted": 3, "--color-secondary": 1 });
  },
};

export const Settings: AppStory = {
  globals: { theme: "light" },
  parameters: lightContract,
  render: () => <AppWithMocks setup={() => setupSettingsStory({})} />,
  play: async ({ canvasElement }) => {
    const dialog = await openSettingsDialog(canvasElement);
    await expectTokenTextsReadable(dialog, { "--color-muted": 3 });
  },
};
