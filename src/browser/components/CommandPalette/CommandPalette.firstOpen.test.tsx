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
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
// The palette as App.tsx mounts it.
import { CommandPalette as AppCommandPalette } from "./CommandPalette";

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
      // Keys go to whatever has focus, as they would right after the shortcut. In the first test
      // of this file the palette chunk is cold, so they land in the loading input and across the
      // swap to the loaded palette (the lazy module stays loaded for the rest of the file).
      await userEvent.setup({ document: view.container.ownerDocument }).keyboard("Pick");
      const input = await view.findByRole("combobox");
      const actionsMode = opener === "Open actions";
      expect((input as HTMLInputElement).value).toBe(actionsMode ? ">Pick" : "Pick");
      await waitFor(() => expect(document.activeElement).toBe(input));
      if (actionsMode) expect(await view.findByRole("option", { name: "Pick me" })).toBeTruthy();
      // Escape returns focus to where it was before the open (not to the loading input).
      fireEvent.keyDown(input, { key: "Escape" });
      await waitFor(() => expect(view.queryByRole("combobox")).toBeNull());
      expect(document.activeElement).toBe(openerButton);
    });
  }
});
