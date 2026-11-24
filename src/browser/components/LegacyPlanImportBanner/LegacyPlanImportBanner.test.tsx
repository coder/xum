import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { APIProvider } from "@/browser/contexts/API";
import {
  CommandRegistryProvider,
  useCommandRegistry,
} from "@/browser/contexts/CommandRegistryContext";
import { createTestApiClient } from "@/browser/testUtils";
import { LegacyPlanImportNotice } from "./LegacyPlanImportBanner";

const workspaceId = "older-ssh-row";
const legacyPlanPath = "/home/dev/.mux/plans/project/twin.md";

type ImportResult =
  | {
      success: true;
      data: { status: "imported" | "already_present" | "nothing_to_import"; planPath: string };
    }
  | { success: false; error: string };

function renderNotice(result: Promise<ImportResult>) {
  const importLegacyPlan = mock((_input: { workspaceId: string }) => result);
  const onSettled = mock(() => undefined);
  let actions: () => Array<{ id: string; run: () => void | Promise<void> }> = () => [];
  const PaletteProbe = () => {
    actions = useCommandRegistry().getActions;
    return null;
  };
  const client = createTestApiClient({ workspace: { importLegacyPlan } });
  const tree = (showNotice: boolean) => (
    <APIProvider client={client}>
      <CommandRegistryProvider>
        <PaletteProbe />
        {showNotice && (
          <LegacyPlanImportNotice
            workspaceId={workspaceId}
            legacyPlanPath={legacyPlanPath}
            onSettled={onSettled}
          />
        )}
      </CommandRegistryProvider>
    </APIProvider>
  );
  const view = render(tree(true));
  const hideNotice = () => view.rerender(tree(false));
  return { view, hideNotice, importLegacyPlan, onSettled, paletteActions: () => actions() };
}

describe("LegacyPlanImportNotice (#5174)", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("one import at a time: the palette action during a pending click does not run another", async () => {
    let resolve!: (value: ImportResult) => void;
    const { view, importLegacyPlan, onSettled, paletteActions } = renderNotice(
      new Promise<ImportResult>((r) => (resolve = r))
    );

    fireEvent.click(view.getByRole("button", { name: "Import plan" }));
    const action = paletteActions().find((candidate) =>
      candidate.id.endsWith(":import-legacy-plan")
    );
    void action?.run();
    await act(async () => {
      resolve({ success: true, data: { status: "imported", planPath: "/scoped/twin.md" } });
      await Promise.resolve();
    });

    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(importLegacyPlan).toHaveBeenCalledTimes(1);
    expect(importLegacyPlan.mock.calls[0]?.[0]).toEqual({ workspaceId });
  });

  test("a refused import shows why and leaves the offer in place", async () => {
    const { view, onSettled } = renderNotice(
      Promise.resolve({ success: false, error: "Failed to import the plan: host unreachable" })
    );

    fireEvent.click(view.getByRole("button", { name: "Import plan" }));

    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toBe(
        "Failed to import the plan: host unreachable"
      )
    );
    expect(onSettled).not.toHaveBeenCalled();
  });

  // #5620: the shared file vanished after it was offered. Keeping the button and the palette
  // action would offer an import that can only fail again.
  test("an import that finds nothing settles the offer: the reason stays, the actions go", async () => {
    const { view, importLegacyPlan, paletteActions } = renderNotice(
      Promise.resolve({
        success: true,
        data: { status: "nothing_to_import", planPath: "/scoped/twin.md" },
      })
    );
    const hasPaletteAction = () =>
      paletteActions().some((candidate) => candidate.id.endsWith(":import-legacy-plan"));
    await waitFor(() => expect(hasPaletteAction()).toBe(true));

    fireEvent.click(view.getByRole("button", { name: "Import plan" }));

    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toBe(
        "The plan from an older Xum is no longer there."
      )
    );
    expect(view.queryByRole("button", { name: "Import plan" })).toBeNull();
    await waitFor(() => expect(hasPaletteAction()).toBe(false));
    expect(importLegacyPlan).toHaveBeenCalledTimes(1);
  });

  test("the command palette offers the same import while the row is shown", async () => {
    const { hideNotice, importLegacyPlan, onSettled, paletteActions } = renderNotice(
      Promise.resolve({
        success: true,
        data: { status: "imported", planPath: "/scoped/twin.md" },
      })
    );
    const action = await waitFor(() => {
      const found = paletteActions().find(
        (candidate) => candidate.id === `workspace:${workspaceId}:import-legacy-plan`
      );
      expect(found).toBeDefined();
      return found!;
    });

    await act(async () => {
      await action.run();
    });

    expect(importLegacyPlan).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    hideNotice();
    await waitFor(() =>
      expect(
        paletteActions().some((candidate) => candidate.id.endsWith(":import-legacy-plan"))
      ).toBe(false)
    );
  });
});
