import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { installDom, stubNarrowViewport } from "../../../../tests/ui/dom";
import { KEYBINDS, type Keybind } from "@/browser/utils/ui/keybinds";

import { ChatActivityOverflowChip, ChatInputDecoration } from "./ChatInputDecoration";
import {
  ChatActivityPanelsProvider,
  measureChipOverflow,
  useChatActivityPanel,
  type ChatActivityId,
} from "./chatActivityPanels";

let cleanupDom: (() => void) | null = null;

beforeEach(() => {
  cleanupDom = installDom();
});

afterEach(() => {
  cleanup();
  cleanupDom?.();
  cleanupDom = null;
});

function rect(width: number): DOMRect {
  return {
    width,
    height: 0,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: 0,
    toJSON: () => ({}),
  };
}

/** happy-dom has no layout: give each element the width the test needs. */
function setWidth(element: HTMLElement, width: number): void {
  element.getBoundingClientRect = () => rect(width);
}

describe("measureChipOverflow", () => {
  function strip(width: number, chips: Array<{ id: ChatActivityId; width: number; plain?: true }>) {
    const element = document.createElement("div");
    Object.defineProperty(element, "clientWidth", { value: width });
    for (const chip of chips) {
      const button = document.createElement("button");
      button.dataset.activityChip = "";
      button.dataset.activityId = chip.id;
      if (chip.plain) button.dataset.chipVariant = "plain";
      setWidth(button, chip.width);
      element.append(button);
    }
    const more = document.createElement("button");
    more.dataset.activityOverflowChip = "";
    setWidth(more, 40);
    element.append(more);
    return element;
  }

  it("hides nothing while every chip fits", () => {
    const element = strip(300, [
      { id: "todo", width: 100, plain: true },
      { id: "sub-agents", width: 60 },
      { id: "reviews", width: 60 },
    ]);
    expect(measureChipOverflow(element)).toEqual([]);
  });

  it("hides chips from the end of the line, leaving room for the +N chip", () => {
    // 100 (TODO) + 3 × 60 = 280 does not fit 270; without Reviews, 100 + 2 × 60 + 40 (+N) does.
    const element = strip(270, [
      { id: "reviews", width: 60 },
      { id: "todo", width: 100, plain: true },
      { id: "sub-agents", width: 60 },
      { id: "background-bashes", width: 60 },
    ]);
    expect(measureChipOverflow(element)).toEqual(["reviews"]);
  });

  it("lets the TODO chip shrink to its reserve before a chip hides", () => {
    // The plain chip's step text is cut off (natural width 380), so it can yield down to its reserve.
    const element = strip(250, [
      { id: "todo", width: 200, plain: true },
      { id: "sub-agents", width: 60 },
      { id: "background-bashes", width: 60 },
    ]);
    const text = document.createElement("span");
    text.dataset.chipTruncates = "";
    Object.defineProperty(text, "scrollWidth", { value: 200 });
    Object.defineProperty(text, "clientWidth", { value: 20 });
    element.querySelector("[data-chip-variant]")?.append(text);
    // The reserve (104) and the two chips (120) fit 250; at its current width (200) they would not.
    expect(measureChipOverflow(element)).toEqual([]);
  });

  it("leaves out the spacer's gap without a TODO chip, which hides the spacer", () => {
    // Four 60px chips and their three 6px gaps fit 260; a gap for the spacer would make it 264.
    const element = strip(260, [
      { id: "sub-agents", width: 60 },
      { id: "background-bashes", width: 60 },
      { id: "reviews", width: 60 },
      { id: "chat-instructions", width: 60 },
    ]);
    element.style.columnGap = "6px";
    document.body.append(element);
    expect(measureChipOverflow(element)).toEqual([]);
  });
});

function Chip(props: { id: ChatActivityId; label: string; panelKeybind?: Keybind }) {
  const [expanded, setExpanded] = useChatActivityPanel(props.id);
  return (
    <ChatInputDecoration
      activityId={props.id}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
      chipLabel={props.label}
      summary={props.label}
      panelTitle={props.label}
      panelKeybind={props.panelKeybind}
      tab={<span>{`${props.label} tab`}</span>}
      renderExpanded={() => <button type="button">{`${props.label} row`}</button>}
    />
  );
}

