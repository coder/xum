/**
 * An open ask_user_question docked above the chat input (sticky to the bottom of the chat).
 *
 * A non-blocking question stays answerable while the agent keeps working, so later output used to
 * push the form out of view. Each play asserts the form renders once, inside the composer dock,
 * that the transcript row is a stub, and that the dock does not overflow horizontally.
 *
 * Several open question sets chain into one form (one tab strip, one Summary, one Submit), with a
 * divider between calls' tabs. Submit closes the form as soon as the send is accepted, even when
 * no answer row lands yet (a message queued behind a running stream; the mock never appends one).
 *
 * Play-only: the Pixel snapshot budget is full, and the plays (not a snapshot) carry the behavior.
 */

import type { ComponentType } from "react";
import { userEvent, waitFor, within } from "storybook/test";

import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { createAsyncAskUserQuestionTool } from "./mocks/tools";
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
        toolCalls: [createAsyncAskUserQuestionTool("call-ask-dock", QUESTIONS)],
      }),
      createAssistantMessage("msg-3", FOLLOW_UP_TEXT, {
        historySequence: 3,
        timestamp: STABLE_TIMESTAMP - 100_000,
      }),
    ],
  });
}

const FOLLOW_UP_QUESTIONS = [
  {
    question: "How long should cached entries live?",
    header: "Expiry",
    options: [
      { label: "One day", description: "Refetch the model list daily." },
      { label: "Until restart", description: "Never expire while the app runs." },
    ],
    multiSelect: false,
  },
];

// The agent asked again before the user answered: two open calls.
function setupChainedDockStory(workspaceId: string) {
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
        toolCalls: [createAsyncAskUserQuestionTool("call-ask-dock", QUESTIONS)],
      }),
      createAssistantMessage("msg-3", FOLLOW_UP_TEXT, {
        historySequence: 3,
        timestamp: STABLE_TIMESTAMP - 100_000,
        toolCalls: [createAsyncAskUserQuestionTool("call-ask-dock-2", FOLLOW_UP_QUESTIONS)],
      }),
    ],
  });
}

function checkChainedQuestionsDocked(storyRoot: HTMLElement) {
  // One form (a single Next, inside the dock) and a horizontal-overflow check.
  checkQuestionDocked(storyRoot);
  const questionDock = storyRoot.querySelector<HTMLElement>(
    '[data-testid="chat-composer-dock"] [data-component="AskUserQuestionDock"]'
  );
  const tabs = Array.from(questionDock?.querySelectorAll("button") ?? []).map((button) =>
    button.textContent?.trim()
  );
  for (const header of [...QUESTIONS, ...FOLLOW_UP_QUESTIONS].map((q) => q.header)) {
    if (!tabs.includes(header)) {
      throw new Error(`The chained form has no "${header}" tab`);
    }
  }
  if (questionDock?.querySelectorAll("[data-question-group-divider]").length !== 1) {
    throw new Error("Expected one divider between the two calls' tabs");
  }
  const stubs = Array.from(storyRoot.querySelectorAll("div")).filter(
    (element) => element.textContent?.trim() === "Answer in the panel above the chat input."
  );
  if (stubs.length !== 2) {
    throw new Error(`Expected a transcript stub per call; found ${stubs.length}`);
  }
}

async function assertQuestionDocked(
  canvasElement: HTMLElement,
  check: (storyRoot: HTMLElement) => void = checkQuestionDocked
) {
  const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
  await waitForScrollStabilization(storyRoot);
  blurActiveElement();
  await waitFor(() => check(storyRoot), { timeout: 10_000 });
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

export const ChainedDesktop: AppStory = {
  render: () => <AppWithMocks setup={() => setupChainedDockStory("ws-ask-dock-chained-desktop")} />,
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    await assertQuestionDocked(canvasElement, checkChainedQuestionsDocked);
  },
};

export const ChainedPhone: AppStory = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  render: () => <AppWithMocks setup={() => setupChainedDockStory("ws-ask-dock-chained-phone")} />,
  decorators: [PhoneWidthDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    await assertQuestionDocked(canvasElement, checkChainedQuestionsDocked);
  },
};

export const ChainedSubmit: AppStory = {
  render: () => <AppWithMocks setup={() => setupChainedDockStory("ws-ask-dock-chained-submit")} />,
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    await assertQuestionDocked(canvasElement, checkChainedQuestionsDocked);
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const questionDock = within(
      storyRoot.querySelector<HTMLElement>('[data-component="AskUserQuestionDock"]') ?? storyRoot
    );
    await userEvent.click(questionDock.getByRole("button", { name: "Summary" }));
    await userEvent.click(questionDock.getByRole("button", { name: "Submit answers" }));
    // A form left open here could send the same answers again.
    await waitFor(
      () => {
        if (storyRoot.querySelector('[data-component="AskUserQuestionDock"]')) {
          throw new Error("The chained form stayed open after its answers were accepted");
        }
      },
      { timeout: 10_000 }
    );
  },
};
