import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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

  function renderTooltip() {
    const onNext = mock(() => undefined);
    const onDismiss = mock(() => undefined);
    const onDisableTutorial = mock(() => undefined);
    const tree = (showTooltip: boolean) => (
      <>
        <div data-tutorial="target">Target</div>
        <textarea aria-label="Composer" />
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
    view.getByRole("textbox", { name: "Composer" }).focus();
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

    expect(document.activeElement).toBe(view.getByRole("textbox", { name: "Composer" }));
  });
});
