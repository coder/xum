import "../../../../tests/ui/dom";

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { LazySettingsModal } from "./LazySettingsModal";

// A lazy modal whose chunk never arrives, so the loading dialog stays up.
const NeverLoads = React.lazy(() => new Promise<{ default: React.FC }>(() => undefined));

describe("LazySettingsModal", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  it("keeps keyboard focus off the menu trigger while the modal loads", async () => {
    // Codex #6983: the trigger got focus back while the chunk loaded, so Enter reopened the menu
    // and a second pick mounted a second modal.
    function Bar() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Workspace actions</button>
          <LazySettingsModal name="Heartbeat settings" open={open} onClose={() => setOpen(false)}>
            <NeverLoads />
          </LazySettingsModal>
        </>
      );
    }
    const view = render(<Bar />);
    const trigger = view.getByRole("button", { name: "Workspace actions" });
    trigger.focus();
    fireEvent.click(trigger);
    // Radix moves focus into the loading dialog on the next frame.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    const dialog = view.getByRole("dialog", { name: "Heartbeat settings" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Focus that moves back to the trigger (the menu's close does this) is pulled back in.
    trigger.focus();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
