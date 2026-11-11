import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";
import { setupSimpleChatStory } from "@/browser/stories/helpers/chatSetup";
import { createWorkspace } from "@/browser/stories/mocks/workspaces";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import {
  createBashTool,
  createFileReadTool,
  createGenericTool,
  createProposePlanTool,
  createWebSearchTool,
} from "@/browser/stories/mocks/tools";
import type { ChatMuxMessage } from "@/common/orpc/types";
import { installDom } from "../dom";
import { cleanupView, setupWorkspaceView } from "../helpers";
import { renderApp, type RenderedApp } from "../renderReviewPanel";

function queryButtons(container: HTMLElement, testId: string): HTMLButtonElement[] {
  const HTMLButton = container.ownerDocument.defaultView?.HTMLButtonElement;
  if (!HTMLButton) {
    throw new Error("Expected test DOM to provide HTMLButtonElement");
  }
  return Array.from(container.querySelectorAll(`[data-testid="${testId}"]`)).flatMap((element) => {
    if (element instanceof HTMLButton) {
      return [element];
    }
    const button = element.querySelector("button");
    return button ? [button] : [];
  });
}

async function findButton(container: HTMLElement, testId: string): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const button = queryButtons(container, testId)[0];
    if (!button) {
      throw new Error(`${testId} button not found`);
    }
    return button;
  });
}

function expectTextOrder(container: HTMLElement, ...orderedText: string[]): void {
  const text = container.textContent ?? "";
  let previousIndex = -1;
  for (const expected of orderedText) {
    const index = text.indexOf(expected);
    if (index === -1) {
      throw new Error(`Expected transcript text to contain "${expected}"`);
    }
    expect(index).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

/** The full app on a stored transcript at compact density (stored as "hyper"). */
async function withCompactTranscript(
  workspaceId: string,
  messages: ChatMuxMessage[],
  run: (view: RenderedApp) => Promise<void>
): Promise<void> {
  const cleanupDom = installDom();
  const metadata = createWorkspace({
    id: workspaceId,
    name: "feature",
    projectName: "my-app",
    projectPath: "/home/user/projects/my-app",
  });
  const client = setupSimpleChatStory({
    userPreferences: { appearance: { transcriptDensity: "hyper" } },
    workspaceId: metadata.id,
    workspaceName: metadata.name,
    projectName: metadata.projectName,
    projectPath: metadata.projectPath,
    messages,
  });
  const view = renderApp({ apiClient: client, metadata });
  try {
    await setupWorkspaceView(view, metadata, metadata.id);
    await run(view);
  } finally {
    await cleanupView(view, cleanupDom);
  }
}

describe("Compact transcript density", () => {
  test("a finished turn is its prompt, one work line and the reply, with the steps one click away", async () => {
    await withCompactTranscript(
      "ws-density",
      [
        createUserMessage("density-user-1", "Audit the auth module", {
          historySequence: 1,
          timestamp: 0,
        }),
        createAssistantMessage("density-assistant-1", "I'll gather context first.", {
          historySequence: 2,
          timestamp: 1_000,
          toolCalls: [
            createFileReadTool("density-read-1", "src/auth.ts", "export function verify() {}"),
            createWebSearchTool("density-search-1", "JWT validation best practices", 3),
            createBashTool(
              "density-fail-1",
              "make typecheck",
              "Type error in src/auth.ts",
              1,
              30,
              500,
              "Failing validation"
            ),
            { type: "text", text: "Implemented the auth audit fix." },
          ],
        }),
      ],
      async (view) => {
        const workLine = await findButton(view.container, "work-bundle");
        expect(workLine.getAttribute("aria-expanded")).toBe("false");
        expectTextOrder(
          view.container,
          "Audit the auth module",
          "Worked",
          "Implemented the auth audit fix."
        );
        expect(view.container.textContent).not.toContain("I'll gather context first.");
        expect(view.container.textContent).not.toContain("make typecheck");
        expect(queryButtons(view.container, "operational-bundle")).toHaveLength(0);

        fireEvent.click(workLine);

        // Opened, the turn reads as detailed density does: narration, then the folded run.
        const run = await findButton(view.container, "operational-bundle");
        expect(run.getAttribute("aria-expanded")).toBe("false");
        expect(run.textContent).toContain("Read 1 file");
        expectTextOrder(
          view.container,
          "I'll gather context first.",
          "Read 1 file",
          "Implemented the auth audit fix."
        );
        expect(view.container.textContent).not.toContain("make typecheck");

        fireEvent.click(run);
        await waitFor(() => {
          expect(view.container.textContent).toContain("make typecheck");
        });
      }
    );
  }, 30_000);

  test("a question and a plan stay in the conversation; the work around them folds", async () => {
    const questions = [
      {
        question: "Reject expired sessions or delete them?",
        header: "Expiry",
        options: [
          { label: "Reject only", description: "Keep the row." },
          { label: "Delete", description: "Remove the row." },
        ],
        multiSelect: false,
      },
    ];
    await withCompactTranscript(
      "ws-stops",
      [
        createUserMessage("stops-user-1", "Plan the cleanup job", {
          historySequence: 1,
          timestamp: 0,
        }),
        createAssistantMessage("stops-assistant-1", "", {
          historySequence: 2,
          timestamp: 1_000,
          toolCalls: [
            createFileReadTool("stops-read-1", "src/auth.ts", "export function verify() {}"),
            createGenericTool(
              "stops-question-1",
              "ask_user_question",
              { questions },
              { questions, answers: { [questions[0].question]: "Reject only" } }
            ),
            createFileReadTool("stops-read-2", "src/jobs.ts", "export const jobs = [];"),
            { type: "text", text: "Here is the plan." },
            createProposePlanTool(
              "stops-plan-1",
              "# Cleanup Plan\n\n- Reveal the plan without a click."
            ),
          ],
        }),
      ],
      async (view) => {
        await waitFor(() => {
          expect(view.container.textContent).toContain("Reveal the plan without a click.");
        });
        // One work line before the question and one after it, both closed.
        const workLines = queryButtons(view.container, "work-bundle");
        expect(workLines.map((line) => line.getAttribute("aria-expanded"))).toEqual([
          "false",
          "false",
        ]);
        expectTextOrder(
          view.container,
          "Reject expired sessions or delete them?",
          "Reject only",
          "Here is the plan.",
          "Cleanup Plan"
        );
        expect(view.container.textContent).not.toContain("src/auth.ts");
        expect(view.container.textContent).not.toContain("src/jobs.ts");
      }
    );
  }, 30_000);

  test("an earlier plan folds to its title once a newer plan exists", async () => {
    await withCompactTranscript(
      "ws-plans",
      [
        createUserMessage("plans-user-1", "Plan it", { historySequence: 1, timestamp: 0 }),
        createAssistantMessage("plans-assistant-1", "", {
          historySequence: 2,
          timestamp: 1_000,
          toolCalls: [createProposePlanTool("plans-plan-1", "# First Plan\n\n- Older body line.")],
        }),
        createUserMessage("plans-user-2", "Revise it", { historySequence: 3, timestamp: 2_000 }),
        createAssistantMessage("plans-assistant-2", "", {
          historySequence: 4,
          timestamp: 3_000,
          toolCalls: [createProposePlanTool("plans-plan-2", "# Second Plan\n\n- Newer body line.")],
        }),
      ],
      async (view) => {
        await waitFor(() => {
          expect(view.container.textContent).toContain("Newer body line.");
        });
        expect(view.container.textContent).toContain("First Plan");
        expect(view.container.textContent).not.toContain("Older body line.");
      }
    );
  }, 30_000);
});
