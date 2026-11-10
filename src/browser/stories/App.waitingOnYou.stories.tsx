/**
 * Several things waiting on the user at once (an open question, two unsent messages, a queued
 * follow-up) fold into one "Waiting on you" card above the composer instead of a banner each.
 *
 * Desktop: a tab per item and the chosen item's content; the queued message stays a row under
 * the card. Phones: one summary row that opens a sheet with the chosen item and a row for each
 * of the others. Switching items never remounts them: a half-answered question keeps its pick.
 *
 * Play-only: the Pixel snapshot budget is full, and the plays carry the behavior.
 */

import { expect, screen, userEvent, waitFor, within } from "storybook/test";

import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { createAsyncAskUserQuestionTool } from "./mocks/tools";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";

export default {
  ...appMeta,
  title: "App/WaitingOnYou",
};

const QUESTIONS = [
  {
    question: "Which reviewers should get the ready PRs?",
    header: "Reviewers",
    options: [
      { label: "Spread them across the owners", description: "One PR each, round robin." },
      { label: "One reviewer per area", description: "Whoever owns the package." },
    ],
    multiSelect: false,
  },
  {
    question: "When should the stack merge?",
    header: "Merge",
    options: [
      { label: "As soon as CI passes", description: "Bottom first, one at a time." },
      { label: "Hold until Monday", description: "Nothing merges over the weekend." },
    ],
    multiSelect: false,
  },
];

const QUEUED_TEXT = "Also restack the follow-up once the base lands, then ping the owner.";

function heldInputsChanged(workspaceId: string, held: boolean): WorkspaceChatMessage {
  return {
    type: "held-inputs-changed",
    workspaceId,
    heldInputs: held
      ? [
          {
            id: "held-1",
            reason: "interrupted",
            displayText: "Rebase onto main before the next push.",
            attachmentCount: 0,
            reviewCount: 0,
          },
          {
            id: "held-2",
            reason: "interrupted",
            displayText: "Then rerun the flaky shard.",
            attachmentCount: 0,
            reviewCount: 0,
          },
        ]
      : [],
  };
}

function setupWaitingStory(
  workspaceId: string,
  onEmit?: (emit: (message: WorkspaceChatMessage) => void) => void
) {
  return setupSimpleChatStory({
    workspaceId,
    workspaceName: "provider-stack",
    projectName: "xum",
    messages: [
      createUserMessage("msg-1", "Merge the provider stack once it is green.", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 120_000,
      }),
      createAssistantMessage("msg-2", "Two choices first; I'll keep checking CI meanwhile.", {
        historySequence: 2,
        timestamp: STABLE_TIMESTAMP - 110_000,
        toolCalls: [createAsyncAskUserQuestionTool("call-ask-waiting", QUESTIONS)],
      }),
    ],
    onChat: (id, emit) => {
      emit(heldInputsChanged(id, true));
      emit({
        type: "queued-message-changed",
        workspaceId: id,
        queuedMessages: [QUEUED_TEXT],
        displayText: QUEUED_TEXT,
      });
      onEmit?.(emit);
    },
  });
}

const REVIEWER_OPTION = { name: /One reviewer per area/ };

async function findDock(canvasElement: HTMLElement): Promise<HTMLElement> {
  return waitFor(
    () => {
      const dock = canvasElement.querySelector<HTMLElement>('[data-testid="chat-composer-dock"]');
      if (dock === null) throw new Error("No composer dock");
      return dock;
    },
    { timeout: 10_000 }
  );
}

