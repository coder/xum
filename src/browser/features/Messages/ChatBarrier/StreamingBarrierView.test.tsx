import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../../tests/ui/domGlobals";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { StreamingBarrierView } from "./StreamingBarrierView";

describe("StreamingBarrierView", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("renders stop button when onCancel is provided", () => {
    const onCancel = mock(() => undefined);

    const view = render(
      <StreamingBarrierView
        statusText="streaming..."
        cancelText="hit Esc to cancel"
        cancelShortcutText="Esc"
        onCancel={onCancel}
      />
    );

    const stopButton = view.getByRole("button", { name: "Stop streaming" });
    expect(stopButton.textContent).toContain("Stop");
    expect(stopButton.textContent).toContain("Esc");
    expect(stopButton.getAttribute("title")).toBeNull();

    fireEvent.click(stopButton);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("does not render shortcut badge when cancelShortcutText is omitted", () => {
    const onCancel = mock(() => undefined);
    const view = render(
      <StreamingBarrierView
        statusText="streaming..."
        cancelText="hit Esc to cancel"
        onCancel={onCancel}
      />
    );

    const stopButton = view.getByRole("button", { name: "Stop streaming" });
    expect(stopButton.textContent).toContain("Stop");
    expect(stopButton.textContent).not.toContain("Esc");
  });

  test("renders cancel hint as plain text when onCancel is omitted", () => {
    const view = render(
      <StreamingBarrierView statusText="streaming..." cancelText="hit Esc to cancel" />
    );

    expect(view.getByText("hit Esc to cancel")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Stop streaming" })).toBeNull();
  });

  // The token-stats slot must stay mounted across the starting -> streaming
  // transition (only its visibility toggles), otherwise mounting it on transition
  // reflows the row -> a layout flash. These two cases assert the slot is present
  // in both phases and is merely hidden when no stats are available yet.
  test("reserves the stats slot but hides it when token count is unavailable (starting)", () => {
    const view = render(
      <StreamingBarrierView statusText="starting..." cancelText="hit Esc to cancel" />
    );

    const stats = view.getByTestId("streaming-barrier-stats");
    expect(stats.className).toContain("invisible");
    expect(stats.getAttribute("aria-hidden")).toBe("true");
  });

  test("reveals the same stats slot with values once streaming", () => {
    const view = render(
      <StreamingBarrierView
        statusText="streaming..."
        cancelText="hit Esc to cancel"
        tokenCount={1234}
        tps={45}
      />
    );

    const stats = view.getByTestId("streaming-barrier-stats");
    expect(stats.className).not.toContain("invisible");
    expect(stats.getAttribute("aria-hidden")).toBe("false");
    expect(stats.textContent).toContain("1,234");
    expect(stats.textContent).toContain("45");
  });
});
