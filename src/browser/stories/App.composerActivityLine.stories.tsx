/**
 * The composer's live line in its busiest state: a turn is streaming while a TODO list, sub-agents,
 * background bashes, pending reviews and Chat Instructions are all active. Each kind used to take
 * its own full-width row above the composer; now each is a chip on the streaming status row, and
 * its list opens in a panel above the line.
 *
 * Play-only: the Pixel snapshot budget is full, and the plays (not a snapshot) carry the behavior.
 */

import type { ComponentType } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { DEFAULT_MODEL } from "@/common/constants/knownModels";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { TodoItem } from "@/common/types/tools";

import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { createOnChatAdapter } from "./helpers/chatSetup";
import { createReview } from "./helpers/reviews";
import { collapseLeftSidebar, collapseRightSidebar, selectWorkspace } from "./helpers/uiState";
import { createStreamingChatHandler } from "./mocks/chatHandlers";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { createMockORPCClient } from "./mocks/orpc";
import { seedMockReviewState } from "./mocks/reviewState";
import { createTodoWriteTool } from "./mocks/tools";
import { createWorkspace, groupWorkspacesByProject, STABLE_TIMESTAMP } from "./mocks/workspaces";
import { openChatActivityPanel, waitForChatMessagesLoaded } from "./storyPlayHelpers.js";

export default {
  ...appMeta,
  title: "App/ComposerActivityLine",
};

const PROJECT_NAME = "xum";
const PROJECT_PATH = "/home/user/projects/xum";

const TODOS: TodoItem[] = [
  { content: "Land the bottom PR of the provider stack", status: "completed" },
  { content: "Land the second PR", status: "completed" },
  { content: "Merge #30958 once CI and Codex pass", status: "in_progress" },
  { content: "Merge the next PR in the stack", status: "pending" },
  { content: "Report the stack as merged", status: "pending" },
];

// Set by the story setup so the play can end the streaming turn.
let emitChat: (event: WorkspaceChatMessage) => void = () => {
  throw new Error("ComposerActivityLine story setup has not run");
};

function setupActivityLineStory(workspaceId: string) {
  const parent = createWorkspace({
    id: workspaceId,
    name: "provider-stack",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
  });
  const subAgents = [
    { id: `${workspaceId}-agent-ci`, title: "Watch CI on #30958", taskStatus: "running" as const },
    {
      id: `${workspaceId}-agent-codex`,
      title: "Read the Codex review",
      taskStatus: "running" as const,
    },
    { id: `${workspaceId}-agent-audit`, title: "Audit the stack", taskStatus: "reported" as const },
  ].map((agent) =>
    createWorkspace({
      ...agent,
      name: agent.id,
      projectName: PROJECT_NAME,
      projectPath: PROJECT_PATH,
      parentWorkspaceId: workspaceId,
    })
  );
  const workspaces = [parent, ...subAgents];

  seedMockReviewState(workspaceId, {
    reviews: {
      "review-1": createReview(
        "review-1",
        "src/node/provider.ts",
        "42-48",
        "Drop the retry",
        "pending",
        STABLE_TIMESTAMP
      ),
      "review-2": createReview(
        "review-2",
        "src/node/transport.ts",
        "10",
        "Rename",
        "pending",
        STABLE_TIMESTAMP
      ),
    },
  });
  selectWorkspace(parent);
  collapseLeftSidebar();
  collapseRightSidebar();

  const messages = [
    createUserMessage(
      "msg-1",
      "Merge the stack bottom first. Wait for CI and Codex on every head.",
      {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 120_000,
      }
    ),
    createAssistantMessage("msg-2", "#30928 and #30929 landed. Watching #30958 next.", {
      historySequence: 2,
      timestamp: STABLE_TIMESTAMP - 110_000,
      toolCalls: [createTodoWriteTool("call-todo", TODOS)],
    }),
  ];

  const streaming = createStreamingChatHandler({
    messages,
    streamingMessageId: "msg-3",
    model: DEFAULT_MODEL,
    historySequence: 3,
    streamText: "Checking CI on #30958.",
  });

  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
    onChat: createOnChatAdapter(
      new Map([
        [
          workspaceId,
          (callback) => {
            emitChat = callback;
            return streaming(callback);
          },
        ],
      ])
    ),
    backgroundProcesses: new Map([
      [
        workspaceId,
        [
          {
            id: "bash-ci",
            pid: 4242,
            script: "gh pr checks 30958 --watch",
            displayName: "CI watch",
            startTime: STABLE_TIMESTAMP - 90_000,
            status: "running" as const,
          },
          {
            id: "bash-dev",
            pid: 4343,
            script: "bun run dev",
            displayName: "dev server",
            startTime: STABLE_TIMESTAMP - 60_000,
            status: "running" as const,
          },
        ],
      ],
    ]),
    additionalSystemContexts: new Map([
      [workspaceId, { content: "Merge one PR at a time, bottom first.", enabled: true }],
    ]),
  });
}