export const Desktop: AppStory = {
  render: () => <AppWithMocks setup={() => setupWaitingStory("ws-waiting-desktop")} />,
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const dock = await findDock(canvasElement);
    const card = await within(dock).findByRole(
      "region",
      { name: "Waiting on you" },
      { timeout: 10_000 }
    );
    await expect(within(card).getByText(/2 waiting on you/)).toBeVisible();
    const tabs = within(card).getByRole("tablist", { name: "Waiting on you" });
    await expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent)
    ).toEqual(["2 questions", "2 unsent"]);

    // The question opens first. Answer it (the form moves on to the next question), look at the
    // unsent messages, come back: the form is still on the next question, so switching did not
    // remount it (a new form would start over at the first question).
    await userEvent.click(
      await within(card).findByRole("button", REVIEWER_OPTION, { timeout: 10_000 })
    );
    await expect(await within(card).findByText(QUESTIONS[1].question)).toBeVisible();
    await userEvent.click(within(tabs).getByRole("tab", { name: "2 unsent" }));
    await expect(within(card).getByText("Rebase onto main before the next push.")).toBeVisible();
    await expect(within(dock).getByText(QUESTIONS[1].question)).not.toBeVisible();
    await userEvent.click(within(tabs).getByRole("tab", { name: "2 questions" }));
    await expect(within(card).getByText(QUESTIONS[1].question)).toBeVisible();

    // Each item shows once: no second copy of the question or the unsent messages outside it.
    await expect(dock.querySelectorAll('[data-component="AskUserQuestionDock"]')).toHaveLength(1);

    // The queued message sends by itself: a row of its own under the card, not a tab.
    const queued = within(dock).getByText(QUEUED_TEXT);
    await expect(queued).toBeVisible();
    await expect(card.contains(queued)).toBe(false);
    await expect(
      card.compareDocumentPosition(queued) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // The chevron folds the card down to its tab strip.
    await userEvent.click(within(card).getByRole("button", { name: "Hide what is waiting" }));
    await expect(within(dock).getByText(QUESTIONS[1].question)).not.toBeVisible();
    await userEvent.click(within(card).getByRole("button", { name: "Show what is waiting" }));
    await expect(within(card).getByText(QUESTIONS[1].question)).toBeVisible();
  },
};

// The count-change stories' chat, to drop and restore the unsent messages mid-play.
let emitCountChangeChat: ((message: WorkspaceChatMessage) => void) | null = null;
const COUNT_CHANGE_WORKSPACE = "ws-waiting-count";

function renderCountChangeStory(workspaceId: string) {
  return (
    <AppWithMocks
      setup={() =>
        setupWaitingStory(workspaceId, (emit) => {
          emitCountChangeChat = emit;
        })
      }
    />
  );
}

function emitHeldInputs(workspaceId: string, held: boolean): void {
  const emit = emitCountChangeChat;
  if (emit === null) throw new Error("The story's chat never subscribed");
  emit(heldInputsChanged(workspaceId, held));
}

/**
 * Another item leaving or arriving while the user types an answer: the card breaks up or forms
 * around the question, which keeps its textarea and its focus, so typing goes on (a remount would
 * drop focus to the page and lose the next keystrokes).
 */
export const CountChangeKeepsTyping: AppStory = {
  render: () => renderCountChangeStory(COUNT_CHANGE_WORKSPACE),
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const dock = await findDock(canvasElement);
    const card = await within(dock).findByRole(
      "region",
      { name: "Waiting on you" },
      { timeout: 10_000 }
    );
    await userEvent.click(
      await within(card).findByRole("button", { name: /^Other/ }, { timeout: 10_000 })
    );
    const answer = await within(card).findByPlaceholderText("Type your answer");
    await userEvent.click(answer);
    await userEvent.keyboard("use");

    emitHeldInputs(COUNT_CHANGE_WORKSPACE, false);
    await waitFor(() =>
      expect(within(dock).queryByRole("region", { name: "Waiting on you" })).toBeNull()
    );
    await expect(within(dock).getByPlaceholderText("Type your answer")).toBe(answer);
    await expect(answer).toHaveFocus();
    await userEvent.keyboard(" redis");

    emitHeldInputs(COUNT_CHANGE_WORKSPACE, true);
    const formed = await within(dock).findByRole("region", { name: "Waiting on you" });
    await expect(formed.contains(answer)).toBe(true);
    await expect(answer).toHaveFocus();
    await userEvent.keyboard(" now");
    await expect(answer).toHaveValue("use redis now");
  },
};

async function findSummary(dock: HTMLElement): Promise<HTMLElement> {
  return waitFor(
    () => {
      const button = dock.querySelector<HTMLElement>('[data-component="WaitingOnYouSummary"]');
      if (button === null) throw new Error("No Waiting on you summary");
      return button;
    },
    { timeout: 10_000 }
  );
}

