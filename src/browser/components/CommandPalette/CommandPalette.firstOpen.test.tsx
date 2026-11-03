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
function Harness(props: { actions: CommandAction[]; Palette: typeof AppCommandPalette }) {
  const registry = useCommandRegistry();
  const { registerSource } = registry;
  React.useEffect(() => registerSource(() => props.actions), [props.actions, registerSource]);
  return (
    <>
      <button type="button" onClick={() => registry.open()}>
        Open palette
      </button>
      <button type="button" onClick={() => registry.open(">")}>
        Open actions
      </button>
      <props.Palette />
    </>
  );
}

function renderApp(actions: CommandAction[], Palette = AppCommandPalette) {
  return render(
    <APIProvider client={createMockORPCClient()}>
      <CommandRegistryProvider>
        <Harness actions={actions} Palette={Palette} />
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
    const view = renderApp([{ id: "test:pick", title: "Pick me", section: "Tests", run: mock() }]);
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
    const view = renderApp([{ id: "test:run", title: "Run me", section: "Tests", run }]);
    await waitFor(() => expect(view.getByRole("button", { name: "Open palette" })).toBeTruthy());
    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.EXECUTE_COMMAND, { commandId: "test:run" })
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  for (const opener of ["Open palette", "Open actions"] as const) {
    test(`${opener}: keys typed right after the first open reach the palette`, async () => {
      const view = renderApp([
        { id: "test:pick", title: "Pick me", section: "Tests", run: mock() },
      ]);
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

  // React.lazy keeps the loaded module for the rest of the process, so each test below renders
  // its own copy of the lazy palette (a distinct specifier) to see the loading input again.
  function renderFreshApp(specifier: string, actions: CommandAction[]) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fresh = require(specifier) as { LazyCommandPalette: typeof AppCommandPalette };
    return renderApp(actions, fresh.LazyCommandPalette);
  }

  // No await before the caller's keys, so the chunk is still pending.
  function openActionsAndTypeWhileLoading(view: ReturnType<typeof renderApp>, query: string) {
    fireEvent.click(view.getByRole("button", { name: "Open actions" }));
    const loading = document.activeElement!;
    expect(loading.getAttribute("role")).not.toBe("combobox");
    fireEvent.change(loading, { target: { value: query } });
    return loading;
  }

  // Waits for the loaded palette, then past the zero-delay timer that runs a selected action.
  async function expectOpenWithNothingRun(view: ReturnType<typeof renderApp>, run: () => void) {
    expect(await view.findByRole("option", { name: "Pick me" })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run).not.toHaveBeenCalled();
    expect(view.getByRole("combobox")).toBeTruthy();
  }

  test("an Enter pressed while the chunk loads runs the first option once it arrives", async () => {
    const settings = mock();
    const pick = mock();
    const view = renderFreshApp("./LazyCommandPalette?enter=1", [
      // First for an empty query: the Enter must use the query typed before it.
      { id: "test:settings", title: "Open settings", section: "Tests", run: settings },
      { id: "test:pick", title: "Pick me", section: "Tests", run: pick },
    ]);
    const loading = openActionsAndTypeWhileLoading(view, ">Pick");
    fireEvent.keyDown(loading, { key: "Enter" });
    await waitFor(() => expect(pick).toHaveBeenCalledTimes(1));
    expect(view.queryByRole("combobox")).toBeNull();

    // The Enter belongs to the first open only: a later open runs nothing by itself.
    fireEvent.click(view.getByRole("button", { name: "Open actions" }));
    await expectOpenWithNothingRun(view, settings);
    expect(pick).toHaveBeenCalledTimes(1);
  });

  test("an Enter then Escape while the chunk loads runs nothing", async () => {
    const pick = mock();
    const view = renderFreshApp("./LazyCommandPalette?enter-escape=1", [
      { id: "test:pick", title: "Pick me", section: "Tests", run: pick },
    ]);
    const loading = openActionsAndTypeWhileLoading(view, ">Pick");
    fireEvent.keyDown(loading, { key: "Enter" });
    fireEvent.keyDown(loading, { key: "Escape" });
    // The next open loads the palette: the dismissed open's Enter must not run there.
    openActionsAndTypeWhileLoading(view, ">Pick");
    await expectOpenWithNothingRun(view, pick);
  });

  // Safari and older IMEs send the composition-commit Enter with isComposing false but keyCode
  // 229, and cmdk ignores both forms.
  for (const [tag, init] of [
    ["is-composing", { isComposing: true }],
    ["key-code-229", { isComposing: false, keyCode: 229 }],
  ] as const) {
    test(`an IME Enter (${tag}) while the chunk loads only commits the composition`, async () => {
      const pick = mock();
      const view = renderFreshApp(`./LazyCommandPalette?ime-enter=${tag}`, [
        { id: "test:pick", title: "Pick me", section: "Tests", run: pick },
      ]);
      const loading = openActionsAndTypeWhileLoading(view, ">Pick");
      fireEvent.keyDown(loading, { key: "Enter", ...init });
      await expectOpenWithNothingRun(view, pick);
    });
  }
});
