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

function slotNumbers(config: LayoutPresetsConfig): number[] {
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
        saveAll: () =>
          new Promise<void>((resolve, reject) => {
            saveAllCalls.push({ resolve, reject });
          }),
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
