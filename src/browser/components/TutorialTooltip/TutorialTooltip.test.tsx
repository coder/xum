import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { TutorialTooltip } from "./TutorialTooltip";

describe("TutorialTooltip", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  // Before the bubble opens, focus is on a header button by default: a control the user clicked.
  function renderTooltip(focusBefore: "button" | "composer" | "menu item" = "button") {
    const onNext = mock(() => undefined);
    const onDismiss = mock(() => undefined);
    const onDisableTutorial = mock(() => undefined);
    const tree = (showTooltip: boolean) => (
      <>
        <div data-tutorial="target">Target</div>
        <button type="button">Header button</button>
        <textarea aria-label="Composer" />
        <div role="menu">
          <button type="button" role="menuitem">
            Archive
          </button>
        </div>
        {showTooltip && (
          <TutorialTooltip
            step={{ target: "target", title: "Step title", content: "Step content" }}
            currentStep={1}
            totalSteps={3}
            onNext={onNext}
            onDismiss={onDismiss}
            onDisableTutorial={onDisableTutorial}
          />
        )}
      </>
    );
    // The tooltip portals into document.body, which is render()'s default query root.
    const view = render(tree(false));
    const focusTargets = {
      button: () => view.getByRole("button", { name: "Header button" }),
      composer: () => view.getByRole("textbox", { name: "Composer" }),
      "menu item": () => view.getByRole("menuitem", { name: "Archive" }),
    };
    focusTargets[focusBefore]().focus();
    view.rerender(tree(true));
    const close = () => view.rerender(tree(false));
    return { view, close, onNext, onDismiss, onDisableTutorial };
  }

  test("Skip dismisses this tutorial on the first click", () => {
    const { view, onDismiss, onDisableTutorial } = renderTooltip();

    fireEvent.click(view.getByRole("button", { name: "Skip" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDisableTutorial).not.toHaveBeenCalled();
  });

  test("the opt-out is a separate control that disables all tutorials", () => {
    const { view, onDismiss, onDisableTutorial } = renderTooltip();

    // Both controls are offered at once, so Skip never turns into the opt-out.
    expect(view.getByRole("button", { name: "Skip" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Don't show tutorials again" }));

    expect(onDisableTutorial).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test("the bubble takes focus when it opens, and Escape there skips this tutorial", () => {
    const { view, onDismiss, onDisableTutorial } = renderTooltip();

    const bubble = view.getByRole("group", { name: "Step title" });
    expect(document.activeElement).toBe(bubble);
    fireEvent.keyDown(bubble, { key: "Escape" });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDisableTutorial).not.toHaveBeenCalled();
  });

  test("Escape on the bubble does not reach window listeners such as the stream interrupt", () => {
    const { view } = renderTooltip();
    const windowListener = mock((_event: KeyboardEvent) => undefined);
    window.addEventListener("keydown", windowListener);

    try {
      fireEvent.keyDown(view.getByRole("button", { name: "Next" }), { key: "Escape" });
      expect(windowListener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", windowListener);
    }
  });

  test("an Escape that a layer above already handled does not skip the tutorial", () => {
    const { view, onDismiss } = renderTooltip();
    // Radix closes an open popover, menu or dialog in the document capture phase and marks the
    // event with preventDefault.
    const otherLayer = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", otherLayer, { capture: true });

    try {
      fireEvent.keyDown(view.getByRole("group", { name: "Step title" }), { key: "Escape" });
      expect(onDismiss).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", otherLayer, { capture: true });
    }
  });

  test("closing the bubble returns focus to where it was", () => {
    const { view, close } = renderTooltip();
    expect(document.activeElement).toBe(view.getByRole("group", { name: "Step title" }));

    close();

    expect(document.activeElement).toBe(view.getByRole("button", { name: "Header button" }));
  });

  test("the bubble leaves focus in a composer the user is typing in (#7114)", () => {
    const { view, close } = renderTooltip("composer");
    const composer = view.getByRole("textbox", { name: "Composer" });

    expect(document.activeElement).toBe(composer);
    close();
    expect(document.activeElement).toBe(composer);
  });

  test("after a click in the bubble, closing it returns focus to the composer (#7114)", () => {
    const { view, close } = renderTooltip("composer");
    // A click on Skip moves focus from the composer into the bubble before the bubble closes.
    view.getByRole("button", { name: "Skip" }).focus();

    close();

    expect(document.activeElement).toBe(view.getByRole("textbox", { name: "Composer" }));
  });

  test("the bubble does not take focus while a full-screen layer covers it (#7114)", () => {
    // The full-screen Artifacts and App View panels (z-1500) draw over the bubble. Layout is not
    // computed here, so the browser's hit test is stubbed to report that panel on top.
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    const hitTest = spyOn(document, "elementFromPoint").mockReturnValue(panel);

    try {
      const { view } = renderTooltip();
      expect(document.activeElement).toBe(view.getByRole("button", { name: "Header button" }));
    } finally {
      hitTest.mockRestore();
      panel.remove();
    }
  });

  test("the bubble leaves focus in an open menu, so the menu stays open (#7452)", () => {
    const { view } = renderTooltip("menu item");

    expect(document.activeElement).toBe(view.getByRole("menuitem", { name: "Archive" }));
  });

  /** Stubs the hit test: a full-screen panel covers the bubble until `uncover()` (#7114). */
  function coverBubble() {
    const panel = document.createElement("button");
    panel.textContent = "Full-screen panel";
    document.body.appendChild(panel);
    const hitTest = spyOn(document, "elementFromPoint").mockReturnValue(panel);
    return {
      panel,
      // No layout here: a null hit counts as uncovered.
      uncover: () => hitTest.mockReturnValue(null),
      restore: () => {
        hitTest.mockRestore();
        panel.remove();
      },
    };
  }

  test("a covered bubble takes focus when the panel moves focus back after it unpins (#7198)", () => {
    const cover = coverBubble();
    try {
      const { view, close } = renderTooltip();
      const bubble = view.getByRole("group", { name: "Step title" });
      // A focus move while the panel still covers the bubble leaves focus alone.
      cover.panel.focus();
      expect(document.activeElement).toBe(cover.panel);

      view.getByRole("button", { name: "Header button" }).focus();
      cover.uncover();
      cover.panel.focus();
      expect(document.activeElement).toBe(bubble);

      close();
      expect(document.activeElement).toBe(cover.panel);
    } finally {
      cover.restore();
    }
  });

  test("an uncovered bubble still leaves focus in the composer (#7198, #7120)", () => {
    const cover = coverBubble();
    try {
      const { view } = renderTooltip();
      const composer = view.getByRole("textbox", { name: "Composer" });
      cover.uncover();
      composer.focus();
      expect(document.activeElement).toBe(composer);
    } finally {
      cover.restore();
    }
  });

  test("Tab from the composer reaches the bubble, and Shift+Tab goes back (#7198)", () => {
    const { view } = renderTooltip("composer");
    const composer = view.getByRole("textbox", { name: "Composer" });
    const bubble = view.getByRole("group", { name: "Step title" });

    fireEvent.keyDown(composer, { key: "Tab" });
    expect(document.activeElement).toBe(bubble);
    fireEvent.keyDown(bubble, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(composer);

    // Shift+Tab from Skip, the bubble's first button, also goes back.
    const skip = view.getByRole("button", { name: "Skip" });
    skip.focus();
    fireEvent.keyDown(skip, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(composer);
  });

  test("a Tab that the composer's suggestion list took stays in the composer (#7198)", () => {
    const { view } = renderTooltip("composer");
    const composer = view.getByRole("textbox", { name: "Composer" });
    const suggestions = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", suggestions);

    try {
      fireEvent.keyDown(composer, { key: "Tab" });
      expect(document.activeElement).toBe(composer);
    } finally {
      document.removeEventListener("keydown", suggestions);
    }
  });

  test("closing the bubble removes its focus and Tab listeners (#7198)", () => {
    const spies = [window, document].flatMap((target) => [
      spyOn(target, "addEventListener"),
      spyOn(target, "removeEventListener"),
    ]);
    const listeners = (index: number) =>
      [spies[index], spies[index + 2]]
        .flatMap((spy) => spy.mock.calls)
        .filter(([type]) => type === "keydown" || type === "focusin")
        .map(([, listener]) => listener);
    const cover = coverBubble();
    try {
      // A covered bubble adds the focusin listener, a bubble beside the composer the Tab one.
      renderTooltip().close();
      cleanup();
      cover.uncover();
      renderTooltip("composer").close();

      expect(listeners(0)).toHaveLength(2);
      expect(listeners(0).filter((listener) => !listeners(1).includes(listener))).toEqual([]);
    } finally {
      cover.restore();
      for (const spy of spies) spy.mockRestore();
    }
  });
});
