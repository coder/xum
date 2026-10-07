import type { ReactNode } from "react";
import { wrapAsyncIterator } from "@orpc/shared";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { APIProvider } from "@/browser/contexts/API";
import { createTestApiClient } from "@/browser/testUtils";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";
import { useClaudeDesign } from "./useClaudeDesign";

let originalWindow: typeof globalThis.window;
let originalDocument: typeof globalThis.document;

describe("useClaudeDesign", () => {
  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("ignores Design updates older than the newest revision", async () => {
    const updates = createAsyncMessageQueue<{ enabled: boolean; revision: number }>();
    updates.push({ enabled: true, revision: 1 });
    const client = createTestApiClient({
      experiments: {
        onDesignChange: (_input, { signal } = {}) => {
          signal?.addEventListener("abort", updates.end, { once: true });
          return Promise.resolve(wrapAsyncIterator(updates.iterate(), {}));
        },
      },
    });
    const { result } = renderHook(() => useClaudeDesign(), {
      wrapper: (props: { children: ReactNode }) => (
        <APIProvider client={client}>{props.children}</APIProvider>
      ),
    });
    await waitFor(() => expect(result.current).toEqual({ enabled: true, revision: 1 }));

    await act(async () => {
      updates.push({ enabled: false, revision: 3 });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current).toEqual({ enabled: false, revision: 3 }));
    await act(async () => {
      updates.push({ enabled: true, revision: 2 });
      await Promise.resolve();
    });
    expect(result.current).toEqual({ enabled: false, revision: 3 });
  });
});
