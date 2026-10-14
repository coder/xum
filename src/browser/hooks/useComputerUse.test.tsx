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

  test("toggle lets the backend decide and shows a failed request as an error toast", async () => {
    const toggle = mock(() => Promise.reject(new Error("Workspace ws not found.")));
    const client = createTestApiClient({
      computerUse: { subscribe: () => Promise.resolve(endedStream), toggle },
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
    expect(toggle).toHaveBeenCalledWith({ workspaceId: "ws" });
    expect(toasts).toMatchObject([{ type: "error", message: "Workspace ws not found." }]);

    toggle.mockImplementation(() => Promise.resolve(status) as never);
    await act(() => result.current.toggle());
    expect(toasts).toHaveLength(1);
    expect(result.current.enabledHere).toBe(true);
  });
});
