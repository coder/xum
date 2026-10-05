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
    // The tooltip portals into document.body, which is render()'s default query root.
    const view = render(
      <>
        <div data-tutorial="target">Target</div>
        <TutorialTooltip
          step={{ target: "target", title: "Step title", content: "Step content" }}
          currentStep={1}
          totalSteps={3}
          onNext={onNext}
          onDismiss={onDismiss}
          onDisableTutorial={onDisableTutorial}
        />
      </>
    );
    return { view, onNext, onDismiss, onDisableTutorial };
  }

  test("Skip dismisses this tutorial on the first click", () => {
    const { view, onDismiss, onDisableTutorial } = renderTooltip();

    fireEvent.click(view.getByRole("button", { name: "Skip" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDisableTutorial).not.toHaveBeenCalled();
  });

  test("Escape dismisses the tutorial without reaching the global stream-interrupt handler", () => {
    // Stands in for useAIViewKeybinds' bubble-phase window listener, which interrupts a
    // running stream on Escape.
    const globalEscape = mock((_e: KeyboardEvent) => undefined);
    window.addEventListener("keydown", globalEscape);
    try {
      const { onDismiss, onDisableTutorial } = renderTooltip();

      // Focus stays outside the portaled tooltip, as it does in the app.
      fireEvent.keyDown(document.body, { key: "Escape" });

      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onDisableTutorial).not.toHaveBeenCalled();
      expect(globalEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", globalEscape);
    }
  });

  test("the opt-out is a separate control that disables all tutorials", () => {
    const { view, onDismiss, onDisableTutorial } = renderTooltip();

    // Both controls are offered at once, so Skip never turns into the opt-out.
    expect(view.getByRole("button", { name: "Skip" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Don't show tutorials again" }));

    expect(onDisableTutorial).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
