/**
 * The composer's live line in its busiest state: a turn is streaming while a TODO list, sub-agents,
 * background bashes, pending reviews and Chat Instructions are all active. Each kind used to take
 * its own full-width row above the composer; now each is a chip on the streaming status row, and
 * its list opens in a panel above the line. The SubAgentsOnly stories cover the line with one
 * bordered chip and no TODO list.
 *
 * Play-only: the Pixel snapshot budget is full, and the plays (not a snapshot) carry the behavior.
 */

import type { ComponentType } from "react";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";

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
import {
  findChatActivityPanel,
  openChatActivityPanel,
  waitForChatMessagesLoaded,
} from "./storyPlayHelpers.js";

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

const BACKGROUND_BASHES = [
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
];

// Set by the story setup so the play can end the streaming turn.
let emitChat: (event: WorkspaceChatMessage) => void = () => {
  throw new Error("ComposerActivityLine story setup has not run");
};

// "sub-agents-only" drops the TODO list and every other chip, leaving one bordered chip.
function setupActivityLineStory(
  workspaceId: string,
  activity: "worst-case" | "sub-agents-only" = "worst-case"
) {
  const worstCase = activity === "worst-case";
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

  if (worstCase) {
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
  }
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
      toolCalls: worstCase ? [createTodoWriteTool("call-todo", TODOS)] : [],
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
    backgroundProcesses: new Map(worstCase ? [[workspaceId, BACKGROUND_BASHES]] : []),
    additionalSystemContexts: new Map(
      worstCase
        ? [[workspaceId, { content: "Merge one PR at a time, bottom first.", enabled: true }]]
        : []
    ),
  });
}

// TODO, sub-agents, background bashes, reviews and Chat Instructions.
const CHIP_COUNT = 5;

async function findLine(canvasElement: HTMLElement, chipCount = CHIP_COUNT): Promise<HTMLElement> {
  const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
  await waitForChatMessagesLoaded(storyRoot);
  return waitFor(
    () => {
      const line = storyRoot.querySelector<HTMLElement>('[data-component="ChatActivityLine"]');
      const chips = line?.querySelectorAll("[data-activity-chip]") ?? [];
      if (line == null || chips.length < chipCount) {
        throw new Error(`Expected ${chipCount} chips in the live line, found ${chips.length}`);
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

async function assertPanels(line: HTMLElement, surface: "popover" | "sheet") {
  const chip = await openChatActivityPanel(line, "PinnedTodoList");
  const panel = await findChatActivityPanel();
  await expect(within(panel).getByText("Report the stack as merged")).toBeVisible();
  const panelRect = panel.getBoundingClientRect();
  await expect(panelRect.left).toBeGreaterThanOrEqual(0);
  await expect(panelRect.right).toBeLessThanOrEqual(window.innerWidth);

  // Switching lists swaps the panel instead of stacking a second one.
  if (surface === "sheet") {
    // Phones: the panels share the activity sheet, whose tabs switch between them.
    const sheet = panel.closest<HTMLElement>('[role="dialog"]');
    if (sheet === null) throw new Error("The TODO panel opened outside the activity sheet");
    await userEvent.click(within(sheet).getByRole("tab", { name: /Bashes/ }));
  } else {
    // Wide viewports: a popover above the line.
    await expect(panelRect.bottom).toBeLessThanOrEqual(line.getBoundingClientRect().top);
    await openChatActivityPanel(line, "BackgroundProcessesBanner");
  }
  await waitFor(() => expect(document.querySelectorAll("[data-activity-panel]")).toHaveLength(1));
  await expect(within(await findChatActivityPanel()).getByText("CI watch")).toBeVisible();

  // Escape closes the panel and leaves the stream running.
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.querySelector("[data-activity-panel]")).toBeNull());
  await expect(within(line).getByRole("button", { name: "Stop streaming" })).toBeVisible();
  await expect(chip).toHaveAttribute("aria-expanded", "false");
}

// Clearing the plan and writing it again must leave one TODO chip: a stale chip from the cleared
// plan once stayed behind (sibling chips shared a React key) next to the new one. The TODO chip
// coming and going must not remount the chips after it either, which would close their panel.
async function assertTodoChipFollowsRewrite(line: HTMLElement, workspaceId: string) {
  const writeTodos = (toolCallId: string, todos: TodoItem[]) => {
    emitChat({
      type: "tool-call-start",
      workspaceId,
      messageId: "msg-3",
      toolCallId,
      toolName: "todo_write",
      args: { todos },
      tokens: 5,
      timestamp: STABLE_TIMESTAMP,
    });
    emitChat({
      type: "tool-call-end",
      workspaceId,
      messageId: "msg-3",
      toolCallId,
      toolName: "todo_write",
      result: { success: true, count: todos.length },
      timestamp: STABLE_TIMESTAMP,
    });
  };
  const todoChips = () => line.querySelectorAll('[data-component="PinnedTodoList"]');
  const bashesChip = await openChatActivityPanel(line, "BackgroundProcessesBanner");
  writeTodos("call-todo-clear", []);
  await waitFor(() => expect(todoChips()).toHaveLength(0));
  writeTodos("call-todo-again", TODOS);
  await waitFor(() => expect(todoChips()).toHaveLength(1));
  await expect(within(await findChatActivityPanel()).getByText("CI watch")).toBeVisible();
  await expect(bashesChip).toBeInTheDocument();
  await expect(bashesChip).toHaveAttribute("aria-expanded", "true");
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
  await expect(
    within(await findChatActivityPanel()).getByText("Report the stack as merged")
  ).toBeVisible();
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
    await assertPanels(line, "popover");
    await assertTodoChipFollowsRewrite(line, "ws-activity-line-desktop");
    await assertPanelSurvivesTurnEnd(line, "ws-activity-line-desktop");
  },
};

// Four tabs do not fit a phone's sheet: the strip scrolls instead of squeezing a tab below its
// label and count (which then overlap the next tab's), and the sheet opens with its tab in view.
async function assertSheetTabs(line: HTMLElement) {
  await userEvent.click(within(line).getByRole("button", { name: /pending review/ }));
  const sheet = await screen.findByRole("dialog", { name: "Activity" });
  const strip = within(sheet).getByRole("tablist");
  for (const tab of within(strip).getAllByRole("tab")) {
    await expect(tab.scrollWidth).toBeLessThanOrEqual(tab.clientWidth);
  }
  await expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
  const stripRect = strip.getBoundingClientRect();
  const tabRect = within(strip).getByRole("tab", { selected: true }).getBoundingClientRect();
  await expect(tabRect.left).toBeGreaterThanOrEqual(stripRect.left);
  await expect(tabRect.right).toBeLessThanOrEqual(stripRect.right);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.querySelector("[data-activity-panel]")).toBeNull());
}

