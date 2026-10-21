import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { APIProvider } from "@/browser/contexts/API";
import { createTestApiClient } from "@/browser/testUtils";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import type { DaytonaPublicConfig } from "@/common/orpc/schemas/daytona";
import { useDaytonaResources } from "./useDaytonaResources";

describe("useDaytonaResources", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    restoreDomGlobals();
  });

  test("reloads the config and snapshots when Daytona access is saved in Settings", async () => {
    let apiKeySet = false;
    const getConfig = mock(
      (): Promise<DaytonaPublicConfig> =>
        Promise.resolve({
          apiKeySet,
          apiKeySource: apiKeySet ? "settings" : null,
          apiUrl: "https://app.daytona.io/api",
          target: null,
        })
    );
    const client = createTestApiClient({
      daytona: {
        getConfig,
        listSnapshots: () => Promise.resolve({ ok: true as const, snapshots: [{ name: "base" }] }),
        listSandboxes: () => Promise.resolve({ ok: true as const, sandboxes: [] }),
      },
    });
    const wrapper = (props: { children: ReactNode }) =>
      createElement(APIProvider, { client } as ComponentProps<typeof APIProvider>, props.children);
    const { result } = renderHook(() => useDaytonaResources({ loadSandboxes: true }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.config?.apiKeySet).toBe(false));
    expect(result.current.snapshots).toEqual([]);

    // Settings covers the creation controls, which stay mounted while the key is saved.
    apiKeySet = true;
    act(() => {
      window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.DAYTONA_CONFIG_CHANGED));
    });

    await waitFor(() => expect(result.current.snapshots).toEqual(["base"]));
    expect(result.current.config?.apiKeySet).toBe(true);
  });
});
