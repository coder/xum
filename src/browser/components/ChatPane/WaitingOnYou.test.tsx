import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { Ban, Clock3, MessageCircleQuestion } from "lucide-react";
import { installDom, stubNarrowViewport } from "../../../../tests/ui/dom";

import { ChatDockSurface } from "./chatDockColumn";
import {
  arrangeWaiting,
  useWaitingOnYou,
  WaitingOnYouCard,
  WaitingOnYouProvider,
  WaitingOnYouSlot,
  type WaitingOnYouEntry,
  type WaitingOnYouId,
} from "./WaitingOnYou";

const QUESTION: WaitingOnYouEntry = {
  icon: MessageCircleQuestion,
  tab: "Question",
  title: "Which reviewers?",
  detail: "The agent asks you",
  urgent: true,
};
const UNSENT: WaitingOnYouEntry = {
  icon: Ban,
  tab: "2 unsent",
  title: "2 unsent messages",
  detail: "Not sent",
};
const QUEUED: WaitingOnYouEntry = {
  icon: Clock3,
  tab: "Queued",
  title: "Queued · sends after this step",
  detail: "Restack after the base lands",
};

/** Content with state of its own, to tell a moved item from a remounted one. */
function Counter(props: { label: string }) {
  const [count, setCount] = useState(0);
  return (
    <ChatDockSurface>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        {`${props.label} ${count}`}
      </button>
    </ChatDockSurface>
  );
}

/** Content that decides by itself whether it waits on the user, like the question dock. */
function SelfReporting(props: { open: boolean }) {
  useWaitingOnYou(props.open ? QUESTION : null);
  return props.open ? <Counter label="question" /> : null;
}

function Stack(props: { question?: boolean; unsent?: boolean; queued?: boolean }) {
  const slot = (id: WaitingOnYouId, entry: WaitingOnYouEntry | undefined, node: ReactNode) => (
    <WaitingOnYouSlot id={id} entry={entry}>
      {node}
    </WaitingOnYouSlot>
  );
  return (
    <WaitingOnYouProvider>
      <div data-testid="dock">
        {props.queued === true && slot("queued", QUEUED, <Counter label="queued" />)}
        {props.unsent === true && slot("held-inputs", UNSENT, <Counter label="unsent" />)}
        {slot("question", undefined, <SelfReporting open={props.question === true} />)}
        <WaitingOnYouCard />
      </div>
    </WaitingOnYouProvider>
  );
}

let cleanupDom: (() => void) | null = null;

/** Visible here means not inside a `hidden` ancestor: happy-dom has no layout. */
function isShown(element: HTMLElement): boolean {
  return element.closest(".hidden, [hidden]") === null;
}

describe("arrangeWaiting", () => {
  const entries = new Map<WaitingOnYouId, WaitingOnYouEntry>([
    ["queued", QUEUED],
    ["held-inputs", UNSENT],
    ["question", QUESTION],
  ]);

  it("lists what blocks the agent first, and the queued message only on phones", () => {
    expect(arrangeWaiting(entries, null, false).listed.map(([id]) => id)).toEqual([
      "question",
      "held-inputs",
    ]);
    expect(arrangeWaiting(entries, null, true).listed.map(([id]) => id)).toEqual([
      "question",
      "held-inputs",
      "queued",
    ]);
  });

  it("folds into a card from two waiting items; the queued message does not count", () => {
    expect(arrangeWaiting(entries, null, false).consolidated).toBe(true);
    const oneAndQueued = new Map(entries);
    oneAndQueued.delete("held-inputs");
    expect(arrangeWaiting(oneAndQueued, null, true).consolidated).toBe(false);
  });

  it("keeps the chosen item, and falls back to the first once it is gone", () => {
    expect(arrangeWaiting(entries, "held-inputs", false).selected).toBe("held-inputs");
    expect(arrangeWaiting(entries, "context-switch", false).selected).toBe("question");
    // The desktop card has no queued tab to keep.
    expect(arrangeWaiting(entries, "queued", false).selected).toBe("question");
    expect(arrangeWaiting(new Map(), null, false).selected).toBeNull();
  });
});

