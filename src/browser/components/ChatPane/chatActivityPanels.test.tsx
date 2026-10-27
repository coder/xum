import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type React from "react";
import { installDom } from "../../../../tests/ui/dom";

import { ChatInputDecoration } from "./ChatInputDecoration";
import {
  ChatActivityPanelsProvider,
  useChatActivityPanel,
  type ChatActivityId,
} from "./chatActivityPanels";

let cleanupDom: (() => void) | null = null;

function Chip(props: {
  id: ChatActivityId;
  label: string;
  onContentKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  const [expanded, setExpanded] = useChatActivityPanel(props.id);
  return (
    <ChatInputDecoration
      activityId={props.id}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
      chipLabel={props.label}
      summary={props.label}
      onContentKeyDown={props.onContentKeyDown}
      renderExpanded={() => <button type="button">{props.label} list</button>}
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

  it("ignores keys other than Escape", () => {
    const view = render(renderLine());

    fireEvent.click(view.getByRole("button", { name: "TODO" }));
    fireEvent.keyDown(view.getByText("TODO list"), { key: "Enter" });

    expect(view.queryByText("TODO list")).not.toBeNull();
  });

  it("leaves Escape to a list that handles it itself", () => {
    // The background bash list closes itself on Escape and moves focus; closing again would reopen.
    let listSawEscape = false;
    const view = render(
      <ChatActivityPanelsProvider>
        <Chip
          id="background-bashes"
          label="Bashes"
          onContentKeyDown={(event) => {
            if (event.key !== "Escape") return;
            listSawEscape = true;
            event.preventDefault();
          }}
        />
      </ChatActivityPanelsProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Bashes" }));
    fireEvent.keyDown(view.getByText("Bashes list"), { key: "Escape" });

    expect(listSawEscape).toBe(true);
    expect(view.queryByText("Bashes list")).not.toBeNull();
  });

  it("keeps the inline row outside the live line", () => {
    // Hosts without the line (the VS Code webview's tray) show the list in the row, when expanded.
    function Row(props: { expanded: boolean }) {
      return (
        <ChatInputDecoration
          expanded={props.expanded}
          onToggle={() => undefined}
          summary="TODO"
          renderExpanded={() => <p>TODO list</p>}
        />
      );
    }
    const view = render(<Row expanded={false} />);
    expect(view.container.querySelector("[data-activity-chip]")).toBeNull();
    expect(view.queryByText("TODO list")).toBeNull();

    view.rerender(<Row expanded />);
    expect(view.queryByText("TODO list")).not.toBeNull();
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
