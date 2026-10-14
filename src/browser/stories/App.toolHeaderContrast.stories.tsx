/**
 * The file-edit tool header's line counts ("+N" and "-N") reach WCAG AA (4.5:1) on the chat
 * background in all four themes (#6010). Lighthouse measured them on a seeded chat page, so these
 * stories render the real chat transcript instead of a lone tool card.
 */

import { expect, waitFor, within } from "@storybook/test";

import type { ThemeMode } from "@/browser/contexts/ThemeContext";
import { textContrast } from "@/browser/stories/helpers/contrast";

import { setupSimpleChatStory } from "./helpers/chatSetup";
import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { createFileEditTool } from "./mocks/tools";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";

export default {
  ...appMeta,
  title: "App/ToolHeaderContrast",
};

const EDIT_DIFF = [
  "--- src/server.ts",
  "+++ src/server.ts",
  "@@ -1,3 +1,4 @@",
  " export function start(port: number) {",
  "-  return listen(port);",
  "+  const server = listen(port);",
  "+  return server;",
  " }",
].join("\n");

function setupToolHeaderChat() {
  return setupSimpleChatStory({
    workspaceId: "ws-tool-header",
    workspaceName: "feature/tool-header",
    projectName: "my-app",
    messages: [
      createUserMessage("u1", "Keep the server handle.", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 60_000,
      }),
      createAssistantMessage("a1", "Kept the server handle.", {
        historySequence: 2,
        timestamp: STABLE_TIMESTAMP,
        toolCalls: [createFileEditTool("call-edit", "src/server.ts", EDIT_DIFF)],
      }),
    ],
  });
}

/** Both line counts are on screen, and each one reaches 4.5:1 on its composited background. */
async function expectLineCountsReadable(canvasElement: HTMLElement) {
  await within(canvasElement).findByText("Kept the server handle.", {}, { timeout: 15_000 });
  const counts = await waitFor(
    () => {
      const found = ["+2", "-1"].map((label) =>
        within(canvasElement).getByText(label, { selector: "span" })
      );
      for (const count of found) {
        if (count.getBoundingClientRect().width === 0)
          throw new Error("line count not visible yet");
      }
      return found;
    },
    { timeout: 15_000 }
  );
  const failing = counts
    .map((count) => ({ text: count.textContent, ratio: textContrast(count) }))
    .filter((entry) => entry.ratio < 4.5)
    .map((entry) => `"${entry.text}" ${entry.ratio.toFixed(2)}:1`);
  await expect(failing.join("\n")).toBe("");
}

const toolHeaderStory = (theme: ThemeMode): AppStory => ({
  globals: { theme },
  // Behavioral contract only: Pixel's own stories show the colors.
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={setupToolHeaderChat} />,
  play: async ({ canvasElement }) => {
    await expectLineCountsReadable(canvasElement);
  },
});

export const LineCountsLight = toolHeaderStory("light");
export const LineCountsFlexokiLight = toolHeaderStory("flexoki-light");
export const LineCountsDark = toolHeaderStory("dark");
export const LineCountsFlexokiDark = toolHeaderStory("flexoki-dark");
