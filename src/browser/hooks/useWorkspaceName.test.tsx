import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import { restartLocalStorage } from "../../../tests/ui/quotaLimitedStorage";
import { APIProvider } from "@/browser/contexts/API";
import { createTestApiClient } from "@/browser/testUtils";
import { useWorkspaceName } from "./useWorkspaceName";

const generateMock = mock(() =>
  Promise.resolve({
    success: true as const,
    data: { name: "quotes-a1b2", title: "Quote heavy message", modelUsed: "test:model" },
  })
);
const api = createTestApiClient({ nameGeneration: { generate: generateMock } });

function Wrapper(props: { children: ReactNode }) {
  return <APIProvider client={api}>{props.children}</APIProvider>;
}

function renderWorkspaceName(message: string) {
  return renderHook(() => useWorkspaceName({ message, debounceMs: 1, scopeId: "draft-scope" }), {
    wrapper: Wrapper,
  });
}

describe("useWorkspaceName persisted draft state", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    generateMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  // An over-budget state lives only in memory, so after a restart the typed name would be gone.
  test("a very long manual name stays visible and restores as a flagged prefix after a restart", () => {
    const longName = "a".repeat(5000);
    const first = renderWorkspaceName("");
    act(() => first.result.current.setAutoGenerate(false));
    act(() => first.result.current.setName(longName));
    expect(first.result.current.name).toBe(longName);
    first.unmount();

    restartLocalStorage();
    const restored = renderWorkspaceName("");
    expect(restored.result.current.autoGenerate).toBe(false);
    expect(longName.startsWith(restored.result.current.name)).toBe(true);
    expect(restored.result.current.name.length).toBeGreaterThan(64);
    expect(restored.result.current.error?.kind).toBe("validation");

    act(() => restored.result.current.setName("my-feature"));
    restored.unmount();
    restartLocalStorage();
    const valid = renderWorkspaceName("");
    expect(valid.result.current.name).toBe("my-feature");
    expect(valid.result.current.error).toBeNull();
  });

  test("a name generated for an escape-heavy message survives a restart without regenerating", async () => {
    const message = '"'.repeat(1999);
    const first = renderWorkspaceName(message);
    await waitFor(() => expect(first.result.current.name).toBe("quotes-a1b2"));
    expect(generateMock).toHaveBeenCalledTimes(1);
    first.unmount();

    restartLocalStorage();
    const restored = renderWorkspaceName(message);
    expect(restored.result.current.name).toBe("quotes-a1b2");
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});
