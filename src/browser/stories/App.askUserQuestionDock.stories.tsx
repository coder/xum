/**
 * An open ask_user_question docked above the chat input (sticky to the bottom of the chat).
 *
 * A non-blocking question stays answerable while the agent keeps working, so later output used to
 * push the form out of view. Each play asserts the form renders once, inside the composer dock,
 * that the transcript row is a stub, and that the dock does not overflow horizontally.
 *
 * Play-only: the Pixel snapshot budget is full, and the plays (not a snapshot) carry the behavior.
 */

import type { ComponentType } from "react";
import { waitFor } from "storybook/test";

import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { createGenericTool } from "./mocks/tools";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";
import { blurActiveElement, waitForScrollStabilization } from "./storyPlayHelpers.js";

export default {
  ...appMeta,
  title: "App/AskUserQuestionDock",
};

const QUESTIONS = [
  {
    question: "Which storage backend should the cache use?",
    header: "Storage",
    options: [
      { label: "SQLite", description: "One file next to the config; survives restarts." },
      { label: "In memory", description: "Fastest, but cold after every restart." },
    ],
    multiSelect: false,
  },
  {
    question: "Which platforms need the migration?",
    header: "Platforms",
    options: [
      { label: "macOS", description: "Desktop app on Apple silicon and Intel." },
      { label: "Linux", description: "AppImage and server installs." },
      { label: "Windows", description: "Installer and portable builds." },
    ],
    multiSelect: true,
  },
];

// The agent kept working after asking: enough output to push the question's row off screen.
const FOLLOW_UP_TEXT = Array.from(
  { length: 12 },
  (_, index) =>
    `Step ${index + 1}: while the questions are open I am reading the cache module, its callers ` +
    "and the tests that cover eviction, so the change is ready to go once you answer."
).join("\n\n");

function setupDockStory(workspaceId: string) {
  return setupSimpleChatStory({
    workspaceId,
    workspaceName: "cache-backend",
    projectName: "xum",
    messages: [
      createUserMessage("msg-1", "Add a persistent cache for the model list.", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 120_000,
      }),
      createAssistantMessage("msg-2", "A couple of choices first; I'll keep exploring meanwhile.", {
        historySequence: 2,
        timestamp: STABLE_TIMESTAMP - 110_000,
        toolCalls: [
          createGenericTool(
            "call-ask-dock",
            "ask_user_question",
            { questions: QUESTIONS },
            {
              summary: "Questions shown to the user.",
              ui_only: {
                ask_user_question: { questions: QUESTIONS, answers: {}, answerDelivery: "message" },
              },
            }
          ),
        ],
      }),
      createAssistantMessage("msg-3", FOLLOW_UP_TEXT, {
        historySequence: 3,
        timestamp: STABLE_TIMESTAMP - 100_000,
      }),
    ],
  });
}

async function assertQuestionDocked(canvasElement: HTMLElement) {
  const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
  await waitForScrollStabilization(storyRoot);
  blurActiveElement();
  await waitFor(() => checkQuestionDocked(storyRoot), { timeout: 10_000 });
}

function checkQuestionDocked(storyRoot: HTMLElement) {
  const composerDock = storyRoot.querySelector<HTMLElement>('[data-testid="chat-composer-dock"]');
  const questionDock = composerDock?.querySelector<HTMLElement>(
    '[data-component="AskUserQuestionDock"]'
  );
  if (!questionDock) {
    throw new Error("Open question is not docked above the chat input");
  }
  if (!questionDock.textContent?.includes(QUESTIONS[0].question)) {
    throw new Error("Docked question does not show the first question");
  }
  // The form renders once: the transcript row is a stub, so it has no answer controls.
  const nextButtons = Array.from(storyRoot.querySelectorAll("button")).filter(
    (button) => button.textContent?.trim() === "Next"
  );
  if (nextButtons.length !== 1 || !questionDock.contains(nextButtons[0])) {
    throw new Error(`Expected one Next button, inside the dock; found ${nextButtons.length}`);
  }
  if (questionDock.scrollWidth > questionDock.clientWidth) {
    throw new Error("Docked question overflows horizontally");
  }
}

function PhoneWidthDecorator(Story: ComponentType) {
  // The Storybook test-runner ignores Pixel viewports, so the phone width comes from this frame.
  return (
    <div style={{ width: 390, height: 844, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

export const Desktop: AppStory = {
  render: () => <AppWithMocks setup={() => setupDockStory("ws-ask-dock-desktop")} />,
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    await assertQuestionDocked(canvasElement);
  },
};

export const Phone: AppStory = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  render: () => <AppWithMocks setup={() => setupDockStory("ws-ask-dock-phone")} />,
  decorators: [PhoneWidthDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    await assertQuestionDocked(canvasElement);
  },
};
