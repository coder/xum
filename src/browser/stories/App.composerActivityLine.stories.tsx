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
import { MOBILE_TOUCH_TARGET_PX } from "@/constants/layout";

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

/** The chips the line shows: the ones it has room for, and the "+N" chip once any do not fit. */
function shownChips(line: HTMLElement): HTMLElement[] {
  return [
    ...line.querySelectorAll<HTMLElement>("[data-activity-chip], [data-activity-overflow-chip]"),
  ].filter((chip) => getComputedStyle(chip).visibility !== "hidden");
}

async function assertOneLine(line: HTMLElement) {
  const stop = within(line).getByRole("button", { name: "Stop streaming" });
  const chips = shownChips(line);
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
  await expect(
    within(await findChatActivityPanel()).getByText("gh pr checks 30958 --watch")
  ).toBeVisible();

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
  await expect(
    within(await findChatActivityPanel()).getByText("gh pr checks 30958 --watch")
  ).toBeVisible();
  await expect(bashesChip).toBeInTheDocument();
  await expect(bashesChip).toHaveAttribute("aria-expanded", "true");
}

async function endTurn(line: HTMLElement, workspaceId: string) {
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
}

// A turn ending must not remount the chips: that would close the open panel (and a bash output
// dialog opened from it) and drop the chips' state.
async function assertPanelSurvivesTurnEnd(line: HTMLElement, workspaceId: string) {
  await openChatActivityPanel(line, "PinnedTodoList");
  await endTurn(line, workspaceId);
  await expect(
    within(await findChatActivityPanel()).getByText("Report the stack as merged")
  ).toBeVisible();
}

// The chips' shortcuts open their panel from the composer and focus it; the chord again, or
// Escape, closes it and puts focus back in the composer, with the stream still running.
async function assertPanelChords(line: HTMLElement, canvasElement: HTMLElement) {
  const composer = canvasElement.querySelector<HTMLTextAreaElement>("textarea");
  if (composer === null) throw new Error("No composer textarea");
  composer.focus();
  await userEvent.keyboard("{Control>}{Alt>}r{/Alt}{/Control}");
  const reviews = await findChatActivityPanel();
  await expect(reviews).toHaveAccessibleName("Reviews");
  await waitFor(() => expect(reviews.contains(document.activeElement)).toBe(true));
  await userEvent.keyboard("{Control>}{Alt>}r{/Alt}{/Control}");
  await waitFor(() => expect(document.querySelector("[data-activity-panel]")).toBeNull());
  await expect(composer).toHaveFocus();

  await userEvent.keyboard("{Control>}{Alt>}o{/Alt}{/Control}");
  const todo = await findChatActivityPanel();
  await expect(todo).toHaveAccessibleName("TODO");
  // A TODO list has no controls: the panel itself takes focus.
  await waitFor(() => expect(todo).toHaveFocus());
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.querySelector("[data-activity-panel]")).toBeNull());
  await expect(composer).toHaveFocus();
  await expect(within(line).getByRole("button", { name: "Stop streaming" })).toBeVisible();
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
    // Every chip fits a desktop line: no "+N" chip.
    await expect(within(line).queryByRole("button", { name: /\d+ more$/ })).toBeNull();
    await assertPanels(line, "popover");
    await assertPanelChords(line, canvasElement);
    await assertTodoChipFollowsRewrite(line, "ws-activity-line-desktop");
    await assertPanelSurvivesTurnEnd(line, "ws-activity-line-desktop");
  },
};

