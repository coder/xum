import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { CUSTOM_EVENTS, type CustomEventPayloads } from "@/common/constants/events";
import { useCopyToClipboard } from "./useCopyToClipboard";

type ToastPayload = CustomEventPayloads[typeof CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST];

describe("useCopyToClipboard (#5683)", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let toasts: ToastPayload[];

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    // The shared toast host (ChatInput) is mounted, as in a workspace view.
    const host = document.createElement("div");
    host.setAttribute("data-component", "ChatInputSection");
    document.body.appendChild(host);
    toasts = [];
    window.addEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, (event) => {
      toasts.push((event as CustomEvent<ToastPayload>).detail);
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("a rejected clipboard write shows an error toast and no copied state", async () => {
    const deny = () => Promise.reject(new Error("Write permission denied."));
    const { result } = renderHook(() => useCopyToClipboard(deny));

    await act(() => result.current.copyToClipboard("secret text"));

    expect(result.current.copied).toBe(false);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ type: "error", title: "Could not copy" });
    expect(toasts[0].message).toContain("Write permission denied.");
  });

  test("a successful write shows the copied state and no toast", async () => {
    const { result } = renderHook(() => useCopyToClipboard(() => Promise.resolve()));

    await act(() => result.current.copyToClipboard("text"));

    expect(result.current.copied).toBe(true);
    expect(toasts).toHaveLength(0);
  });
});
