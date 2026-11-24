import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { APIProvider } from "@/browser/contexts/API";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import {
  createControllableAsyncIterable,
  createTestApiClient,
  createTestConfig,
  resetTestExperiments,
} from "@/browser/testUtils";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { useExperiment } from "./useExperiments";

let originalWindow: typeof globalThis.window;
let originalDocument: typeof globalThis.document;

describe("useExperiment", () => {
  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
  });

  afterEach(() => {
    cleanup();
    getAppConfigStore().setClient(null);
    resetTestExperiments();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("a saved write shows the new value without a config change signal", async () => {
    const experimentId = EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING;
    let saved = false;
    const client = createTestApiClient({
      config: {
        getConfig: () =>
          Promise.resolve(createTestConfig({ experiments: { [experimentId]: saved } })),
        // Never delivers, like a dropped subscription.
        onConfigChanged: () => Promise.resolve(createControllableAsyncIterable<never>().iterable),
      },
      experiments: {
        set: (input) => {
          saved = input.enabled === true;
          return Promise.resolve();
        },
      },
    });
    getAppConfigStore().setClient(client);
    const { result } = renderHook(() => useExperiment(experimentId), {
      wrapper: (props: { children: ReactNode }) => (
        <APIProvider client={client}>{props.children}</APIProvider>
      ),
    });
    await waitFor(() =>
      expect(getAppConfigStore().getSnapshot()?.experiments).toEqual({ [experimentId]: false })
    );

    await act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});