// The chips the line has no room for fold into a "+N" chip. Its list opens as a popover above the
// line here, and a row in it opens that chip's panel and moves focus to the panel's list; the
// panel's Escape or the chip's chord closes it and hands focus back to the "+N" chip (a folded chip
// cannot take focus). Reviews is the chip a live turn folds at this width, so the test drives that
// one, and the focus assertions follow any chip with a panel rather than naming a kind of row.
async function assertFoldedChipOpensFromList(line: HTMLElement) {
  const more = within(line).getByRole("button", { name: /^\d+ more$/ });
  for (const close of ["{Escape}", "{Control>}{Alt>}r{/Alt}{/Control}"]) {
    await userEvent.click(more);
    const list = await within(line).findByRole("group", { name: "More activity" });
    await userEvent.click(within(list).getByRole("button", { name: /Reviews/ }));
    await findChatActivityPanel();
    // Focus lands on a row of the panel's list: not on the page, not on the panel box, and not on
    // its header (the popover's Close button comes before the content in Tab order). The old line
    // named the background bashes row here; the chip a live turn folds follows the chips' widths, so
    // this asks for any row of whichever chip's panel opened.
    await waitFor(() =>
      expect(document.activeElement?.closest("[data-activity-panel-content] button")).not.toBeNull()
    );
    await userEvent.keyboard(close);
    await waitFor(() => expect(document.querySelector("[data-activity-panel]")).toBeNull());
    await expect(more).toHaveFocus();
  }
}

// A desktop window: matchMedia sees its width, so the panels open as popovers above the line,
// while the fixed-width frame narrows the line until chips fold into "+N".
export const NarrowPaneDesktop: AppStory = {
  render: () => <AppWithMocks setup={() => setupActivityLineStory("ws-activity-line-narrow")} />,
  decorators: [phoneFrame(375)],
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    const line = await findLine(canvasElement);
    await assertFoldedChipOpensFromList(line);
  },
};

// A phone line has no room for all five chips: the last ones move into a "+N" chip, which lists
// them. Its Reviews entry opens the reviews panel in the sheet, and closing it returns focus to
// the "+N" chip (the reviews chip is not shown).
async function openReviewsFromOverflow(line: HTMLElement) {
  const more = within(line).getByRole("button", { name: /^\d+ more$/ });
  const hidden = line.querySelectorAll('[data-activity-chip][class~="invisible"]');
  await expect(more).toHaveAccessibleName(`${hidden.length} more`);
  await expect(hidden.length).toBeGreaterThan(0);
  await expect(within(line).queryByRole("button", { name: /pending review/ })).toBeNull();
  await userEvent.click(more);
  const list = await within(line).findByRole("group", { name: "More activity" });
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(within(list).getByRole("button", { name: /Reviews/ }));
  return more;
}

// Four tabs do not fit a phone's sheet: the strip scrolls instead of squeezing a tab below its
// label and count (which then overlap the next tab's), and the sheet opens with its tab in view.
async function assertSheetTabs(line: HTMLElement) {
  const more = await openReviewsFromOverflow(line);
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
  await waitFor(() => expect(more).toHaveFocus());
}

// The chip that opened the sheet can move into the "+N" chip while the sheet is open: a turn
// that starts takes room for Stop. Closing the sheet returns focus to the "+N" chip then, not to
// the page: the hidden chip cannot take it. Which chip a turn pushes out follows the chips' widths,
// so the test reads it from the two layouts instead of naming one: the chip the live line folds,
// that fits once the turn ends. Only a chip with a panel (`aria-expanded`) opens the sheet.
async function assertSheetFocusWhenChipHides(line: HTMLElement, workspaceId: string) {
  const foldedWhileLive = [...line.querySelectorAll<HTMLElement>("[data-activity-chip]")].filter(
    (chip) => chip.hasAttribute("aria-expanded") && getComputedStyle(chip).visibility === "hidden"
  );
  const shown = (chip: HTMLElement) => getComputedStyle(chip).visibility !== "hidden";
  // Between turns the line has room for a chip that a live turn has none for.
  await endTurn(line, workspaceId);
  const chip = await waitFor(() => {
    const fits = foldedWhileLive.find((candidate) => shown(candidate));
    if (fits === undefined) {
      throw new Error("No chip the live line folds into +N fits the line once the turn ends");
    }
    return fits;
  });
  await userEvent.click(chip);
  await screen.findByRole("dialog", { name: "Activity" });

  emitChat({
    type: "stream-start",
    workspaceId,
    messageId: "msg-4",
    model: DEFAULT_MODEL,
    historySequence: 4,
    startTime: STABLE_TIMESTAMP,
  });
  await waitFor(() => expect(shown(chip)).toBe(false));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Activity" })).toBeNull());
  await waitFor(() =>
    expect(within(line).getByRole("button", { name: /^\d+ more$/ })).toHaveFocus()
  );
}