/** A line whose strip has room for `room` px of bordered chips (60 px each, +N 40 px). */
function stubLayout(room: number): void {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.hasAttribute("data-activity-chip")) return rect(60);
    if (this.hasAttribute("data-activity-overflow-chip")) return rect(40);
    return rect(0);
  };
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-activity-strip") ? room : 0;
    },
  });
}

/**
 * `streaming` adds Stop to the line, a change in the line that makes it measure its chips again.
 * `bashes={false}` drops the Bashes chip, as its last bash exiting does.
 */
function Line(props: { streaming?: boolean; bashes?: boolean }) {
  return (
    <div>
      <ChatActivityPanelsProvider>
        <div data-activity-strip="">
          <Chip id="sub-agents" label="Agents" panelKeybind={KEYBINDS.OPEN_SUB_AGENTS_PANEL} />
          {props.bashes !== false && <Chip id="background-bashes" label="Bashes" />}
          <Chip id="reviews" label="Reviews" panelKeybind={KEYBINDS.OPEN_REVIEWS_PANEL} />
          <ChatActivityOverflowChip />
        </div>
        {props.streaming === true && <button type="button">Stop</button>}
      </ChatActivityPanelsProvider>
      <button type="button">composer</button>
    </div>
  );
}

async function rerenderLine(view: ReturnType<typeof render>, room: number, streaming: boolean) {
  stubLayout(room);
  view.rerender(<Line streaming={streaming} />);
  // The line measures its chips again from a MutationObserver callback.
  await act(async () => {
    await Promise.resolve();
  });
}

