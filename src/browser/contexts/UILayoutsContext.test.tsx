import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import {
  createControllableAsyncIterable,
  type ControllableAsyncIterable,
  type RecursivePartial,
} from "@/browser/testUtils";
import type { LayoutPresetsConfig, LayoutSlotNumber } from "@/common/types/uiLayouts";
import { UILayoutsProvider, useUILayouts } from "./UILayoutsContext";

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

// A slot with only a modifier keybind survives normalization, so fixtures stay small.
function presetsWithSlot(slot: LayoutSlotNumber): LayoutPresetsConfig {
  return { version: 2, slots: [{ slot, keybindOverride: { key: String(slot), ctrl: true } }] };
}

function slotNumbers(config: { slots: Array<{ slot: number }> }): number[] {
  return config.slots.map((slot) => slot.slot);
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("UILayoutsProvider", () => {
  let cleanupDom: (() => void) | null = null;
  let getAllCalls: Array<Deferred<LayoutPresetsConfig>> = [];
  let saveAllCalls: Array<Deferred<void>> = [];
  let saveAllInputs: Array<Parameters<APIClient["uiLayouts"]["saveAll"]>[0]["layoutPresets"]> = [];
  let configChanges: ControllableAsyncIterable<void>;
  let latest: ReturnType<typeof useUILayouts> | null = null;

  function Capture() {
    latest = useUILayouts();
    return null;
  }

  function current(): ReturnType<typeof useUILayouts> {
    if (!latest) throw new Error("UILayoutsProvider has not rendered");
    return latest;
  }

  function renderProvider() {
    const client: RecursivePartial<APIClient> = {
      uiLayouts: {
        getAll: () =>
          new Promise<LayoutPresetsConfig>((resolve, reject) => {
            getAllCalls.push({ resolve, reject });
          }),
        saveAll: (input) => {
          saveAllInputs.push(input.layoutPresets);
          return new Promise<void>((resolve, reject) => {
            saveAllCalls.push({ resolve, reject });
          });
        },
      },
      config: {
        onConfigChanged: (() =>
          Promise.resolve(
            configChanges.iterable
          )) as unknown as APIClient["config"]["onConfigChanged"],
      },
    };
    render(
      <APIProvider client={client as APIClient}>
        <UILayoutsProvider>
          <Capture />
        </UILayoutsProvider>
      </APIProvider>
    );
  }

  async function loadInitialPresets(slot: LayoutSlotNumber): Promise<void> {
    await waitFor(() => expect(getAllCalls.length).toBe(1));
    act(() => getAllCalls[0].resolve(presetsWithSlot(slot)));
    await waitFor(() => expect(slotNumbers(current().layoutPresets)).toEqual([slot]));
  }

  async function emitConfigChange(expectedGetAllCalls: number): Promise<void> {
    act(() => configChanges.push(undefined));
    await waitFor(() => expect(getAllCalls.length).toBe(expectedGetAllCalls));
  }

  beforeEach(() => {
    cleanupDom = installDom();
    getAllCalls = [];
    saveAllCalls = [];
    saveAllInputs = [];
    configChanges = createControllableAsyncIterable<void>();
    latest = null;
  });

  afterEach(() => {
    cleanup();
    configChanges.close();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("applies only the newest refresh when responses arrive out of order", async () => {
    renderProvider();
    await waitFor(() => expect(getAllCalls.length).toBe(1));

    // A config change arrives while the mount-time request is still pending.
    await emitConfigChange(2);
    act(() => getAllCalls[1].resolve(presetsWithSlot(2)));
    await waitFor(() => expect(slotNumbers(current().layoutPresets)).toEqual([2]));

    act(() => getAllCalls[0].resolve(presetsWithSlot(1)));
    await flushMicrotasks();
    expect(slotNumbers(current().layoutPresets)).toEqual([2]);
    expect(current().loaded).toBe(true);
  });

  test("a refresh that started before a save cannot reinstate the saved-over presets", async () => {
    renderProvider();
    await loadInitialPresets(1);
    await emitConfigChange(2);

    let savePromise: Promise<void> | undefined;
    act(() => {
      savePromise = current().saveAll(presetsWithSlot(2));
    });
    await waitFor(() => expect(saveAllCalls.length).toBe(1));
    act(() => saveAllCalls[0].resolve());
    await savePromise;
    await waitFor(() => expect(slotNumbers(current().layoutPresets)).toEqual([2]));

    act(() => getAllCalls[1].resolve(presetsWithSlot(1)));
    await flushMicrotasks();
    expect(slotNumbers(current().layoutPresets)).toEqual([2]);
  });

  test("a write re-reads presets when a refresh overtook its pre-write read", async () => {
    renderProvider();
    await loadInitialPresets(1);

    let writePromise: Promise<void> | undefined;
    act(() => {
      writePromise = current().setSlotKeybindOverride(3, { key: "3", ctrl: true });
    });
    await waitFor(() => expect(getAllCalls.length).toBe(2));

    // A restore lands while the pre-write read is in flight: the refresh installs the restored
    // presets first, then the older read answers with the pre-restore ones.
    await emitConfigChange(3);
    act(() => getAllCalls[2].resolve(presetsWithSlot(2)));
    await waitFor(() => expect(slotNumbers(current().layoutPresets)).toEqual([2]));
    act(() => getAllCalls[1].resolve(presetsWithSlot(1)));
    await flushMicrotasks();

    // The overtaken read is read again instead of becoming the write's base.
    expect(saveAllCalls.length).toBe(0);
    expect(getAllCalls.length).toBe(4);
    act(() => getAllCalls[3].resolve(presetsWithSlot(2)));
    await waitFor(() => expect(saveAllCalls.length).toBe(1));
    expect(slotNumbers(saveAllInputs[0])).toEqual([2, 3]);

    act(() => saveAllCalls[0].resolve());
    await writePromise;
    await waitFor(() => expect(slotNumbers(current().layoutPresets)).toEqual([2, 3]));
  });

  test("a write aborts once every pre-write read within the retry bound was overtaken", async () => {
    renderProvider();
    await loadInitialPresets(1);

    let writeOutcome: Promise<unknown> | undefined;
    act(() => {
      writeOutcome = current()
        .setSlotKeybindOverride(3, { key: "3", ctrl: true })
        .then(() => "saved", (error: unknown) => error);
    });
    // Every pre-write read is overtaken by a refresh before it answers, and each answers with
    // the pre-restore presets it was served from.
    for (let read = 1; read <= 3; read++) {
      const pending = 2 * read - 1;
      await waitFor(() => expect(getAllCalls.length).toBe(pending + 1));
      await emitConfigChange(pending + 2);
      act(() => getAllCalls[pending + 1].resolve(presetsWithSlot(2)));
      await waitFor(() => expect(slotNumbers(current().layoutPresets)).toEqual([2]));
      act(() => getAllCalls[pending].resolve(presetsWithSlot(1)));
    }

    // No read is known to reflect the restored presets, so nothing derived from one is saved.
    await flushMicrotasks();
    expect(saveAllCalls.length).toBe(0);
    const outcome = await writeOutcome;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("Layout presets changed while saving; try again");
    expect(getAllCalls.length).toBe(7);
    expect(slotNumbers(current().layoutPresets)).toEqual([2]);
  });

  test("keeps the loaded presets when a later refresh fails", async () => {
    renderProvider();
    await loadInitialPresets(1);

    await emitConfigChange(2);
    act(() => getAllCalls[1].reject(new Error("backend unavailable")));
    await waitFor(() => expect(current().loadFailed).toBe(true));
    expect(slotNumbers(current().layoutPresets)).toEqual([1]);
    expect(current().loaded).toBe(true);

    await emitConfigChange(3);
    act(() => getAllCalls[2].resolve(presetsWithSlot(3)));
    await waitFor(() => expect(slotNumbers(current().layoutPresets)).toEqual([3]));
    expect(current().loadFailed).toBe(false);
  });

  test("falls back to the empty default when the initial load fails", async () => {
    renderProvider();
    await waitFor(() => expect(getAllCalls.length).toBe(1));

    act(() => getAllCalls[0].reject(new Error("backend unavailable")));
    await waitFor(() => expect(current().loadFailed).toBe(true));
    expect(current().loaded).toBe(true);
    expect(current().layoutPresets.slots).toEqual([]);
  });
});
