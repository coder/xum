import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { ChatInputDecorationStackLane, TranscriptTailStackLane } from "./LayoutStackLane";
import {
  createChatInputDecorationStackItem,
  createTranscriptTailStackItem,
  selectVisibleChatInputDecorations,
} from "./layoutStack";

let cleanupDom: (() => void) | null = null;
const COMPOSER_STACK_COMPONENT = "ChatInputDecorationStack";
const TRANSCRIPT_TAIL_STACK_COMPONENT = "TranscriptTailStack";

function getRenderedStack(container: HTMLElement, dataComponent: string): HTMLDivElement {
  const stack = container.querySelector(`[data-component="${dataComponent}"]`);
  expect(stack).toBeTruthy();
  if (stack?.tagName !== "DIV") {
    throw new Error("Expected stack to exist");
  }
  return stack as HTMLDivElement;
}

describe("LayoutStackLane", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  it("renders nothing when a lane has no items", () => {
    const view = render(<ChatInputDecorationStackLane items={[]} />);
    expect(view.container.querySelector(`[data-component="${COMPOSER_STACK_COMPONENT}"]`)).toBe(
      null
    );
  });

  it("renders decoration items in declared order", () => {
    const view = render(
      <ChatInputDecorationStackLane
        items={[
          createChatInputDecorationStackItem({ key: "first", node: <div>first banner</div> }),
          createChatInputDecorationStackItem({ key: "second", node: <div>second banner</div> }),
        ]}
      />
    );

    const stack = getRenderedStack(view.container, COMPOSER_STACK_COMPONENT);
    expect(stack.textContent).toBe("first bannersecond banner");
  });

  it("keeps immediate queued-message chrome visible while deferred decorations are gated", () => {
    const queuedMessage = createChatInputDecorationStackItem({
      key: "queued-message",
      node: <div>queued follow-up</div>,
      revealBeforeReady: true,
    });
    const backgroundProcesses = createChatInputDecorationStackItem({
      key: "background-processes",
      node: <div>background processes</div>,
    });

    expect(selectVisibleChatInputDecorations([queuedMessage, backgroundProcesses], false)).toEqual([
      queuedMessage,
    ]);
    expect(selectVisibleChatInputDecorations([queuedMessage, backgroundProcesses], true)).toEqual([
      queuedMessage,
      backgroundProcesses,
    ]);
  });

  it("opts the transcript tail out of scroll anchoring but not the composer decorations", () => {
    // The tail lane renders inside the scrollport above the bottom sentinel, so it
    // must never be an anchor candidate while the transcript is locked; composer
    // decorations live in the sticky dock, which opts out as a whole in ChatPane.
    const view = render(
      <>
        <TranscriptTailStackLane
          items={[createTranscriptTailStackItem({ key: "barrier", node: <div>barrier</div> })]}
        />
        <ChatInputDecorationStackLane
          items={[createChatInputDecorationStackItem({ key: "banner", node: <div>banner</div> })]}
        />
      </>
    );

    expect(
      getRenderedStack(view.container, TRANSCRIPT_TAIL_STACK_COMPONENT).style.overflowAnchor
    ).toBe("none");
    expect(getRenderedStack(view.container, COMPOSER_STACK_COMPONENT).style.overflowAnchor).toBe(
      ""
    );
  });
});