/**
 * The queued message's dispatch menu opens in full view in the sheet. The sheet scrolls, and a
 * menu above the row of a short message would run off the sheet's top, where no scroll reaches.
 */
async function assertDispatchMenuInReach(sheet: HTMLElement) {
  const status = sheet.querySelector<HTMLElement>('[data-component="QueuedMessageStatus"]');
  if (status === null) throw new Error("No queued message status in the sheet");
  await userEvent.click(status);
  const menu = await within(sheet).findByRole("menu");
  for (const item of within(menu).getAllByRole("menuitem")) {
    const box = item.getBoundingClientRect();
    // Both edges: a menu cut off at the sheet's top can still show the middle of its first choice.
    for (const y of [box.top + 1, box.bottom - 1]) {
      const hit = document.elementFromPoint(box.left + box.width / 2, y);
      await expect(hit?.closest('[role="menuitem"]')).toBe(item);
    }
  }
  await userEvent.click(status);
  await waitFor(() => expect(within(sheet).queryByRole("menu")).toBeNull());
}

// The sheet opens by matchMedia, so the test-runner needs a real phone viewport
// (.storybook/test-runner.ts), like the live line's phone story.
export const Phone: AppStory = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  render: () => <AppWithMocks setup={() => setupWaitingStory("ws-waiting-phone")} />,
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const dock = await findDock(canvasElement);
    const summary = await findSummary(dock);
    await expect(summary).toHaveTextContent("Which reviewers should get the ready PRs?");
    await expect(summary).toHaveTextContent("1 more waiting · 1 queued");
    // Folded into the summary: neither the form nor the queued row takes the phone's height.
    await expect(within(dock).queryByRole("button", REVIEWER_OPTION)).toBeNull();
    await expect(within(dock).getByText(QUEUED_TEXT)).not.toBeVisible();

    await userEvent.click(summary);
    const sheet = await screen.findByRole("dialog", { name: /Waiting on you/ });
    await expect(
      await within(sheet).findByRole("button", REVIEWER_OPTION, { timeout: 10_000 })
    ).toBeVisible();
    const others = within(sheet).getByRole("list", { name: "Also waiting" });
    await userEvent.click(within(others).getByRole("button", { name: /2 unsent messages/ }));
    await expect(within(sheet).getByText("Then rerun the flaky shard.")).toBeVisible();
    await userEvent.click(within(others).getByRole("button", { name: /Queued/ }));
    await expect(within(sheet).getByText(QUEUED_TEXT)).toBeVisible();
    await assertDispatchMenuInReach(sheet);

    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Waiting on you/ })).toBeNull()
    );
    await waitFor(() => expect(summary).toHaveFocus());
  },
};

const PHONE_COUNT_CHANGE_WORKSPACE = "ws-waiting-count-phone";

/**
 * The count change on a phone, typing in the sheet: once only the question is left, the sheet
 * closes and the question goes back inline, still focused, so typing goes on. The sheet keeps the
 * page behind it inert until it closes, and an inert textarea cannot take the focus back.
 */
export const PhoneCountChangeKeepsTyping: AppStory = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  render: () => renderCountChangeStory(PHONE_COUNT_CHANGE_WORKSPACE),
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const dock = await findDock(canvasElement);
    await userEvent.click(await findSummary(dock));
    const sheet = await screen.findByRole("dialog", { name: /Waiting on you/ });
    await userEvent.click(
      await within(sheet).findByRole("button", { name: /^Other/ }, { timeout: 10_000 })
    );
    const answer = await within(sheet).findByPlaceholderText("Type your answer");
    await userEvent.click(answer);
    await userEvent.keyboard("use");

    emitHeldInputs(PHONE_COUNT_CHANGE_WORKSPACE, false);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Waiting on you/ })).toBeNull()
    );
    await expect(within(dock).getByPlaceholderText("Type your answer")).toBe(answer);
    await expect(answer).toBeVisible();
    await expect(answer).toHaveFocus();
    await userEvent.keyboard(" redis");
    await expect(answer).toHaveValue("use redis");
  },
};