// TODO, sub-agents, background bashes, reviews and Chat Instructions.
const CHIP_COUNT = 5;

async function findLine(canvasElement: HTMLElement): Promise<HTMLElement> {
  const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
  await waitForChatMessagesLoaded(storyRoot);
  return waitFor(
    () => {
      const line = storyRoot.querySelector<HTMLElement>('[data-component="ChatActivityLine"]');
      const chips = line?.querySelectorAll("[data-activity-chip]") ?? [];
      if (line == null || chips.length < CHIP_COUNT) {
        throw new Error(`Expected five chips in the live line, found ${chips.length}`);
      }
      if (within(line).queryByRole("button", { name: "Stop streaming" }) == null) {
        throw new Error("Live line is not streaming yet");
      }
      return line;
    },
    { timeout: 10_000 }
  );
}

async function assertOneLine(line: HTMLElement) {
  const stop = within(line).getByRole("button", { name: "Stop streaming" });
  const chips = [...line.querySelectorAll<HTMLElement>("[data-activity-chip]")];
  const centers = new Set(
    [stop, ...chips].map((element) => {
      const rect = element.getBoundingClientRect();
      return Math.round(rect.top + rect.height / 2);
    })
  );
  // Status, chips and Stop share one row instead of stacking a row per kind.
  await expect(centers.size).toBe(1);
  const lineRect = line.getBoundingClientRect();
  await expect(stop.getBoundingClientRect().right).toBeLessThanOrEqual(lineRect.right);
}

async function assertPanels(line: HTMLElement) {
  const chip = await openChatActivityPanel(line, "PinnedTodoList");
  const panel = await waitFor(() => {
    const found = line.querySelector<HTMLElement>("[data-activity-panel]");
    if (found == null) throw new Error("TODO panel did not open");
    return found;
  });
  await expect(within(panel).getByText("Report the stack as merged")).toBeVisible();
  const panelRect = panel.getBoundingClientRect();
  await expect(panelRect.left).toBeGreaterThanOrEqual(0);
  await expect(panelRect.right).toBeLessThanOrEqual(window.innerWidth);
  await expect(panelRect.bottom).toBeLessThanOrEqual(line.getBoundingClientRect().top);

  // Opening another chip swaps the panel instead of stacking a second one.
  await openChatActivityPanel(line, "BackgroundProcessesBanner");
  await waitFor(() => expect(line.querySelectorAll("[data-activity-panel]")).toHaveLength(1));
  await expect(within(line).getByText("CI watch")).toBeVisible();

  // Escape closes the panel and leaves the stream running.
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(line.querySelector("[data-activity-panel]")).toBeNull());
  await expect(within(line).getByRole("button", { name: "Stop streaming" })).toBeVisible();
  await expect(chip).toHaveAttribute("aria-expanded", "false");
}

// A turn ending must not remount the chips: that would close the open panel (and a bash output
// dialog opened from it) and drop the chips' state.
async function assertPanelSurvivesTurnEnd(line: HTMLElement, workspaceId: string) {
  await openChatActivityPanel(line, "PinnedTodoList");
  emitChat({
    type: "stream-end",
    workspaceId,
    messageId: "msg-3",
    metadata: { model: DEFAULT_MODEL },
    parts: [{ type: "text", text: "Checking CI on #30958." }],
  });
  emitChat({ type: "stream-lifecycle", workspaceId, phase: "idle", hadAnyOutput: true });
  await waitFor(() =>
    expect(within(line).queryByRole("button", { name: "Stop streaming" })).toBeNull()
  );
  await expect(within(line).getByText("Report the stack as merged")).toBeVisible();
}

export const WorstCaseDesktop: AppStory = {
  render: () => <AppWithMocks setup={() => setupActivityLineStory("ws-activity-line-desktop")} />,
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    const line = await findLine(canvasElement);
    await assertOneLine(line);
    await assertPanels(line);
    await assertPanelSurvivesTurnEnd(line, "ws-activity-line-desktop");
  },
};

function PhoneWidthDecorator(Story: ComponentType) {
  // The Storybook test-runner ignores Pixel viewports, so the phone width comes from this frame.
  return (
    <div style={{ width: 390, height: 844, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

export const WorstCasePhone: AppStory = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  render: () => <AppWithMocks setup={() => setupActivityLineStory("ws-activity-line-phone")} />,
  decorators: [PhoneWidthDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    const line = await findLine(canvasElement);
    await assertOneLine(line);
    await assertPanels(line);
  },
};