// The line opens its panels in the phone sheet by matchMedia, so a phone-sized frame inside a
// desktop window would test the popover. The Storybook test-runner applies no globals.viewport:
// .storybook/test-runner.ts gives this story a real phone viewport instead.
export const WorstCasePhone: AppStory = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  render: () => <AppWithMocks setup={() => setupActivityLineStory("ws-activity-line-phone")} />,
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    const line = await findLine(canvasElement);
    await assertOneLine(line);
    await assertPanels(line, "sheet");
    await assertSheetTabs(line);
  },
};

// Without a TODO chip the bordered chips follow the status label instead of sitting next to Stop
// with a divider on each side of an empty gap.
async function assertChipsLeftWithoutDividers(line: HTMLElement) {
  const chips = line.querySelectorAll<HTMLElement>(
    '[data-component="SubAgentTasksDecoration"] [data-activity-chip]'
  );
  await expect(chips).toHaveLength(1);
  await expect(line.querySelectorAll("[data-activity-chip]")).toHaveLength(1);
  const lineRect = line.getBoundingClientRect();
  const lineMiddle = lineRect.left + lineRect.width / 2;
  await expect(chips[0].getBoundingClientRect().right).toBeLessThan(lineMiddle);
  const stopRight = within(line)
    .getByRole("button", { name: "Stop streaming" })
    .getBoundingClientRect().right;
  await expect(stopRight).toBeGreaterThan(lineMiddle);
  await expect(stopRight).toBeLessThanOrEqual(lineRect.right);
  const dividers = [...line.querySelectorAll<HTMLElement>("[aria-hidden]")].filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.width <= 1 && rect.height > 0;
  });
  await expect(dividers).toHaveLength(0);
}

export const SubAgentsOnlyDesktop: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => setupActivityLineStory("ws-activity-line-subagents-desktop", "sub-agents-only")}
    />
  ),
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    const line = await findLine(canvasElement, 1);
    await assertChipsLeftWithoutDividers(line);
  },
};

// The line lays out by its own @container width, so a phone-width frame gives the test-runner
// (which applies no globals.viewport) the phone line.
function PhoneFrameDecorator(Story: ComponentType) {
  return (
    <div style={{ width: 390, maxWidth: "100%", height: 844, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

export const SubAgentsOnlyPhone: AppStory = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  decorators: [PhoneFrameDecorator],
  render: () => (
    <AppWithMocks
      setup={() => setupActivityLineStory("ws-activity-line-subagents-phone", "sub-agents-only")}
    />
  ),
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    const line = await findLine(canvasElement, 1);
    await assertOneLine(line);
    await assertChipsLeftWithoutDividers(line);
  },
};
