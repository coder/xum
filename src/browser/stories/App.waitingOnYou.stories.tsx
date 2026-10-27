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

function setupWaitingStory(workspaceId: string) {
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
      emit({
        type: "held-inputs-changed",
        workspaceId: id,
        heldInputs: [
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
        ],
      });
      emit({
        type: "queued-message-changed",
        workspaceId: id,
        queuedMessages: [QUEUED_TEXT],
        displayText: QUEUED_TEXT,
      });
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

// The sheet opens by matchMedia, so the test-runner needs a real phone viewport
// (.storybook/test-runner.ts), like the live line's phone story.
export const Phone: AppStory = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  render: () => <AppWithMocks setup={() => setupWaitingStory("ws-waiting-phone")} />,
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const dock = await findDock(canvasElement);
    const summary = await waitFor(
      () => {
        const button = dock.querySelector<HTMLElement>('[data-component="WaitingOnYouSummary"]');
        if (button === null) throw new Error("No Waiting on you summary");
        return button;
      },
      { timeout: 10_000 }
    );
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

    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Waiting on you/ })).toBeNull()
    );
    await waitFor(() => expect(summary).toHaveFocus());
  },
};
