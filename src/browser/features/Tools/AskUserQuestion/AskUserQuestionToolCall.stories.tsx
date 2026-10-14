import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks, PIXEL_DISABLED } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/helpers/chatSetup";
import { applyTouchPointerRules } from "@/browser/stories/helpers/touchPointer";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import { createGenericTool, createPendingTool } from "@/browser/stories/mocks/tools";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";
import { MOBILE_TOUCH_TARGET_PX } from "@/constants/layout";
import { within, userEvent, waitFor } from "@storybook/test";
import type { ComponentType } from "react";

const meta = { ...appMeta, title: "App/Chat/Tools/AskUserQuestion" };
export default meta;

/** Streaming/working state with ask_user_question pending */
export const AskUserQuestionPending: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Please implement the feature", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 3000,
            }),
            createAssistantMessage("msg-2", "I have a few clarifying questions.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 2000,
              toolCalls: [
                createPendingTool("call-ask-1", "ask_user_question", {
                  questions: [
                    {
                      question: "Which approach should we take?",
                      header: "Approach",
                      options: [
                        { label: "A", description: "Approach A" },
                        { label: "B", description: "Approach B" },
                      ],
                      multiSelect: false,
                    },
                    {
                      question: "Which platforms do we need to support?",
                      header: "Platforms",
                      options: [
                        { label: "macOS", description: "Apple macOS" },
                        { label: "Windows", description: "Microsoft Windows" },
                        { label: "Linux", description: "Linux desktops" },
                      ],
                      multiSelect: true,
                    },
                  ],
                }),
              ],
            }),
          ],
          gitStatus: { dirty: 1 },
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    // Wait for the tool card to appear (header is rendered even when collapsed).
    const toolTitle = await canvas.findByText(/ask_user_question/, {}, { timeout: 8000 });

    // Ensure tool is expanded (question text is inside ToolDetails).
    if (!canvas.queryByText("Summary")) {
      await userEvent.click(toolTitle);
    }

    // Use findAllByRole (retry-capable) instead of getAllByRole to handle
    // transient DOM gaps when the Storybook iframe remounts between awaits.
    const getSectionButton = async (prefix: string): Promise<HTMLElement> => {
      const buttons = await canvas.findAllByRole("button");
      const btn = buttons.find(
        (el) => el.tagName === "BUTTON" && (el.textContent ?? "").startsWith(prefix)
      );
      if (!btn) throw new Error(`${prefix} section button not found`);
      return btn;
    };

    // Ensure we're on the first question.
    await userEvent.click(await getSectionButton("Approach"));

    // Wait for the first question to render.
    try {
      await canvas.findByText("Which approach should we take?", {}, { timeout: 8000 });
    } catch {
      const toolContainerText =
        toolTitle.closest("div")?.parentElement?.textContent?.slice(0, 500) ?? "<missing>";
      throw new Error(
        `AskUserQuestionPending: question UI not found. Tool container: ${toolContainerText}`
      );
    }

    // Selecting a single-select option should auto-advance.
    await userEvent.click(await canvas.findByText("Approach A"));
    await canvas.findByText("Which platforms do we need to support?");

    // Regression: you must be able to jump back to a previous section after answering it.
    await userEvent.click(await getSectionButton("Approach"));

    await canvas.findByText("Which approach should we take?");

    // Give React a tick to run any pending effects; we should still be on question 1.
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (canvas.queryByText("Which platforms do we need to support?")) {
      throw new Error("Unexpected auto-advance when navigating back to a previous question");
    }

    // Changing the answer should still auto-advance.
    await userEvent.click(canvas.getByText("Approach B"));
    await canvas.findByText("Which platforms do we need to support?");
  },
};

