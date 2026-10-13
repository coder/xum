/**
 * Pinned TODO panel with a list as long as MAX_TODOS allows (a 9-step playbook plus task items).
 *
 * The panel has a fixed max height, and completed items come first, so a long list used to open
 * with the current item below the fold. Each play asserts that the in-progress row is inside the
 * panel's visible area and that the panel does not overflow horizontally.
 */

import type { ComponentType } from "react";
import { waitFor } from "@storybook/test";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getPinnedTodoExpandedKey } from "@/common/constants/storage";
import type { TodoItem } from "@/common/types/tools";

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { createTodoWriteTool } from "./mocks/tools";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";
import { blurActiveElement, waitForScrollStabilization } from "./storyPlayHelpers.js";

export default {
  ...appMeta,
  title: "App/PinnedTodoList",
};

const LONG_TODOS: TodoItem[] = [
  { content: "Read the task and the linked issue", status: "completed" },
  { content: "Explored the todo tool and its UI", status: "completed" },
  { content: "Wrote the plan", status: "completed" },
  { content: "Raised the todo cap", status: "completed" },
  { content: "Rewrote the limit tests", status: "completed" },
  { content: "Kept the pinned panel on the current item", status: "completed" },
  { content: "Added the long-list stories", status: "completed" },
  { content: "Ran make static-check", status: "completed" },
  { content: "Ran the targeted unit tests", status: "completed" },
  { content: "Audited the new tests", status: "completed" },
  { content: "Pushed the branch for dogfooding", status: "completed" },
  { content: "Ran remote dogfood UAT", status: "completed" },
  { content: "Opening the pull request", status: "in_progress" },
  { content: "Babysit CI until green", status: "pending" },
  { content: "Run the Codex review loop", status: "pending" },
];

function setupLongTodoStory(workspaceId: string) {
  updatePersistedState(getPinnedTodoExpandedKey(workspaceId), true);
  return setupSimpleChatStory({
    workspaceId,
    workspaceName: "todo-cap",
    projectName: "xum",
    messages: [
      createUserMessage("msg-1", "Ship the todo cap change.", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 120_000,
      }),
      createAssistantMessage("msg-2", "Tracking the playbook and the task in the TODO list.", {
        historySequence: 2,
        timestamp: STABLE_TIMESTAMP - 110_000,
        toolCalls: [createTodoWriteTool("call-todo-long", LONG_TODOS)],
      }),
    ],
  });
}

async function assertCurrentTodoVisible(canvasElement: HTMLElement) {
  const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
  await waitForScrollStabilization(storyRoot);
  blurActiveElement();
  await waitFor(() => checkCurrentTodoVisible(storyRoot), { timeout: 10_000 });
}

function checkCurrentTodoVisible(storyRoot: HTMLElement) {
  const panel = storyRoot.querySelector<HTMLElement>('[data-component="PinnedTodoList"]');
  if (panel === null) {
    throw new Error("Pinned TODO panel not found");
  }
  const rows = panel.querySelectorAll<HTMLElement>("[data-todo-row]");
  if (rows.length !== LONG_TODOS.length) {
    throw new Error(`Expected ${LONG_TODOS.length} TODO rows, found ${rows.length}`);
  }
  const scroller = rows[0].closest<HTMLElement>(".overflow-y-auto");
  if (scroller === null) {
    throw new Error("Pinned TODO scroll container not found");
  }
  // The list must actually overflow, or the visibility check below proves nothing.
  if (scroller.scrollHeight <= scroller.clientHeight) {
    throw new Error("Expected the long TODO list to overflow the pinned panel");
  }

  const currentIndex = LONG_TODOS.findIndex((todo) => todo.status === "in_progress");
  const current = rows[currentIndex].getBoundingClientRect();
  const visible = scroller.getBoundingClientRect();
  if (current.top < visible.top || current.bottom > visible.bottom) {
    throw new Error(
      `In-progress TODO row (${current.top}-${current.bottom}) is outside the panel's visible area (${visible.top}-${visible.bottom})`
    );
  }
  if (panel.scrollWidth > panel.clientWidth) {
    throw new Error("Pinned TODO panel overflows horizontally");
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

export const LongListDesktop: AppStory = {
  render: () => <AppWithMocks setup={() => setupLongTodoStory("ws-pinned-todo-long-desktop")} />,
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } },
  },
  play: async ({ canvasElement }) => {
    await assertCurrentTodoVisible(canvasElement);
  },
};

export const LongListPhone: AppStory = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  render: () => <AppWithMocks setup={() => setupLongTodoStory("ws-pinned-todo-long-phone")} />,
  decorators: [PhoneWidthDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  play: async ({ canvasElement }) => {
    await assertCurrentTodoVisible(canvasElement);
  },
};