describe("Waiting on you", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  it("leaves a single item inline, without a card", () => {
    const view = render(<Stack unsent queued />);
    expect(view.queryByRole("region", { name: "Waiting on you" })).toBeNull();
    expect(isShown(view.getByRole("button", { name: "unsent 0" }))).toBe(true);
    expect(isShown(view.getByRole("button", { name: "queued 0" }))).toBe(true);
  });

  it("shows the chosen item in the card, and switching tabs keeps each item's state", () => {
    const view = render(<Stack question unsent queued />);
    const card = view.getByRole("region", { name: "Waiting on you" });
    expect(within(card).getByText(/2 waiting on you/)).not.toBeNull();
    const tabs = within(card).getAllByRole("tab");
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([
      ["Question", "true"],
      ["2 unsent", "false"],
    ]);

    const question = within(card).getByRole("button", { name: "question 0" });
    fireEvent.click(question);
    fireEvent.click(within(card).getByRole("tab", { name: "2 unsent" }));
    expect(card.contains(view.getByRole("button", { name: "unsent 0" }))).toBe(true);
    expect(card.contains(question)).toBe(false);
    expect(isShown(question)).toBe(false);

    fireEvent.click(within(card).getByRole("tab", { name: "Question" }));
    expect(within(card).getByRole("button", { name: "question 1" })).toBe(question);
  });

  it("drops the docked gutter inside the card", () => {
    const view = render(<Stack question unsent />);
    const card = view.getByRole("region", { name: "Waiting on you" });
    const surface = within(card)
      .getByRole("button", { name: "question 0" })
      .closest('[data-component="ChatDockSurface"]');
    // The card's own surface wraps the card; the item's surface inside adds no column.
    expect(surface?.className ?? "").toBe("");
  });

  it("keeps the queued message as a row under the card, not a tab", () => {
    const view = render(<Stack question unsent queued />);
    const card = view.getByRole("region", { name: "Waiting on you" });
    const queued = view.getByRole("button", { name: "queued 0" });
    expect(card.contains(queued)).toBe(false);
    expect(isShown(queued)).toBe(true);
    expect(card.compareDocumentPosition(queued) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card).queryByRole("tab", { name: "Queued" })).toBeNull();
  });

  it("collapses to its tabs, and a tab opens it again", () => {
    const view = render(<Stack question unsent />);
    const card = view.getByRole("region", { name: "Waiting on you" });
    fireEvent.click(within(card).getByRole("button", { name: "Hide what is waiting" }));
    expect(isShown(view.getByRole("button", { name: "question 0", hidden: true }))).toBe(false);

    fireEvent.click(within(card).getByRole("tab", { name: "2 unsent" }));
    expect(isShown(view.getByRole("button", { name: "unsent 0" }))).toBe(true);
    expect(
      within(card)
        .getByRole("button", { name: "Hide what is waiting" })
        .getAttribute("aria-expanded")
    ).toBe("true");
  });

  it("moves between tabs with the arrow keys", () => {
    const view = render(<Stack question unsent />);
    const card = view.getByRole("region", { name: "Waiting on you" });
    const [questionTab, unsentTab] = within(card).getAllByRole("tab");
    questionTab.focus();
    fireEvent.keyDown(questionTab, { key: "ArrowRight" });
    expect(document.activeElement).toBe(unsentTab);
    expect(unsentTab.getAttribute("aria-selected")).toBe("true");
    // Wraps around at the ends.
    fireEvent.keyDown(unsentTab, { key: "ArrowRight" });
    expect(document.activeElement).toBe(questionTab);
    fireEvent.keyDown(questionTab, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(unsentTab);
  });

  it("puts an item back inline, state intact, when only one is left", () => {
    const view = render(<Stack question unsent />);
    fireEvent.click(view.getByRole("button", { name: "question 0" }));
    view.rerender(<Stack question />);
    expect(view.queryByRole("region", { name: "Waiting on you" })).toBeNull();
    const question = view.getByRole("button", { name: "question 1" });
    expect(isShown(question)).toBe(true);
  });

  it("forms the card when self-reporting content opens, and breaks it up when it closes", () => {
    const view = render(<Stack unsent />);
    expect(view.queryByRole("region", { name: "Waiting on you" })).toBeNull();
    view.rerender(<Stack question unsent />);
    expect(view.queryByRole("region", { name: "Waiting on you" })).not.toBeNull();
    view.rerender(<Stack unsent />);
    expect(view.queryByRole("region", { name: "Waiting on you" })).toBeNull();
  });

  describe("on a phone", () => {
    beforeEach(() => {
      stubNarrowViewport(true);
    });

    it("folds everything into one summary row that opens a sheet", () => {
      const view = render(<Stack question unsent queued />);
      const summary = view.getByRole("button", { name: /Which reviewers\?/ });
      expect(summary.textContent).toContain("The agent asks you · 1 more waiting · 1 queued");
      // Nothing else takes the phone's height, the queued message included.
      for (const name of ["question 0", "unsent 0", "queued 0"]) {
        expect(isShown(view.getByRole("button", { name, hidden: true }))).toBe(false);
      }

      fireEvent.click(summary);
      const sheet = view.getByRole("dialog", { name: /Waiting on you/ });
      expect(within(sheet).getByRole("button", { name: "question 0" })).not.toBeNull();
      const others = within(sheet).getByRole("list", { name: "Also waiting" });
      expect(
        within(others)
          .getAllByRole("button")
          .map((row) => row.textContent)
      ).toEqual([
        "2 unsent messagesNot sent",
        "Queued · sends after this stepRestack after the base lands",
      ]);

      fireEvent.click(within(others).getByRole("button", { name: /Queued/ }));
      expect(within(sheet).getByRole("button", { name: "queued 0" })).not.toBeNull();
      // The chosen row left the list: focus moved to what it opened.
      expect(sheet.contains(document.activeElement)).toBe(true);
      // Still headed by what waits, not by the queued message.
      expect(summary.textContent).toContain("Which reviewers?");

      act(() => {
        fireEvent.keyDown(sheet, { key: "Escape" });
      });
      expect(view.queryByRole("dialog", { name: /Waiting on you/ })).toBeNull();
    });
  });
});
