import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type React from "react";
import { installDom, stubNarrowViewport, stubShortViewport } from "../../../../tests/ui/dom";

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

  it("opens the panels in the sheet on a short viewport, such as a phone in landscape", () => {
    // A popover above the line would run off the top of a screen this short.
    stubShortViewport(true);
    const view = render(renderLine());

    fireEvent.click(view.getByRole("button", { name: "TODO" }));
    const sheet = view.getByRole("dialog", { name: "Activity" });
    expect(within(sheet).queryByText("TODO list")).not.toBeNull();
  });

  describe("on a phone-width viewport", () => {
    beforeEach(() => {
      stubNarrowViewport(true);
    });

    it("opens every panel in one sheet, with a tab per chip", () => {
      const view = render(renderLine());
      expect(view.queryByRole("dialog")).toBeNull();

      fireEvent.click(view.getByRole("button", { name: "TODO" }));
      const sheet = view.getByRole("dialog", { name: "Activity" });
      expect(within(sheet).queryByText("TODO list")).not.toBeNull();
      const tabs = within(sheet).getAllByRole("tab");
      expect(tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([
        ["TODO", "true"],
        ["Bashes", "false"],
      ]);

      // A tab reaches a list whose chip the strip may have scrolled out of view.
      fireEvent.click(within(sheet).getByRole("tab", { name: "Bashes" }));
      expect(within(sheet).queryByText("Bashes list")).not.toBeNull();
      expect(view.queryByText("TODO list")).toBeNull();
      expect(view.getByRole("button", { name: "Bashes" }).getAttribute("aria-expanded")).toBe(
        "true"
      );
    });

    it("takes focus while open and returns it to the chip on Escape", () => {
      const view = render(renderLine());
      const chip = view.getByRole("button", { name: "TODO" });
      chip.focus();

      fireEvent.click(chip);
      const sheet = view.getByRole("dialog", { name: "Activity" });
      expect(sheet.contains(document.activeElement)).toBe(true);

      fireEvent.keyDown(sheet, { key: "Escape" });
      expect(view.queryByRole("dialog")).toBeNull();
      expect(view.queryByText("TODO list")).toBeNull();
      expect(document.activeElement).toBe(chip);
    });

    it("closes on Escape from a tab without reaching window handlers", () => {
      // The tabs portal in from their chips, so their key events skip the sheet's React tree;
      // the window's Escape handler interrupts the stream.
      const view = render(renderLine());
      let windowSawEscape = false;
      const onWindowKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") windowSawEscape = true;
      };
      window.addEventListener("keydown", onWindowKeyDown);

      fireEvent.click(view.getByRole("button", { name: "TODO" }));
      const sheet = view.getByRole("dialog", { name: "Activity" });
      fireEvent.keyDown(within(sheet).getByRole("tab", { name: "Bashes" }), { key: "Escape" });
      window.removeEventListener("keydown", onWindowKeyDown);

      expect(view.queryByRole("dialog")).toBeNull();
      expect(windowSawEscape).toBe(false);
    });

    it("leaves Escape to a list in the sheet that handles it itself", () => {
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
      expect(view.queryByRole("dialog", { name: "Activity" })).not.toBeNull();
    });

    it("stays open on a press inside it and closes from its Close button", () => {
      const view = render(renderLine());

      fireEvent.click(view.getByRole("button", { name: "TODO" }));
      fireEvent.pointerDown(view.getByText("TODO list"));
      const sheet = view.getByRole("dialog", { name: "Activity" });
      expect(within(sheet).queryByText("TODO list")).not.toBeNull();

      fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
      expect(view.queryByRole("dialog")).toBeNull();
      expect(view.getByRole("button", { name: "TODO" }).getAttribute("aria-expanded")).toBe(
        "false"
      );
    });
  });
});