describe("the +N chip", () => {
  it("stays out of sight while every chip fits", () => {
    stubLayout(400);
    const view = render(<Line />);
    const more = view.getByRole("button", { name: "0 more" });
    expect(more.className).toContain("invisible");
    expect(view.getByRole("button", { name: "Reviews" }).className).not.toContain("invisible");
  });

  it("lists the chips the line has no room for and opens their panels", () => {
    // Two chips and the +N chip (2 × 60 + 40 + gaps) fit 170; three chips do not.
    stubLayout(170);
    const view = render(<Line />);
    const more = view.getByRole("button", { name: "1 more" });
    expect(view.getByRole("button", { name: "Reviews" }).className).toContain("invisible");

    fireEvent.click(more);
    const list = view.getByRole("group", { name: "More activity" });
    expect(
      within(list)
        .getAllByRole("button")
        .map((entry) => entry.textContent)
    ).toEqual(["Reviews tab"]);

    fireEvent.click(within(list).getByRole("button", { name: "Reviews tab" }));
    expect(view.queryByRole("group", { name: "More activity" })).toBeNull();
    const panel = view.getByRole("group", { name: "Reviews" });
    // Focus moves into the panel: it comes before the +N chip, so Tab from there would skip it.
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Reviews row" }));
    // The hidden chip's panel keeps the +N chip lit, and closing it returns focus there.
    expect(more.querySelector("span")?.className).toContain("color-exec-mode");
    fireEvent.keyDown(within(panel).getByText("Reviews row"), { key: "Escape" });
    expect(view.queryByRole("group", { name: "Reviews" })).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  // A hidden chip cannot keep focus: the browser would drop it to the page.
  it("takes focus from a chip that hides, and hands it to that chip once it shows again", async () => {
    stubLayout(400);
    const view = render(<Line />);
    const bashes = view.getByRole("button", { name: "Bashes" });
    bashes.focus();

    // A turn starts: Stop takes room, and Bashes moves into the +N chip.
    await rerenderLine(view, 110, true);
    expect(bashes.className).toContain("invisible");
    const more = view.getByRole("button", { name: "2 more" });
    expect(document.activeElement).toBe(more);

    // The turn ends: every chip fits again, and the +N chip hides.
    await rerenderLine(view, 400, false);
    expect(more.className).toContain("invisible");
    expect(document.activeElement).toBe(bashes);
  });

  it("closes its list on Escape and keeps focus on itself", () => {
    stubLayout(170);
    const view = render(<Line />);
    const more = view.getByRole("button", { name: "1 more" });
    fireEvent.click(more);
    fireEvent.keyDown(view.getByRole("group", { name: "More activity" }), { key: "Escape" });
    expect(view.queryByRole("group", { name: "More activity" })).toBeNull();
    expect(document.activeElement).toBe(more);
  });
});

// The line changes while the phone sheet is open: closing the sheet returns focus to the chip
// that opened it only while the line shows that chip (a hidden chip cannot take focus).
describe("the phone sheet", () => {
  beforeEach(() => {
    stubNarrowViewport(true);
  });

  it("returns focus to the +N chip once the chip that opened it has moved there", async () => {
    stubLayout(400);
    const view = render(<Line />);
    const bashes = view.getByRole("button", { name: "Bashes" });
    bashes.focus();
    fireEvent.click(bashes);
    const sheet = view.getByRole("dialog", { name: "Activity" });

    // A turn starts: Stop takes room, and the line has room for one chip and the +N chip.
    await rerenderLine(view, 110, true);
    expect(bashes.className).toContain("invisible");
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(view.queryByRole("dialog", { name: "Activity" })).toBeNull();
    expect(document.activeElement).toBe(view.getByRole("button", { name: "2 more" }));
  });

  it("returns focus to the chip it showed once the +N chip that opened it has hidden", async () => {
    stubLayout(110);
    const view = render(<Line streaming />);
    const more = view.getByRole("button", { name: "2 more" });
    fireEvent.click(more);
    const list = view.getByRole("group", { name: "More activity" });
    fireEvent.click(within(list).getByRole("button", { name: "Bashes tab" }));
    const sheet = view.getByRole("dialog", { name: "Activity" });

    // The turn ends: every chip fits again, so the +N chip hides.
    await rerenderLine(view, 400, false);
    expect(more.className).toContain("invisible");
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Bashes" }));
  });

  it("returns focus to the +N chip that opened it while the chip it lists stays hidden", () => {
    stubLayout(110);
    const view = render(<Line streaming />);
    const more = view.getByRole("button", { name: "2 more" });
    fireEvent.click(more);
    const list = view.getByRole("group", { name: "More activity" });
    fireEvent.click(within(list).getByRole("button", { name: "Bashes tab" }));
    fireEvent.keyDown(view.getByRole("dialog", { name: "Activity" }), { key: "Escape" });
    expect(document.activeElement).toBe(more);
  });

  it("returns focus to a chip the line shows once the chip that opened it has left", () => {
    stubLayout(400);
    const view = render(<Line />);
    const bashes = view.getByRole("button", { name: "Bashes" });
    bashes.focus();
    fireEvent.click(bashes);
    view.getByRole("dialog", { name: "Activity" });

    // The last bash exits: its chip leaves, which closes the sheet.
    view.rerender(<Line bashes={false} />);
    expect(view.queryByRole("dialog", { name: "Activity" })).toBeNull();
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Agents" }));
  });

  it("returns focus to a chip that opened it and is still shown", () => {
    stubLayout(400);
    const view = render(<Line />);
    const reviews = view.getByRole("button", { name: "Reviews" });
    reviews.focus();
    fireEvent.click(reviews);
    // The sheet's tab switches its panel; the chip that opened the sheet takes focus back.
    fireEvent.click(view.getByRole("tab", { name: "Agents tab" }));
    fireEvent.keyDown(view.getByRole("dialog", { name: "Activity" }), { key: "Escape" });
    expect(document.activeElement).toBe(reviews);
  });
});

describe("panel shortcuts", () => {
  let altGraph = false;
  beforeEach(() => {
    // happy-dom reports AltGraph for every Ctrl+Alt event; a real keyboard does only for AltGr.
    altGraph = false;
    // The keybind matcher queries only AltGraph; the event's own flags carry the other modifiers.
    window.KeyboardEvent.prototype.getModifierState = (key) => key === "AltGraph" && altGraph;
  });

  const chord = (target: Element, keybind: Keybind) =>
    fireEvent.keyDown(target, {
      key: keybind.key,
      code: keybind.code,
      ctrlKey: true,
      altKey: true,
    });

  it("open the panel from the composer, focus it, and close it again", () => {
    stubLayout(400);
    const view = render(<Line />);
    const composer = view.getByRole("button", { name: "composer" });
    composer.focus();

    chord(composer, KEYBINDS.OPEN_REVIEWS_PANEL);
    const row = view.getByRole("button", { name: "Reviews row" });
    expect(document.activeElement).toBe(row);
    expect(view.getByRole("button", { name: "Reviews" }).getAttribute("aria-keyshortcuts")).toBe(
      "Control+Alt+R"
    );

    chord(row, KEYBINDS.OPEN_REVIEWS_PANEL);
    expect(view.queryByRole("group", { name: "Reviews" })).toBeNull();
    expect(document.activeElement).toBe(composer);
  });

  it("bring focus back into a panel left open, then close it from there", () => {
    stubLayout(400);
    const view = render(<Line />);
    const composer = view.getByRole("button", { name: "composer" });
    composer.focus();
    chord(composer, KEYBINDS.OPEN_REVIEWS_PANEL);
    // Tab back to the composer: the non-modal panel stays open.
    composer.focus();

    chord(composer, KEYBINDS.OPEN_REVIEWS_PANEL);
    const row = view.getByRole("button", { name: "Reviews row" });
    expect(document.activeElement).toBe(row);

    chord(row, KEYBINDS.OPEN_REVIEWS_PANEL);
    expect(view.queryByRole("group", { name: "Reviews" })).toBeNull();
    expect(document.activeElement).toBe(composer);
  });

  it("return focus to where it was when Escape closes the panel", () => {
    stubLayout(400);
    const view = render(<Line />);
    const composer = view.getByRole("button", { name: "composer" });
    composer.focus();
    chord(composer, KEYBINDS.OPEN_SUB_AGENTS_PANEL);
    fireEvent.keyDown(view.getByRole("button", { name: "Agents row" }), { key: "Escape" });
    expect(view.queryByRole("group", { name: "Agents" })).toBeNull();
    expect(document.activeElement).toBe(composer);
  });

  it("swap panels, and stay quiet while a dialog is open", () => {
    stubLayout(400);
    const view = render(<Line />);
    const composer = view.getByRole("button", { name: "composer" });
    composer.focus();
    chord(composer, KEYBINDS.OPEN_SUB_AGENTS_PANEL);
    chord(document.activeElement ?? composer, KEYBINDS.OPEN_REVIEWS_PANEL);
    expect(view.queryByRole("group", { name: "Agents" })).toBeNull();
    expect(view.queryByRole("group", { name: "Reviews" })).not.toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Reviews" }));

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    chord(composer, KEYBINDS.OPEN_SUB_AGENTS_PANEL);
    expect(view.queryByRole("group", { name: "Agents" })).toBeNull();
  });

  // There the panels open in the sheet: a modal over the page, chips included.
  it("swap and close the panels of the phone sheet from inside it", () => {
    stubNarrowViewport(true);
    stubLayout(400);
    const view = render(<Line />);
    const composer = view.getByRole("button", { name: "composer" });
    composer.focus();
    chord(composer, KEYBINDS.OPEN_REVIEWS_PANEL);
    const sheet = view.getByRole("dialog", { name: "Activity" });
    const reviewsRow = within(sheet).getByRole("button", { name: "Reviews row" });
    expect(document.activeElement).toBe(reviewsRow);

    chord(reviewsRow, KEYBINDS.OPEN_SUB_AGENTS_PANEL);
    const agentsRow = within(sheet).getByRole("button", { name: "Agents row" });
    expect(document.activeElement).toBe(agentsRow);

    chord(agentsRow, KEYBINDS.OPEN_SUB_AGENTS_PANEL);
    expect(view.queryByRole("dialog", { name: "Activity" })).toBeNull();
    expect(document.activeElement).toBe(composer);
  });

  it("leave the chord to a browser or desktop viewport that has focus", () => {
    stubLayout(400);
    const view = render(<Line />);
    for (const attr of ["data-browser-viewport", "data-desktop-viewport"]) {
      const viewport = document.createElement("div");
      viewport.setAttribute(attr, "");
      viewport.tabIndex = 0;
      document.body.append(viewport);
      viewport.focus();
      chord(viewport, KEYBINDS.OPEN_REVIEWS_PANEL);
      expect(view.queryByRole("group", { name: "Reviews" })).toBeNull();
      viewport.remove();
    }
  });

  it("leave AltGr typing alone, which some layouts report as Ctrl+Alt", () => {
    stubLayout(400);
    const view = render(<Line />);
    altGraph = true;
    chord(view.getByRole("button", { name: "composer" }), KEYBINDS.OPEN_REVIEWS_PANEL);
    expect(view.queryByRole("group", { name: "Reviews" })).toBeNull();
  });

  it("ignore a chip without a shortcut", () => {
    stubLayout(400);
    const view = render(<Line />);
    const composer = view.getByRole("button", { name: "composer" });
    chord(composer, KEYBINDS.OPEN_TODO_PANEL);
    expect(view.queryByRole("group")).toBeNull();
  });
});
