import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { ChatInputDecoration } from "./ChatInputDecoration";
import {
  ChatActivityPanelsProvider,
  useChatActivityPanel,
  type ChatActivityId,
} from "./chatActivityPanels";

let cleanupDom: (() => void) | null = null;

function Chip(props: { id: ChatActivityId; label: string }) {
  const [expanded, setExpanded] = useChatActivityPanel(props.id);
  return (
    <ChatInputDecoration
      activityId={props.id}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
      chipLabel={props.label}
      summary={props.label}
      renderExpanded={() => <p>{props.label} list</p>}
    />
  );
}

function renderLine(props: { showBashes?: boolean } = {}) {
  return (
    <div>
      <ChatActivityPanelsProvider>
        <Chip id="todo" label="TODO" />
        {props.showBashes !== false && <Chip id="background-bashes" label="Bashes" />}
      </ChatActivityPanelsProvider>
      <button type="button">outside</button>
    </div>
  );
}

describe("chat activity panels", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  it("keeps one panel open at a time", () => {
    const view = render(renderLine());

    fireEvent.click(view.getByRole("button", { name: "TODO" }));
    expect(view.queryByText("TODO list")).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Bashes" }));
    expect(view.queryByText("Bashes list")).not.toBeNull();
    expect(view.queryByText("TODO list")).toBeNull();
    expect(view.getByRole("button", { name: "TODO" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape without reaching window handlers, and refocuses the chip", () => {
    const view = render(renderLine());
    const chip = view.getByRole("button", { name: "TODO" });
    let windowSawEscape = false;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") windowSawEscape = true;
    };
    window.addEventListener("keydown", onWindowKeyDown);

    fireEvent.click(chip);
    fireEvent.keyDown(view.getByText("TODO list"), { key: "Escape" });
    window.removeEventListener("keydown", onWindowKeyDown);

    expect(view.queryByText("TODO list")).toBeNull();
    expect(windowSawEscape).toBe(false);
    expect(document.activeElement).toBe(chip);
  });

  it("leaves Escape to the window while every panel is closed", () => {
    // The global Escape handler interrupts the stream; a closed chip must not swallow it.
    const view = render(renderLine());
    let windowSawEscape = false;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") windowSawEscape = true;
    };
    window.addEventListener("keydown", onWindowKeyDown);

    fireEvent.keyDown(view.getByRole("button", { name: "TODO" }), { key: "Escape" });
    window.removeEventListener("keydown", onWindowKeyDown);

    expect(windowSawEscape).toBe(true);
  });

  it("closes when the user presses outside the line, not inside it", () => {
    const view = render(renderLine());

    fireEvent.click(view.getByRole("button", { name: "TODO" }));
    fireEvent.pointerDown(view.getByText("TODO list"));
    expect(view.queryByText("TODO list")).not.toBeNull();

    fireEvent.pointerDown(view.getByRole("button", { name: "outside" }));
    expect(view.queryByText("TODO list")).toBeNull();
  });

  it("does not reopen a panel whose chip left while it was open", () => {
    const view = render(renderLine());

    fireEvent.click(view.getByRole("button", { name: "Bashes" }));
    view.rerender(renderLine({ showBashes: false }));
    view.rerender(renderLine());

    expect(view.queryByText("Bashes list")).toBeNull();
  });
});
