import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { APIProvider } from "@/browser/contexts/API";
import { createKeptClientConnection } from "@/browser/contexts/connection.testHarness";
import { ConnectionLostError } from "@/browser/contexts/connectionLink";
import { createTestApiClient } from "@/browser/testUtils";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import type { DaytonaPublicConfig } from "@/common/orpc/schemas/daytona";
import { DaytonaSandboxForm } from "@/browser/features/Runtime/DaytonaControls";
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
      },
    });
    const wrapper = (props: { children: ReactNode }) =>
      createElement(APIProvider, { client } as ComponentProps<typeof APIProvider>, props.children);
    const { result } = renderHook(() => useDaytonaResources(), { wrapper });
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
  test("loads once the connection is live again after a load that failed while reconnecting", async () => {
    let live = false;
    const whenLive = <T>(value: T): Promise<T> =>
      live ? Promise.resolve(value) : Promise.reject(new ConnectionLostError());
    const client = createTestApiClient({
      daytona: {
        getConfig: () =>
          whenLive<DaytonaPublicConfig>({
            apiKeySet: true,
            apiKeySource: "settings",
            apiUrl: "https://app.daytona.io/api",
            target: null,
          }),
        listSnapshots: () => whenLive({ ok: true as const, snapshots: [{ name: "base" }] }),
      },
    });
    const connection = createKeptClientConnection(client);
    const { result } = renderHook(() => useDaytonaResources(), { wrapper: connection.Wrapper });
    // A reconnect gap is not a Daytona error: the form waits instead of reporting one.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.configError).toBeNull();

    live = true;
    connection.setStatus("connected");

    await waitFor(() => expect(result.current.snapshots).toEqual(["base"]));
    expect(result.current.config?.apiKeySet).toBe(true);
    expect(result.current.configError).toBeNull();
  });

  // Kept, the old account's config would keep the form ready with its snapshots.
  test("drops what the previous load found when a reload cannot read the config", async () => {
    let failing = false;
    const client = createTestApiClient({
      daytona: {
        getConfig: (): Promise<DaytonaPublicConfig> =>
          failing
            ? Promise.reject(new Error("backend unreachable"))
            : Promise.resolve({
                apiKeySet: true,
                apiKeySource: "settings",
                apiUrl: "https://app.daytona.io/api",
                target: null,
              }),
        listSnapshots: () => Promise.resolve({ ok: true as const, snapshots: [{ name: "base" }] }),
      },
    });
    const wrapper = (props: { children: ReactNode }) =>
      createElement(APIProvider, { client } as ComponentProps<typeof APIProvider>, props.children);
    const { result } = renderHook(() => useDaytonaResources(), { wrapper });
    await waitFor(() => expect(result.current.snapshots).toEqual(["base"]));

    failing = true;
    act(() => {
      window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.DAYTONA_CONFIG_CHANGED));
    });

    await waitFor(() => expect(result.current.configError).toBe("backend unreachable"));
    expect(result.current.config).toBeNull();
    expect(result.current.snapshots).toEqual([]);
    const form = render(
      createElement(DaytonaSandboxForm, {
        config: {},
        onConfigChange: () => undefined,
        resources: result.current,
      })
    );
    expect(form.getByRole("alert").textContent).toContain("backend unreachable");
    expect(form.queryByText("base")).toBeNull();
  });
});
