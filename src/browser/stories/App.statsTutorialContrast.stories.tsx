/**
 * The rest of #6010: the empty Stats tab texts, the flat sidebar's "New chat" button and the
 * tutorial bubble (its muted texts and the Next/Done button) reach WCAG AA (4.5:1) in all four
 * themes. Lighthouse measured these on a seeded chat page, so the stories render the real app:
 * a flat sidebar, an empty Stats tab and the first tutorial step.
 *
 * Hover is not covered here (a play cannot trigger `:hover`): "New chat" switches to the
 * foreground color on hover, measured in the PR that added these stories.
 */

import { expect, userEvent, waitFor, within } from "@storybook/test";

import type { ThemeMode } from "@/browser/contexts/ThemeContext";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { textContrast } from "@/browser/stories/helpers/contrast";
import {
  getRightSidebarLayoutKey,
  RIGHT_SIDEBAR_TAB_KEY,
  STATS_CONTAINER_SUB_TAB_KEY,
} from "@/common/constants/storage";

import { setupSimpleChatStory } from "./helpers/chatSetup";
import { expandLeftSidebar, expandRightSidebar } from "./helpers/uiState";
import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";

export default {
  ...appMeta,
  title: "App/StatsTutorialContrast",
};

const WORKSPACE_ID = "ws-stats-tutorial";

/** A chat with no usage yet, the flat sidebar, the Stats tab open and tutorials enabled. */
function setupEmptyStatsWithTutorial() {
  const client = setupSimpleChatStory({
    workspaceId: WORKSPACE_ID,
    workspaceName: "feature/contrast",
    projectName: "my-app",
    messages: [
      createUserMessage("u1", "Hello", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 1_000,
      }),
      createAssistantMessage("a1", "Hi there.", {
        historySequence: 2,
        timestamp: STABLE_TIMESTAMP,
      }),
    ],
    // The mock turns tutorials off by default so their overlay cannot cover other stories.
    userPreferences: { ui: { sidebarFlatMode: true, tutorialState: { disabled: false } } },
  });
  expandLeftSidebar();
  expandRightSidebar();
  updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, "costs");
  // The per-workspace layout remembers the last tab across stories; drop it so "costs" applies.
  updatePersistedState(getRightSidebarLayoutKey(WORKSPACE_ID), null);
  // The play switches to Timing, and that choice persists: start every story on the Cost view.
  updatePersistedState(STATS_CONTAINER_SUB_TAB_KEY, "cost");
  return client;
}

interface Measured {
  label: string;
  text: string;
  ratio: number;
}

const measure = (label: string, element: HTMLElement): Measured => ({
  label,
  text: (element.textContent ?? "").trim().slice(0, 40),
  ratio: textContrast(element),
});

/** Every entry reaches 4.5:1. A joined string, so a failure names every text, not a count. */
async function expectReadable(entries: Measured[]) {
  const failing = entries
    .filter((entry) => entry.ratio < 4.5)
    .map((entry) => `${entry.label} ${entry.ratio.toFixed(2)}:1 "${entry.text}"`);
  await expect(failing.join("\n")).toBe("");
}

/** The tutorial bubble: the dialog-like box that holds the step counter and the Skip button. */
function findTutorial(root: HTMLElement): HTMLElement {
  const skip = within(root).getByRole("button", { name: "Skip" });
  const bubble = skip.closest<HTMLElement>(".z-\\[9999\\]");
  if (!bubble) throw new Error("tutorial bubble not found");
  return bubble;
}

async function expectStatsTutorialReadable(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const entries: Measured[] = [];

  // Empty Cost view (the default Stats view).
  for (const text of ["No messages yet.", "Send a message to see cost statistics."]) {
    entries.push(
      measure("Cost empty text", await canvas.findByText(text, {}, { timeout: 15_000 }))
    );
  }
  // Flat sidebar header button: the label span, not the icon.
  const newChat = await canvas.findByText("New chat", { selector: "span" }, { timeout: 15_000 });
  entries.push(measure("New chat", newChat));

  // Tutorial bubble: every text it shows, and the primary button.
  const bubble = await waitFor(() => findTutorial(document.body), { timeout: 15_000 });
  const step = within(bubble).getByText(/^\d+\/\d+$/);
  const content = bubble.querySelector<HTMLElement>("p");
  if (!content) throw new Error("tutorial content not found");
  entries.push(measure("tutorial step counter", step), measure("tutorial text", content));
  for (const name of [/^Skip$/, /^Don.t show tutorials again$/, /^(Next|Done)$/]) {
    entries.push(measure("tutorial button", within(bubble).getByRole("button", { name })));
  }

  // Empty Timing view.
  await userEvent.click(await canvas.findByRole("button", { name: "Timing" }, { timeout: 15_000 }));
  entries.push(
    measure(
      "Timing empty text",
      await canvas.findByText("No timing data yet.", {}, { timeout: 15_000 })
    )
  );
  await expectReadable(entries);
}

const statsTutorialStory = (theme: ThemeMode): AppStory => ({
  globals: { theme },
  // Behavioral contract only: Pixel's own stories show the colors.
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={setupEmptyStatsWithTutorial} />,
  play: async ({ canvasElement }) => {
    await expectStatsTutorialReadable(canvasElement);
  },
});

export const Light = statsTutorialStory("light");
export const FlexokiLight = statsTutorialStory("flexoki-light");
export const Dark = statsTutorialStory("dark");
export const FlexokiDark = statsTutorialStory("flexoki-dark");
