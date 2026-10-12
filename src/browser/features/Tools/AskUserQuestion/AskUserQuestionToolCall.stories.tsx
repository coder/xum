import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/helpers/chatSetup";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import { createGenericTool, createPendingTool } from "@/browser/stories/mocks/tools";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";
import { within, userEvent } from "@storybook/test";

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
 * Non-blocking (Exec) question: the tool already returned and the agent kept working, but the
 * questions stay answerable; answers are delivered later as a steering message.
 */
export const AskUserQuestionNonBlocking: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const questions = [
          {
            question: "Which approach should we take?",
            header: "Approach",
            options: [
              { label: "A", description: "Approach A" },
              { label: "B", description: "Approach B" },
            ],
            multiSelect: false,
          },
        ];
        return setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Please implement the feature", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("msg-2", "Assuming approach A while you decide.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 55000,
              toolCalls: [
                createGenericTool(
                  "call-ask-async",
                  "ask_user_question",
                  { questions },
                  {
                    summary: "Questions shown to the user.",
                    ui_only: {
                      ask_user_question: { questions, answers: {}, answerDelivery: "message" },
                    },
                  }
                ),
              ],
            }),
          ],
        });
      }}
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