// The sheet is a modal over the page, its chips included: from inside it the chords still swap
// its panels and close them, and closing puts focus back in the composer.
async function assertSheetChords(canvasElement: HTMLElement) {
  const composer = canvasElement.querySelector<HTMLTextAreaElement>("textarea");
  if (composer === null) throw new Error("No composer textarea");
  composer.focus();
  await userEvent.keyboard("{Control>}{Alt>}r{/Alt}{/Control}");
  const sheet = await screen.findByRole("dialog", { name: "Activity" });
  const reviews = await findChatActivityPanel();
  await expect(reviews).toHaveAccessibleName("Reviews");
  await waitFor(() => expect(reviews.contains(document.activeElement)).toBe(true));

  await userEvent.keyboard("{Control>}{Alt>}j{/Alt}{/Control}");
  await waitFor(() =>
    expect(within(sheet).getByRole("tabpanel")).toHaveAccessibleName("Background bashes")
  );
  await waitFor(() => expect(document.activeElement?.closest("[data-process-row]")).not.toBeNull());
  await userEvent.keyboard("{Control>}{Alt>}j{/Alt}{/Control}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Activity" })).toBeNull());
  await waitFor(() => expect(composer).toHaveFocus());
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
    await assertSheetFocusWhenChipHides(line, "ws-activity-line-phone");
    await assertSheetChords(canvasElement);
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
    // The popover opens over its left-aligned chip, not at the line's far end.
    const chip = line.querySelector<HTMLElement>("[data-activity-chip]");
    if (chip === null) throw new Error("The sub-agents chip is missing");
    await userEvent.click(chip);
    const panelRect = (await findChatActivityPanel()).getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    await expect(panelRect.left).toBeLessThanOrEqual(chipRect.left);
    await expect(panelRect.right).toBeGreaterThanOrEqual(chipRect.right);
    await userEvent.keyboard("{Escape}");
  },
};

// The line lays out by its own @container width, so a phone-width frame gives the test-runner
// (which applies no globals.viewport) the phone line.
function phoneFrame(width: number) {
  return function PhoneFrameDecorator(Story: ComponentType) {
    return (
      <div style={{ width, maxWidth: "100%", height: 844, overflow: "hidden" }}>
        <Story />
      </div>
    );
  };
}

export const SubAgentsOnlyPhone: AppStory = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  decorators: [phoneFrame(390)],
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

/**
 * Does this element draw a box (a border or a fill), as opposed to only text and an icon? The line's
 * controls paint theirs on the child inside the touch target, so this is how a play tells the
 * drawing from the hit area without reading class names.
 */
function drawsABox(element: Element): boolean {
  if (element.getBoundingClientRect().height === 0) return false;
  const style = getComputedStyle(element);
  // A computed transparent color, which is how Chromium reports both `transparent` and `none`.
  const clear = (color: string) => color === "rgba(0, 0, 0, 0)" || color === "transparent";
  const widths = [
    style.borderTopWidth,
    style.borderRightWidth,
    style.borderBottomWidth,
    style.borderLeftWidth,
  ];
  const colors = [
    style.borderTopColor,
    style.borderRightColor,
    style.borderBottomColor,
    style.borderLeftColor,
  ];
  const bordered =
    widths.some((width) => parseFloat(width) > 0) && colors.some((color) => !clear(color));
  return bordered || !clear(style.backgroundColor) || style.backgroundImage !== "none";
}