/** Completed ask_user_question tool call */
export const AskUserQuestionCompleted: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Please implement the feature", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("msg-2", "I asked some questions.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 55000,
              toolCalls: [
                createGenericTool(
                  "call-ask-1",
                  "ask_user_question",
                  {
                    questions: [
                      {
                        question: "Which approach should we take?",
                        header: "Approach",
                        options: [
                          { label: "A", description: "Approach A" },
                          { label: "B", description: "Approach B" },
                        ],
                        multiSelect: false,
                      },
                    ],
                  },
                  {
                    questions: [
                      {
                        question: "Which approach should we take?",
                        header: "Approach",
                        options: [
                          { label: "A", description: "Approach A" },
                          { label: "B", description: "Approach B" },
                        ],
                        multiSelect: false,
                      },
                    ],
                    answers: {
                      "Which approach should we take?": "A",
                    },
                  }
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/**
 * Test "Other" option with auto-resizing textarea.
 * Shows the textarea expanded with multi-line content to demonstrate auto-resize.
 */
export const AskUserQuestionOther: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "How should I set this up?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 3000,
            }),
            createAssistantMessage("msg-2", "Let me ask a few questions.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 2000,
              toolCalls: [
                createPendingTool("call-ask-1", "ask_user_question", {
                  questions: [
                    {
                      question: "Describe your use case in detail",
                      header: "Use Case",
                      options: [
                        { label: "Web app", description: "A web application" },
                        { label: "CLI tool", description: "A command-line tool" },
                      ],
                      multiSelect: false,
                    },
                  ],
                  // Pre-fill with "Other" selected to show the textarea
                  answers: {
                    "Describe your use case in detail":
                      "I'm building a complex application.\nIt needs web, CLI, and API support.\nThe architecture should be modular.",
                  },
                }),
              ],
            }),
          ],
          gitStatus: { dirty: 0 },
        })
      }
    />
  ),
};

function PhoneWidthDecorator(Story: ComponentType) {
  return (
    <div style={{ width: 390, height: 844, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

/**
 * Touch phones give every button and `role=button` a 44px minimum (globals.css). An option row is
 * a `role=button`, so the row is the touch target and its checkbox must keep its drawn size on
 * the line of the option's label (#5835, #6320).
 *
 * The seeded bug-bash app cannot show this card: the mock AI has no ask_user_question reply. The
 * Storybook test-runner plays at desktop size and matches no coarse pointer, so the play forces a
 * phone width with the decorator and copies the coarse-pointer rules itself.
 */
export const AskUserQuestionTouchPhone: AppStory = {
  render: AskUserQuestionPending.render,
  decorators: [PhoneWidthDecorator],
  // The play removes the copied rules again, so a snapshot would only repeat the narrow layout.
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);
    const toolTitle = await canvas.findByText(/ask_user_question/, {}, { timeout: 8000 });
    if (!canvas.queryByText("Summary")) {
      await userEvent.click(toolTitle);
    }
    // The card keeps its draft across stories (AskUserQuestionPending answers the first question),
    // so open the first question explicitly.
    const sections = await canvas.findAllByRole("button");
    const approach = sections.find(
      (el) => el.tagName === "BUTTON" && (el.textContent ?? "").startsWith("Approach")
    );
    if (!approach) throw new Error("Approach section button not found");
    await userEvent.click(approach);
    await canvas.findByText("Which approach should we take?", {}, { timeout: 8000 });

    const removeTouchRules = applyTouchPointerRules(canvasElement.ownerDocument);
    try {
      await waitFor(() => {
        const checkbox = storyRoot.querySelector('[role="button"] > button[role="checkbox"]');
        // The checkbox draws its box on this span: the Radix button is an invisible hit area.
        const box = checkbox?.querySelector(':scope > [aria-hidden="true"]');
        const row = checkbox?.parentElement;
        const label = checkbox?.nextElementSibling?.firstElementChild;
        if (!checkbox || !box || !row || !label) {
          throw new Error("Option row, checkbox box or option label not found");
        }
        const b = box.getBoundingClientRect();
        const l = label.getBoundingClientRect();
        const rowHeight = row.getBoundingClientRect().height;
        if (rowHeight < MOBILE_TOUCH_TARGET_PX) {
          throw new Error(`Option row is ${rowHeight}px tall, under the touch minimum`);
        }
        const drawnBox = Math.max(b.width, b.height);
        if (drawnBox > 20) {
          throw new Error(`Checkbox draws a ${drawnBox}px box in an option row`);
        }
        const centerGap = Math.abs(b.top + b.height / 2 - (l.top + l.height / 2));
        if (centerGap > 2) {
          throw new Error(`Checkbox sits ${centerGap}px off its option label's line`);
        }
      });
    } finally {
      removeTouchRules();
    }
  },
};
