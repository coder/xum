import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import {
  CommandRegistryProvider,
  useCommandRegistry,
  type CommandAction,
} from "@/browser/contexts/CommandRegistryContext";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { isCommandPaletteTarget } from "@/browser/utils/ui/keybinds";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
// The palette as App.tsx mounts it.
import { LazyCommandPalette as AppCommandPalette } from "./LazyCommandPalette";

// #6997: the first open after page load must behave like every later open, for both palette
// shortcuts (App's keydown handler calls `open()` or `open(">")`).
function Harness(props: { action: CommandAction }) {
  const registry = useCommandRegistry();
  const { registerSource } = registry;
  React.useEffect(() => registerSource(() => [props.action]), [props.action, registerSource]);
  return (
    <>
      <button type="button" onClick={() => registry.open()}>
        Open palette
      </button>
      <button type="button" onClick={() => registry.open(">")}>
        Open actions
      </button>
      <AppCommandPalette />
    </>
  );
}

function renderApp(action: CommandAction) {
  return render(
    <APIProvider client={createMockORPCClient()}>
      <CommandRegistryProvider>
        <Harness action={action} />
      </CommandRegistryProvider>
    </APIProvider>
  );
}

describe("command palette first open", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  // Must stay the first test that opens the palette: React.lazy keeps the loaded module for the
  // rest of the file, so only this test sees the loading input. No await before the reopen, so
  // the chunk is still pending throughout.
  test("while the chunk loads: palette target, and close + reopen recaptures focus", async () => {
    const view = renderApp({ id: "test:pick", title: "Pick me", section: "Tests", run: mock() });
    const first = view.getByRole("button", { name: "Open palette" });
    const second = view.getByRole("button", { name: "Open actions" });
    first.focus();
    fireEvent.click(first);
    const loading = document.activeElement;
    expect(loading?.getAttribute("role")).not.toBe("combobox");
    // Focus-moving shortcuts that work in inputs (Ctrl+I) skip palette targets.
    expect(isCommandPaletteTarget(loading)).toBe(true);
    fireEvent.keyDown(loading!, { key: "Escape" });
    expect(document.activeElement).toBe(first);

    second.focus();
    fireEvent.click(second);
    await userEvent.setup({ document: view.container.ownerDocument }).keyboard("Pick");
    const input = await view.findByRole("combobox");
    expect((input as HTMLInputElement).value).toBe(">Pick");
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("combobox") === null).toBe(true));
    expect(document.activeElement).toBe(second);
  });

  test("a command runs through EXECUTE_COMMAND before the palette was ever opened", async () => {
    const run = mock();
    const view = renderApp({ id: "test:run", title: "Run me", section: "Tests", run });
    await waitFor(() => expect(view.getByRole("button", { name: "Open palette" })).toBeTruthy());
    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.EXECUTE_COMMAND, { commandId: "test:run" })
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  for (const opener of ["Open palette", "Open actions"] as const) {
    test(`${opener}: keys typed right after the first open reach the palette`, async () => {
      const view = renderApp({ id: "test:pick", title: "Pick me", section: "Tests", run: mock() });
      const openerButton = view.getByRole("button", { name: opener });
      openerButton.focus();
      fireEvent.click(openerButton);
      // Keys go to whatever has focus, as they would right after the shortcut.
      await userEvent.setup({ document: view.container.ownerDocument }).keyboard("Pick");
      const input = await view.findByRole("combobox");
      const actionsMode = opener === "Open actions";
      expect((input as HTMLInputElement).value).toBe(actionsMode ? ">Pick" : "Pick");
      await waitFor(() => expect(document.activeElement).toBe(input));
      if (actionsMode) expect(await view.findByRole("option", { name: "Pick me" })).toBeTruthy();
      // Escape returns focus to where it was before the open (not to the loading input).
      fireEvent.keyDown(input, { key: "Escape" });
      await waitFor(() => expect(view.queryByRole("combobox") === null).toBe(true));
      expect(document.activeElement).toBe(openerButton);
    });
  }
});