// The phone line draws each of its controls smaller than the touch box around it, so it reads as a
// secondary row above the composer instead of a band of boxes as large as the composer's own
// controls. Neither Pixel nor the Storybook test-runner emulates `pointer: coarse`, so the 44px
// floor globals.css gives a phone's buttons is stood in for here, as in App.phoneViewports'
// IPhone17ProMaxTouchTargetRows. What this holds is the split itself: the hit area keeps the whole
// floor (a tap in a chip's empty corner still opens its panel), the drawing stays inside it, and it
// sits centered there.
export const PhoneHitAreaOutsizesItsDrawing: AppStory = {
  decorators: [phoneFrame(390)],
  render: () => (
    <AppWithMocks setup={() => setupActivityLineStory("ws-activity-line-phone-hit-area")} />
  ),
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    const line = await findLine(canvasElement);

    const touchFloor = document.createElement("style");
    // Both axes: globals.css sets min-width too, so a phone's layout needs both axes or a control
    // drawn off to one side of its 44px target stays invisible here.
    touchFloor.textContent = `[data-component="ChatActivityLine"] button { min-height: ${MOBILE_TOUCH_TARGET_PX}px; min-width: ${MOBILE_TOUCH_TARGET_PX}px; }`;
    document.head.append(touchFloor);
    try {
      await waitFor(() => {
        const controls = [
          ...shownChips(line),
          within(line).getByRole("button", { name: "Stop streaming" }),
        ];
        if (controls.length < 2) {
          throw new Error(
            `The phone line shows ${controls.length} controls, expected chips and Stop`
          );
        }
        let drawn = 0;
        for (const control of controls) {
          const name = control.getAttribute("aria-label") ?? "control";
          const hit = control.getBoundingClientRect();
          // The touch floor globals.css would set, and the row's growth with it: a control capped
          // below the floor reports its own height here. Half a pixel of play, because the runner's
          // browser lands layout on fractional pixels.
          if (hit.height < MOBILE_TOUCH_TARGET_PX - 0.5) {
            throw new Error(
              `${name} hits ${Math.round(hit.height)}px, under the ${MOBILE_TOUCH_TARGET_PX}px touch floor`
            );
          }
          // The split: the touch target draws nothing, so the control's look comes from a box drawn
          // inside it. A control that paints its own box paints it at the touch floor, which is the
          // band of 44px boxes this line gave up being.
          if (drawsABox(control)) {
            throw new Error(
              `${name} draws a ${Math.round(hit.height)}px box on the touch target itself, so the control is as large as its hit area`
            );
          }
          const boxes = [...control.querySelectorAll("*")].filter(drawsABox);
          // The plain TODO chip draws no box at all (text only), so there is nothing to size.
          if (boxes.length === 0) continue;
          drawn += 1;
          const tallest = boxes.reduce((best, box) =>
            box.getBoundingClientRect().height > best.getBoundingClientRect().height ? box : best
          );
          const drawing = tallest.getBoundingClientRect();
          if (drawing.height >= MOBILE_TOUCH_TARGET_PX) {
            throw new Error(
              `${name} draws ${Math.round(drawing.height)}px at the ${MOBILE_TOUCH_TARGET_PX}px touch floor, so the line reads as loud as the composer`
            );
          }
          if (drawing.height >= hit.height) {
            throw new Error(
              `${name} draws ${Math.round(drawing.height)}px inside a ${Math.round(hit.height)}px hit area, so the hit area does not outsize the drawing`
            );
          }
          // The drawing sits inside its hit area, and centered in it. globals.css grows the target on
          // both axes, so the spare room belongs on either side of the drawing: all of it on one side
          // reads as a control drawn crooked against its own tap target.
          const inset = {
            left: drawing.left - hit.left,
            right: hit.right - drawing.right,
            top: drawing.top - hit.top,
            bottom: hit.bottom - drawing.bottom,
          };
          if (Math.min(inset.left, inset.right, inset.top, inset.bottom) < -0.5) {
            throw new Error(
              `${name} draws outside its own hit area: ${Math.round(inset.left)}px from its left edge, ${Math.round(inset.right)}px from its right, ${Math.round(inset.top)}px from its top, ${Math.round(inset.bottom)}px from its bottom`
            );
          }
          const offCenter = Math.max(
            Math.abs(inset.left - inset.right),
            Math.abs(inset.top - inset.bottom)
          );
          if (offCenter > 1) {
            throw new Error(
              `${name} draws off center in its hit area: ${Math.round(inset.left)}px left, ${Math.round(inset.right)}px right, ${Math.round(inset.top)}px above, ${Math.round(inset.bottom)}px below`
            );
          }
        }
        // Otherwise the loop would pass by measuring nothing: a control that draws no box skips its
        // own checks.
        if (drawn === 0) {
          throw new Error("Nothing on the phone line draws a box, so no drawing was measured here");
        }
      });
      await assertOneLine(line);
    } finally {
      touchFloor.remove();
    }
  },
};
