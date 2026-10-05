import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ReactNode } from "react";

import { APIProvider } from "@/browser/contexts/API";
import { createTestApiClient } from "@/browser/testUtils";
import { CUSTOM_EVENTS, type CustomEventPayloads } from "@/common/constants/events";
import type { ComputerUseStatus } from "@/common/orpc/schemas/computerUse";

import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { useComputerUse } from "./useComputerUse";

type Toast = CustomEventPayloads[typeof CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST];

const status: ComputerUseStatus = {
  supported: true,
  platform: "linux",
  ownerWorkspaceId: "ws",
  stopShortcutRegistered: true,
  permissions: null,
};

const endedStream: AsyncIterable<ComputerUseStatus> = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined, done: true }) }),
};

describe("useComputerUse", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("toggle shows a failed request as an error toast", async () => {
    const setEnabled = mock(() => Promise.reject(new Error("Workspace ws not found.")));
    const client = createTestApiClient({
      computerUse: { subscribe: () => Promise.resolve(endedStream), setEnabled },
    });
    const toasts: Toast[] = [];
    window.addEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, (event) => {
      toasts.push((event as CustomEvent<Toast>).detail);
    });

    const { result } = renderHook(() => useComputerUse("ws"), {
      wrapper: (props: { children: ReactNode }) => (
        <APIProvider client={client}>{props.children}</APIProvider>
      ),
    });
    await act(() => result.current.toggle());
    expect(setEnabled).toHaveBeenCalledWith({ workspaceId: "ws", enabled: true });
    expect(toasts).toEqual([
      { type: "error", title: "Computer use", message: "Workspace ws not found." },
    ]);

    setEnabled.mockImplementation(() => Promise.resolve(status) as never);
    await act(() => result.current.toggle());
    expect(toasts).toHaveLength(1);
  });
});
